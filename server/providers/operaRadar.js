import zlib from 'node:zlib';
import { readWindBody as readBytesCapped } from '../../src/sources/windBody.js';
import { readResponseTextCapped } from './common/http.js';
import { encodePng, paintCoverageEdge } from './smhiRadar.js';

/**
 * EUMETNET OPERA radar composite for the weather layer's European radar product.
 *
 * OPERA, EUMETNET's radar programme, composites some 150 European weather
 * radars every five minutes and publishes the result as open data (CC BY 4.0),
 * keyless, on a public bucket that keeps the last 24 hours. Each DBZH file is
 * a GeoTIFF: deflated float32 tiles of maximum reflectivity (dBZ) and a
 * quality index on a 3800×4400 grid of 1 km pixels in a Lambert azimuthal
 * equal-area projection centred on 55°N 10°E (WGS84). NaN marks "measured,
 * no echo"; the fill value marks pixels outside radar coverage.
 *
 * Frames are reduced on arrival to a 2 km grid (the SMHI Nordic product's
 * resolution) holding each 2×2 block's strongest echo, one byte per pixel.
 * Cesium drapes weather frames as latitude/longitude images, so every pixel of
 * a requested window takes the reduced pixel under its centre. Echoes are
 * coloured in the Nordic product's classes so the two compare at a glance.
 */

export const OPERA_BUCKET = 'https://s3.waw3-1.cloudferro.com/openradar-24h/';
/** The published full-resolution grid, checked against every file's tags. */
export const OPERA_GRID = Object.freeze({
  width: 3800,
  height: 4400,
  x0: -500,
  y0: 500,
  pixel: 1000,
});
/** The 2 km grid frames are reduced to. */
export const OPERA_REDUCED = Object.freeze({
  width: OPERA_GRID.width / 2,
  height: OPERA_GRID.height / 2,
  pixel: OPERA_GRID.pixel * 2,
});
/** A 2:1 latitude/longitude box over the radar coverage (measured ~27.6°W to
 * 35.5°E, 34.1°N to 72.8°N: Iceland to the Black Sea, Crete to North Cape). */
export const OPERA_RADAR_BOUNDS = Object.freeze({
  west: -30,
  south: 33,
  east: 50,
  north: 73,
});
/** Lowest bound of each colour class (dBZ), in the Nordic product's colours. */
export const OPERA_RADAR_LEGEND = Object.freeze(
  [
    [5, '#0032ff'],
    [12, '#008000'],
    [20, '#0ad00a'],
    [25, '#ffff0f'],
    [30, '#ffc800'],
    [35, '#ff2323'],
    [45, '#af00af'],
    ['55+', '#33ffff'],
  ].map(([label, color]) => Object.freeze({ label, color })),
);
const FRAME_STEP_MS = 5 * 60_000;
const FRAME_MAX_BYTES = 12 * 1024 * 1024;
const LISTING_MAX_BYTES = 1024 * 1024;
/** How far back a listing looks: the 13-frame hour plus publishing delay and
 * room for a client holding slightly older metadata. */
const LISTING_SPAN_MS = 3 * 3600_000;
const DAY_MS = 24 * 3600_000;

// --- Lambert azimuthal equal-area on the ellipsoid (Snyder 1987, §24) ---
const DEG = Math.PI / 180;
const WGS84_A = 6378137;
const WGS84_F = 1 / 298.257223563;

/**
 * A forward LAEA projection; OPERA's parameters by default.
 * @param {{lat0?: number, lon0?: number, falseEasting?: number, falseNorthing?: number}} [params]
 */
export function laeaProjection({
  lat0 = 55,
  lon0 = 10,
  falseEasting = 1_950_000,
  falseNorthing = -2_100_000,
} = {}) {
  const e2 = WGS84_F * (2 - WGS84_F);
  const e = Math.sqrt(e2);
  const q = (sinPhi) =>
    (1 - e2) *
    (sinPhi / (1 - e2 * sinPhi * sinPhi) -
      (1 / (2 * e)) * Math.log((1 - e * sinPhi) / (1 + e * sinPhi)));
  const qp = q(1);
  const sinPhi1 = Math.sin(lat0 * DEG);
  const beta1 = Math.asin(q(sinPhi1) / qp);
  const sinB1 = Math.sin(beta1);
  const cosB1 = Math.cos(beta1);
  const rq = WGS84_A * Math.sqrt(qp / 2);
  const m1 = Math.cos(lat0 * DEG) / Math.sqrt(1 - e2 * sinPhi1 * sinPhi1);
  const d = (WGS84_A * m1) / (rq * cosB1);
  /** sin and cos of the authalic latitude, per row of a window. */
  const authalic = (latDeg) => {
    const beta = Math.asin(
      Math.max(-1, Math.min(1, q(Math.sin(latDeg * DEG)) / qp)),
    );
    return [Math.sin(beta), Math.cos(beta)];
  };
  /** Project from precomputed authalic latitude and longitude terms. */
  const fromTerms = (sinB, cosB, sinL, cosL) => {
    const b = rq * Math.sqrt(2 / (1 + sinB1 * sinB + cosB1 * cosB * cosL));
    return [
      falseEasting + b * d * cosB * sinL,
      falseNorthing + (b / d) * (cosB1 * sinB - sinB1 * cosB * cosL),
    ];
  };
  return {
    authalic,
    fromTerms,
    lon0,
    /** Geodetic latitude/longitude (degrees) to [easting, northing]. */
    forward(lat, lon) {
      const [sinB, cosB] = authalic(lat);
      const l = (lon - lon0) * DEG;
      return fromTerms(sinB, cosB, Math.sin(l), Math.cos(l));
    },
  };
}

const OPERA_LAEA = laeaProjection();

/** OPERA grid coordinates [easting, northing] of a latitude/longitude. */
export function operaLaea(lat, lon) {
  return OPERA_LAEA.forward(lat, lon);
}

// --- GeoTIFF (little-endian classic TIFF, deflated float32 tiles) ---
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 7: 1, 11: 4, 12: 8 };

function readValue(view, type, at) {
  if (type === 3) return view.getUint16(at, true);
  if (type === 4) return view.getUint32(at, true);
  if (type === 11) return view.getFloat32(at, true);
  if (type === 12) return view.getFloat64(at, true);
  return view.getUint8(at);
}

/**
 * The image directories of a classic little-endian TIFF: tag → values, with
 * ASCII tags as strings.
 * @param {Uint8Array} bytes
 * @returns {Map<number, number[] | string>[]}
 */
export function readTiffDirectories(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.byteLength < 8 ||
    bytes[0] !== 0x49 ||
    bytes[1] !== 0x49 ||
    view.getUint16(2, true) !== 42
  )
    throw new Error('not a little-endian TIFF');
  const directories = [];
  for (
    let offset = view.getUint32(4, true);
    offset && directories.length < 8;
  ) {
    if (offset + 2 > bytes.byteLength) throw new Error('truncated TIFF');
    const count = view.getUint16(offset, true);
    if (offset + 6 + count * 12 > bytes.byteLength)
      throw new Error('truncated TIFF');
    const tags = new Map();
    for (let i = 0; i < count; i++) {
      const at = offset + 2 + i * 12;
      const tag = view.getUint16(at, true);
      const type = view.getUint16(at + 2, true);
      const n = view.getUint32(at + 4, true);
      const size = TYPE_SIZE[type];
      if (!size || n > 100_000) continue;
      const start = size * n <= 4 ? at + 8 : view.getUint32(at + 8, true);
      if (start + size * n > bytes.byteLength)
        throw new Error('truncated TIFF');
      if (type === 2) {
        tags.set(
          tag,
          Buffer.from(bytes.buffer, bytes.byteOffset + start, n)
            .toString('latin1')
            .replace(/\0+$/, ''),
        );
        continue;
      }
      const values = [];
      for (let k = 0; k < n; k++)
        values.push(readValue(view, type, start + k * size));
      tags.set(tag, values);
    }
    directories.push(tags);
    offset = view.getUint32(offset + 2 + count * 12, true);
  }
  return directories;
}

/** Reduced-frame byte codes. */
export const NO_COVERAGE = 0;
export const NO_ECHO = 1;
/** Echo codes 2–255 carry dBZ in half-dB steps from −32 dBZ. */
export function echoCode(dbz) {
  return 2 + Math.max(0, Math.min(253, Math.round((dbz + 32) * 2)));
}
export function codeDbz(code) {
  return (code - 2) / 2 - 32;
}

const near = (a, b) => Math.abs(a - b) < 1;

/**
 * Decode an OPERA DBZH GeoTIFF into the reduced 2 km grid: per 2×2 block the
 * strongest echo, else "no echo" if any pixel was measured, else no coverage.
 * The grid and projection are checked against OPERA_GRID and OPERA's LAEA.
 * @param {Uint8Array} bytes
 * @returns {{width: number, height: number, data: Uint8Array}}
 */
export function decodeOperaTiff(bytes) {
  const [tags] = readTiffDirectories(bytes);
  const one = (tag) =>
    Array.isArray(tags?.get(tag)) ? tags.get(tag)[0] : undefined;
  const width = one(256);
  const height = one(257);
  const tileWidth = one(322);
  const tileHeight = one(323);
  const samples = one(277);
  const scale = tags?.get(33550);
  const tie = tags?.get(33922);
  const geo = tags?.get(34736);
  const shapeOk =
    width === OPERA_GRID.width &&
    height === OPERA_GRID.height &&
    one(258) === 32 &&
    one(339) === 3 &&
    [8, 32946].includes(one(259)) &&
    (one(317) ?? 1) === 1 &&
    (one(284) ?? 1) === 1 &&
    samples >= 1 &&
    tileWidth > 0 &&
    tileHeight > 0;
  const placeOk =
    Array.isArray(scale) &&
    Array.isArray(tie) &&
    near(scale[0], OPERA_GRID.pixel) &&
    near(scale[1], OPERA_GRID.pixel) &&
    tie[0] === 0 &&
    tie[1] === 0 &&
    near(tie[3], OPERA_GRID.x0) &&
    near(tie[4], OPERA_GRID.y0);
  // GeoKey 3075 (ProjCoordTransGeoKey) 10 is Lambert azimuthal equal-area;
  // its centre, false easting and northing and the WGS84 semi-major axis sit
  // among the GeoTIFF double parameters.
  const keys = tags?.get(34735);
  let laea = false;
  for (let k = 4; Array.isArray(keys) && k + 3 < keys.length; k += 4)
    if (keys[k] === 3075) laea = keys[k + 1] === 0 && keys[k + 3] === 10;
  const description = tags?.get(42112);
  const projectionOk =
    laea &&
    Array.isArray(geo) &&
    [55, 10, 1_950_000, -2_100_000, 6378137].every((v) => geo.includes(v)) &&
    (typeof description !== 'string' ||
      /sample="0" role="description">DBZH</.test(description));
  if (!shapeOk || !placeOk || !projectionOk)
    throw new Error('OPERA grid changed');
  const offsets = tags.get(324);
  const counts = tags.get(325);
  const across = Math.ceil(width / tileWidth);
  const down = Math.ceil(height / tileHeight);
  if (offsets?.length !== across * down || counts?.length !== offsets.length)
    throw new Error('OPERA tiles missing');
  const { width: rw, height: rh } = OPERA_REDUCED;
  const data = new Uint8Array(rw * rh);
  const tileBytes = tileWidth * tileHeight * samples * 4;
  for (let t = 0; t < offsets.length; t++) {
    if (offsets[t] + counts[t] > bytes.byteLength)
      throw new Error('truncated TIFF');
    const raw = zlib.inflateSync(
      bytes.subarray(offsets[t], offsets[t] + counts[t]),
      { maxOutputLength: tileBytes },
    );
    if (raw.length !== tileBytes) throw new Error('bad OPERA tile');
    const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const col0 = (t % across) * tileWidth;
    const row0 = Math.floor(t / across) * tileHeight;
    for (let r = 0; r < tileHeight && row0 + r < height; r++) {
      const reducedRow = ((row0 + r) >> 1) * rw;
      for (let c = 0; c < tileWidth && col0 + c < width; c++) {
        const value = view.getFloat32((r * tileWidth + c) * samples * 4, true);
        let code;
        if (Number.isNaN(value)) code = NO_ECHO;
        else if (value < -1000)
          continue; // fill value: no coverage
        else code = echoCode(value);
        const p = reducedRow + ((col0 + c) >> 1);
        if (code > data[p]) data[p] = code;
      }
    }
  }
  return { width: rw, height: rh, data };
}

/**
 * For each pixel of a latitude/longitude window, the index of the reduced
 * OPERA pixel under its centre, or -1 outside the grid.
 * @param {[number, number, number, number]} bbox West, south, east, north.
 * @param {number} width
 * @param {number} height
 * @returns {Int32Array}
 */
export function operaWindowMapping([west, south, east, north], width, height) {
  const map = new Int32Array(width * height).fill(-1);
  const dLon = (east - west) / width;
  const dLat = (north - south) / height;
  const { width: gw, height: gh, pixel } = OPERA_REDUCED;
  const sinL = new Float64Array(width);
  const cosL = new Float64Array(width);
  for (let x = 0; x < width; x++) {
    const l = (west + (x + 0.5) * dLon - OPERA_LAEA.lon0) * DEG;
    sinL[x] = Math.sin(l);
    cosL[x] = Math.cos(l);
  }
  for (let y = 0; y < height; y++) {
    const [sinB, cosB] = OPERA_LAEA.authalic(north - (y + 0.5) * dLat);
    for (let x = 0; x < width; x++) {
      const [easting, northing] = OPERA_LAEA.fromTerms(
        sinB,
        cosB,
        sinL[x],
        cosL[x],
      );
      const col = Math.floor((easting - OPERA_GRID.x0) / pixel);
      const row = Math.floor((OPERA_GRID.y0 - northing) / pixel);
      if (col >= 0 && col < gw && row >= 0 && row < gh)
        map[y * width + x] = row * gw + col;
    }
  }
  return map;
}

/** Echo code → RGBA, by the legend's classes; codes below 5 dBZ stay clear. */
const PALETTE = (() => {
  const table = new Uint8Array(256 * 4);
  const classes = OPERA_RADAR_LEGEND.map(({ label, color }) => [
    Number.parseFloat(label),
    [1, 3, 5].map((i) => Number.parseInt(color.slice(i, i + 2), 16)),
  ]);
  for (let code = 2; code < 256; code++) {
    const dbz = codeDbz(code);
    const match = classes.findLast(([from]) => dbz >= from);
    if (match) table.set([...match[1], 255], code * 4);
  }
  return table;
})();

/**
 * Resample one reduced frame into a window: echoes of 5 dBZ and more in the
 * legend's colours, plus a thin line along the edge of radar coverage.
 * @param {{data: Uint8Array}} frame From decodeOperaTiff.
 * @param {Int32Array} mapping From operaWindowMapping.
 * @param {number} width
 * @param {number} height
 * @returns {Buffer} PNG bytes.
 */
export function renderOperaWindow(frame, mapping, width, height) {
  const out = new Uint8Array(width * height * 4);
  const covered = new Uint8Array(width * height);
  for (let p = 0; p < mapping.length; p++) {
    const source = mapping[p];
    if (source < 0) continue;
    const code = frame.data[source];
    if (code === NO_COVERAGE) continue;
    covered[p] = 1;
    if (PALETTE[code * 4 + 3])
      out.set(PALETTE.subarray(code * 4, code * 4 + 4), p * 4);
  }
  paintCoverageEdge(out, covered, width, height);
  return encodePng(width, height, out);
}

const pad = (value) => String(value).padStart(2, '0');
const dayPrefix = (d) =>
  `${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/OPERA/COMP/`;
const stamp = (d) =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;

/** The GeoTIFF URL of a frame, built from its time (never read from a listing). */
export function operaFrameUrl(time) {
  const d = new Date(time);
  return `${OPERA_BUCKET}${dayPrefix(d)}OPERA@${stamp(d)}@0@DBZH.tiff`;
}

/**
 * The bucket listing of one UTC day's composites from a time on.
 * @param {Date} day
 * @param {Date} from Only keys after this frame time's prefix.
 */
export function operaListingUrl(day, from) {
  const prefix = dayPrefix(day);
  const url = new URL(OPERA_BUCKET);
  url.search = new URLSearchParams({
    'list-type': '2',
    prefix,
    'start-after': `${prefix}OPERA@${stamp(from)}`,
  }).toString();
  return url.href;
}

/**
 * Frame times (ISO, ascending) a bucket listing offers as DBZH GeoTIFF.
 * @param {string} xml S3 ListObjectsV2 result.
 * @returns {string[]}
 */
export function operaListingTimes(xml) {
  const times = [];
  const key =
    /<Key>\d{4}\/\d{2}\/\d{2}\/OPERA\/COMP\/OPERA@(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})@0@DBZH\.tiff<\/Key>/g;
  for (const [, Y, M, D, h, m] of String(xml).matchAll(key))
    if (!(Number(m) % 5)) times.push(`${Y}-${M}-${D}T${h}:${m}:00.000Z`);
  return [...new Set(times)].sort();
}

/**
 * Metadata, frame and window access with bounded caches.
 * @param {{fetchImpl?: typeof fetch, now?: () => number}} [options]
 */
export function createOperaRadar({ fetchImpl = fetch, now = Date.now } = {}) {
  const frames = new Map();
  const mappings = new Map();

  const unavailable = (message) =>
    Object.assign(new Error(message), {
      code: 'weather_upstream_unavailable',
      status: 503,
    });

  async function listing(day, from, signal) {
    const response = await fetchImpl(operaListingUrl(day, from), {
      signal,
      redirect: 'error',
      headers: { Accept: 'application/xml' },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw unavailable(`OPERA HTTP ${response.status}`);
    }
    return operaListingTimes(
      await readResponseTextCapped(response, LISTING_MAX_BYTES, signal),
    );
  }

  async function metadata(signal) {
    const today = new Date(now());
    const from = new Date(now() - LISTING_SPAN_MS);
    const midnight = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()),
    );
    // Shortly after midnight UTC the span starts in yesterday's folder.
    const times = from < midnight ? await listing(from, from, signal) : [];
    times.push(
      ...(await listing(today, from < midnight ? midnight : from, signal)),
    );
    const limit = now() + FRAME_STEP_MS;
    const allowedTimes = [...new Set(times)]
      .filter((t) => {
        const at = Date.parse(t);
        return at <= limit && now() - at <= DAY_MS;
      })
      .sort();
    if (!allowedTimes.length) throw unavailable('no OPERA frames');
    return {
      bounds: { ...OPERA_RADAR_BOUNDS },
      times: allowedTimes.slice(-13),
      allowedTimes,
    };
  }

  async function frame(time, signal) {
    const cached = frames.get(time);
    if (cached) {
      frames.delete(time);
      frames.set(time, cached);
      return cached;
    }
    const response = await fetchImpl(operaFrameUrl(time), {
      signal,
      redirect: 'error',
      headers: { Accept: 'image/tiff' },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw unavailable('OPERA frame unavailable');
    }
    let decoded;
    try {
      decoded = decodeOperaTiff(
        await readBytesCapped(response, FRAME_MAX_BYTES, signal),
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      throw unavailable(error.message);
    }
    frames.set(time, decoded);
    // 4 MB per reduced frame: the 13-frame hour plus the next one.
    while (frames.size > 14) frames.delete(frames.keys().next().value);
    return decoded;
  }

  function mapping(bbox, width, height) {
    const key = `${bbox.join(',')}:${width}x${height}`;
    let map = mappings.get(key);
    if (map) {
      mappings.delete(key);
    } else {
      map = operaWindowMapping(bbox, width, height);
      // A 4096×2048 window maps 32 MB; keep only the few in use.
      while (mappings.size >= 4) mappings.delete(mappings.keys().next().value);
    }
    mappings.set(key, map);
    return map;
  }

  return {
    metadata,
    /** One window of one frame as PNG bytes. */
    async render(time, bbox, width, height, signal) {
      const decoded = await frame(time, signal);
      signal?.throwIfAborted();
      return renderOperaWindow(
        decoded,
        mapping(bbox, width, height),
        width,
        height,
      );
    },
  };
}

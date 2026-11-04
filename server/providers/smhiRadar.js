import zlib from 'node:zlib';
import { readWindBody as readBytesCapped } from '../../src/sources/windBody.js';
import { readResponseJsonCapped } from './common/http.js';

/**
 * SMHI (Sweden) radar composite for the weather layer's Nordic radar product.
 *
 * SMHI publishes the Nordic radar composite every five minutes as open data
 * (CC BY 4.0, credit SMHI), keyless. The PNG is SMHI's own coloured picture
 * on a 471×887 grid of ~2 km pixels in UTM zone 33N on GRS80 — SWEREF 99 TM —
 * read from the GeoTIFF tags of the published files. Cesium drapes weather
 * frames as latitude/longitude images, so each requested window is resampled
 * here: every output pixel's centre is projected to SWEREF 99 TM and takes the
 * nearest source pixel. Only coloured precipitation pixels survive; the
 * outside-coverage veil and the SMHI logo are grey or black and are dropped.
 */

export const SMHI_RADAR_BASE =
  'https://opendata-download-radar.smhi.se/api/version/latest/area/sweden/product/comp/';
export const SMHI_GRID = Object.freeze({
  width: 471,
  height: 887,
  x0: 126648.404,
  y0: 7771252.876,
  pixel: 2014.9581656050955,
});
/** A 2:1 latitude/longitude box around the grid (data spans ~5–31°E, 54–70°N). */
export const SMHI_RADAR_BOUNDS = Object.freeze({
  west: 3,
  south: 54,
  east: 35,
  north: 70,
});
/** SMHI's colour classes; dBZ from the GeoTIFF values with the ODIM 8-bit
 * encoding the composite uses (dBZ = 0.4 × value − 30). */
export const SMHI_RADAR_LEGEND = Object.freeze(
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
const FRAME_MAX_BYTES = 2 * 1024 * 1024;
const LISTING_MAX_BYTES = 2 * 1024 * 1024;
const DAY_MS = 24 * 3600_000;

// --- SWEREF 99 TM (Gauss conformal projection, Lantmäteriet's formulas) ---
const A = 6378137;
const F = 1 / 298.257222101;
const E2 = F * (2 - F);
const N = F / (2 - F);
const A_ROOF = (A / (1 + N)) * (1 + (N * N) / 4 + N ** 4 / 64);
const K0 = 0.9996;
const LON0 = (15 * Math.PI) / 180;
const FALSE_EASTING = 500000;
const CA = E2;
const CB = (5 * E2 ** 2 - E2 ** 3) / 6;
const CC = (104 * E2 ** 3 - 45 * E2 ** 4) / 120;
const CD = (1237 * E2 ** 4) / 1260;
const B1 = N / 2 - (2 * N * N) / 3 + (5 * N ** 3) / 16 + (41 * N ** 4) / 180;
const B2 = (13 * N * N) / 48 - (3 * N ** 3) / 5 + (557 * N ** 4) / 1440;
const B3 = (61 * N ** 3) / 240 - (103 * N ** 4) / 140;
const B4 = (49561 * N ** 4) / 161280;

/** Conformal latitude term φ* for a geodetic latitude in degrees. */
function conformalLatitude(latDeg) {
  const phi = (latDeg * Math.PI) / 180;
  const s2 = Math.sin(phi) ** 2;
  return (
    phi -
    Math.sin(phi) * Math.cos(phi) * (CA + CB * s2 + CC * s2 * s2 + CD * s2 ** 3)
  );
}

function projectFromConformal(phiStar, lonDeg) {
  const dLon = (lonDeg * Math.PI) / 180 - LON0;
  const xi = Math.atan(Math.tan(phiStar) / Math.cos(dLon));
  const eta = Math.atanh(Math.cos(phiStar) * Math.sin(dLon));
  const northing =
    K0 *
    A_ROOF *
    (xi +
      B1 * Math.sin(2 * xi) * Math.cosh(2 * eta) +
      B2 * Math.sin(4 * xi) * Math.cosh(4 * eta) +
      B3 * Math.sin(6 * xi) * Math.cosh(6 * eta) +
      B4 * Math.sin(8 * xi) * Math.cosh(8 * eta));
  const easting =
    K0 *
      A_ROOF *
      (eta +
        B1 * Math.cos(2 * xi) * Math.sinh(2 * eta) +
        B2 * Math.cos(4 * xi) * Math.sinh(4 * eta) +
        B3 * Math.cos(6 * xi) * Math.sinh(6 * eta) +
        B4 * Math.cos(8 * xi) * Math.sinh(8 * eta)) +
    FALSE_EASTING;
  return [easting, northing];
}

/**
 * Geodetic latitude/longitude (degrees) to SWEREF 99 TM [easting, northing].
 * @param {number} lat
 * @param {number} lon
 * @returns {[number, number]}
 */
export function sweref99tm(lat, lon) {
  return projectFromConformal(conformalLatitude(lat), lon);
}

// --- PNG (8-bit RGBA, non-interlaced: what SMHI publishes) ---
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

/**
 * Decode an 8-bit RGBA, non-interlaced PNG.
 * @param {Uint8Array} bytes
 * @returns {{width: number, height: number, data: Uint8Array}}
 */
export function decodePng(bytes) {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE))
    throw new Error('not a PNG');
  let width = 0;
  let height = 0;
  const parts = [];
  for (let at = 8; at + 8 <= buf.length;) {
    const length = buf.readUInt32BE(at);
    const type = buf.toString('latin1', at + 4, at + 8);
    const body = buf.subarray(at + 8, at + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0)
        throw new Error('unsupported PNG (want 8-bit RGBA, non-interlaced)');
    } else if (type === 'IDAT') parts.push(body);
    else if (type === 'IEND') break;
    at += 12 + length;
  }
  if (!width || !height || !parts.length) throw new Error('incomplete PNG');
  const raw = zlib.inflateSync(Buffer.concat(parts), {
    maxOutputLength: (width * 4 + 1) * height,
  });
  const stride = width * 4;
  if (raw.length !== (stride + 1) * height) throw new Error('truncated PNG');
  const data = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const out = y * stride;
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? data[out + x - 4] : 0;
      const up = y ? data[out + x - stride] : 0;
      const corner = x >= 4 && y ? data[out + x - stride - 4] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) {
        const p = left + up - corner;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - corner);
        predictor = pa <= pb && pa <= pc ? left : pb <= pc ? up : corner;
      } else if (filter !== 0) throw new Error('bad PNG filter');
      data[out + x] = (raw[src + x] + predictor) & 255;
    }
  }
  return { width, height, data };
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body, zlib.crc32(Buffer.from(type, 'latin1'))));
  return Buffer.concat([head, body, crc]);
}

/**
 * Encode RGBA pixels as a PNG (filter 0 rows).
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array} rgba
 * @returns {Buffer}
 */
export function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++)
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** Precipitation is coloured; the veil, the logo and its edges are grey. */
function isPrecipitation(data, i) {
  const r = data[i];
  const g = data[i + 1];
  const b = data[i + 2];
  return data[i + 3] >= 128 && Math.max(r, g, b) - Math.min(r, g, b) >= 40;
}

/**
 * For each pixel of a latitude/longitude window, the index of the SMHI grid
 * pixel under its centre, or -1 outside the grid.
 * @param {[number, number, number, number]} bbox West, south, east, north.
 * @param {number} width
 * @param {number} height
 * @returns {Int32Array}
 */
export function smhiWindowMapping([west, south, east, north], width, height) {
  const map = new Int32Array(width * height).fill(-1);
  const dLon = (east - west) / width;
  const dLat = (north - south) / height;
  const { width: gw, height: gh, x0, y0, pixel } = SMHI_GRID;
  for (let y = 0; y < height; y++) {
    const phiStar = conformalLatitude(north - (y + 0.5) * dLat);
    for (let x = 0; x < width; x++) {
      const [easting, northing] = projectFromConformal(
        phiStar,
        west + (x + 0.5) * dLon,
      );
      const col = Math.floor((easting - x0) / pixel);
      const row = Math.floor((y0 - northing) / pixel);
      if (col >= 0 && col < gw && row >= 0 && row < gh)
        map[y * width + x] = row * gw + col;
    }
  }
  return map;
}

/**
 * Resample one decoded frame into a window, keeping precipitation only.
 * @param {{data: Uint8Array}} frame Decoded SMHI frame.
 * @param {Int32Array} mapping From smhiWindowMapping.
 * @param {number} width
 * @param {number} height
 * @returns {Buffer} PNG bytes.
 */
export function renderSmhiWindow(frame, mapping, width, height) {
  const out = new Uint8Array(width * height * 4);
  for (let p = 0; p < mapping.length; p++) {
    const source = mapping[p];
    if (source < 0) continue;
    const i = source * 4;
    if (!isPrecipitation(frame.data, i)) continue;
    out[p * 4] = frame.data[i];
    out[p * 4 + 1] = frame.data[i + 1];
    out[p * 4 + 2] = frame.data[i + 2];
    out[p * 4 + 3] = 255;
  }
  return encodePng(width, height, out);
}

const pad = (value) => String(value).padStart(2, '0');

/** The PNG URL of a frame, built from its time (never read from a listing). */
export function smhiFrameUrl(time) {
  const d = new Date(time);
  const Y = d.getUTCFullYear();
  const M = pad(d.getUTCMonth() + 1);
  const D = pad(d.getUTCDate());
  const h = pad(d.getUTCHours());
  const m = pad(d.getUTCMinutes());
  return `${SMHI_RADAR_BASE}${Y}/${M}/${D}/radar_${String(Y).slice(2)}${M}${D}${h}${m}.png`;
}

/**
 * Frame times (ISO, ascending) a day listing offers as PNG.
 * @param {object} listing `…/comp/YYYY/MM/DD.json`
 * @returns {string[]}
 */
export function smhiListingTimes(listing) {
  const times = [];
  for (const file of Array.isArray(listing?.files) ? listing.files : []) {
    if (!/^radar_\d{10}$/.test(String(file?.key ?? ''))) continue;
    if (!file.formats?.some?.((format) => format?.key === 'png')) continue;
    const match = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/.exec(
      String(file.valid ?? ''),
    );
    if (!match || Number(match[3]) % 5) continue;
    times.push(`${match[1]}T${match[2]}:${match[3]}:00.000Z`);
  }
  return [...new Set(times)].sort();
}

/**
 * Metadata, frame and window access with bounded caches.
 * @param {{fetchImpl?: typeof fetch, now?: () => number}} [options]
 */
export function createSmhiRadar({ fetchImpl = fetch, now = Date.now } = {}) {
  const frames = new Map();
  const mappings = new Map();

  async function getJson(url, signal) {
    const response = await fetchImpl(url, {
      signal,
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw Object.assign(new Error(`SMHI HTTP ${response.status}`), {
        code: 'weather_upstream_unavailable',
        status: 503,
      });
    }
    return readResponseJsonCapped(response, LISTING_MAX_BYTES, signal);
  }

  async function metadata(signal) {
    const today = new Date(now());
    const dayUrl = (d) =>
      `${SMHI_RADAR_BASE}${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}.json`;
    let times = smhiListingTimes(await getJson(dayUrl(today), signal));
    // Just after midnight UTC the last hour sits in yesterday's listing.
    if (times.length < 13)
      times = [
        ...smhiListingTimes(
          await getJson(dayUrl(new Date(now() - DAY_MS)), signal),
        ),
        ...times,
      ];
    const limit = now() + FRAME_STEP_MS;
    const allowedTimes = [...new Set(times)]
      .filter((t) => {
        const at = Date.parse(t);
        return at <= limit && now() - at <= DAY_MS;
      })
      .sort();
    if (!allowedTimes.length)
      throw Object.assign(new Error('no SMHI frames'), {
        code: 'weather_upstream_unavailable',
        status: 503,
      });
    return {
      bounds: { ...SMHI_RADAR_BOUNDS },
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
    const response = await fetchImpl(smhiFrameUrl(time), {
      signal,
      redirect: 'error',
      headers: { Accept: 'image/png' },
    });
    if (
      !response.ok ||
      !/^image\/png(?:;|$)/i.test(response.headers.get('content-type') || '')
    ) {
      await response.body?.cancel();
      throw Object.assign(new Error('SMHI frame unavailable'), {
        code: 'weather_upstream_unavailable',
        status: 503,
      });
    }
    const decoded = decodePng(
      await readBytesCapped(response, FRAME_MAX_BYTES, signal),
    );
    if (
      decoded.width !== SMHI_GRID.width ||
      decoded.height !== SMHI_GRID.height
    )
      throw Object.assign(new Error('SMHI grid changed'), {
        code: 'weather_upstream_unavailable',
        status: 503,
      });
    frames.set(time, decoded);
    while (frames.size > 16) frames.delete(frames.keys().next().value);
    return decoded;
  }

  function mapping(bbox, width, height) {
    const key = `${bbox.join(',')}:${width}x${height}`;
    let map = mappings.get(key);
    if (map) {
      mappings.delete(key);
    } else {
      map = smhiWindowMapping(bbox, width, height);
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
      return renderSmhiWindow(
        decoded,
        mapping(bbox, width, height),
        width,
        height,
      );
    },
  };
}

import { StringDecoder } from 'node:string_decoder';
import zlib from 'node:zlib';
import { getTransitFeed } from '../../src/data/transitFeeds.js';
import {
  ROUTE_SHAPES_MAX_IDS,
  ROUTE_SHAPE_ID_PATTERN,
  ROUTE_SHAPE_MAX_POINTS,
  encodeRouteShape,
} from '../../src/data/transitRouteShapes.js';
import { clientKey, makeRateLimiter } from './common/rate-limit.js';
import { admitSameSite } from './common/same-site.js';

/**
 * Swedish fork: route shapes for the Trafiklab feeds, from each operator's
 * static GTFS `shapes.txt` (CC0 1.0), read in the same download as the route
 * join (trafiklabStatic.js), so they cost no static call of their own.
 *
 * Each shape is simplified (Douglas-Peucker, 2 m) and kept as an encoded
 * polyline at five decimals (src/data/transitRouteShapes.js); the Transit
 * layer draws a vehicle along its trip's shape between two position reports
 * where it may (src/layers/transit/routeShapes.js).
 *
 * Memory is bounded while reading: `shapes.txt` is inflated and parsed in
 * chunks of CHUNK_BYTES, only the shapes some trip names (by an id a request
 * can name) are kept, one shape's raw points at a time (a shape is finished
 * when the file moves on to the next; a shape whose rows come in two runs is
 * dropped), at most TRAFIKLAB_SHAPE_MAX_RAW_POINTS of them. What is kept
 * holds no chunk: each id is copied once, as its shape starts. A simplified
 * shape has at most ROUTE_SHAPE_MAX_POINTS points (the tolerance doubles, up
 * to 16 m, for one that has more), and an operator's shapes at most
 * TRAFIKLAB_SHAPES_MAX_BYTES of polyline text. A shape left out is drawn as
 * before: in straight lines.
 *
 * `GET /api/transit/shapes?feed=<feed id>&ids=<id>,<id>` answers from that
 * cache only: it never starts a download, which would spend the static key's
 * 50 calls a month for whoever asked.
 */

/** Douglas-Peucker tolerance (m): a shape stays within it of its points. */
export const TRAFIKLAB_SHAPE_TOLERANCE_M = 2;
/** The tolerance a shape with too many points may double to (m). */
export const TRAFIKLAB_SHAPE_MAX_TOLERANCE_M = 16;
/**
 * Raw points one shape may have while it is read. A dense 400 km coach line
 * at one point every 2 m is 200,000; a shape with more is dropped.
 */
export const TRAFIKLAB_SHAPE_MAX_RAW_POINTS = 200_000;
/**
 * Polyline text one operator's shapes may take (24 MiB). A simplified shape is
 * about 6 bytes a point, so this holds some 4 million points: SL's shapes are
 * expected to be a few MB. Shapes past it are left out.
 */
export const TRAFIKLAB_SHAPES_MAX_BYTES = 24 * 1024 * 1024;
/** Inflated `shapes.txt` beyond this is refused, as the static members are. */
export const TRAFIKLAB_SHAPES_MAX_FILE_BYTES = 512 * 1024 * 1024;
/** Text one `/api/transit/shapes` answer may carry; the rest is deferred. */
export const TRANSIT_SHAPES_MAX_RESPONSE_BYTES = 1024 * 1024;
/**
 * Point-to-segment measures one simplification may make before giving up
 * (a few tenths of a second). A road-like shape of 200,000 points takes some
 * 4 million; only a pathological one, where every split is lopsided, needs
 * more, and is left out.
 */
const SIMPLIFY_WORK_LIMIT = 20_000_000;
/** Inflated bytes handed to the parser at a time. */
const CHUNK_BYTES = 256 * 1024;
/**
 * The unfinished line carried from one chunk to the next may be at most this
 * long: a file without line breaks is refused, not gathered in memory. Only
 * the carry is measured: a longer line that lies within one chunk is parsed
 * like any other (a real shape row is some 40 characters).
 */
const MAX_LINE_CHARS = 4096;
const M_PER_DEG = 111_320;

/**
 * A string of its own, holding no part of the chunk it was cut from: V8
 * keeps a cut of 13 or more characters as a view into its parent, so an id
 * kept for good would keep a 256 KB chunk with it.
 * @param {string} text Printable ASCII.
 * @returns {string}
 */
function ownCopy(text) {
  return Buffer.from(text, 'latin1').toString('latin1');
}

/**
 * Douglas-Peucker: the indices of the points a polyline keeps so that every
 * point lies within `toleranceM` of it. Distances are to each kept segment,
 * not its line, so a shape that runs out and back keeps its turn.
 * @param {ArrayLike<number>} lat
 * @param {ArrayLike<number>} lon
 * @param {number} toleranceM
 * @param {number} [workLimit] Measures allowed before giving up.
 * @returns {number[]|null} Kept indices in order, or null past `workLimit`.
 */
export function simplifyShape(
  lat,
  lon,
  toleranceM,
  workLimit = SIMPLIFY_WORK_LIMIT,
) {
  const n = lat.length;
  if (n < 3) return Array.from({ length: n }, (_, i) => i);
  const kx = M_PER_DEG * Math.cos((lat[0] * Math.PI) / 180);
  const x = new Float64Array(n);
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = (lon[i] - lon[0]) * kx;
    y[i] = (lat[i] - lat[0]) * M_PER_DEG;
  }
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const limit = toleranceM * toleranceM;
  const stack = [0, n - 1];
  let work = 0;
  while (stack.length) {
    const last = stack.pop();
    const first = stack.pop();
    const dx = x[last] - x[first];
    const dy = y[last] - y[first];
    const length2 = dx * dx + dy * dy;
    let worst = -1;
    let worst2 = limit;
    for (let i = first + 1; i < last; i++) {
      let t =
        length2 > 0
          ? ((x[i] - x[first]) * dx + (y[i] - y[first]) * dy) / length2
          : 0;
      if (t < 0) t = 0;
      else if (t > 1) t = 1;
      const ex = x[first] + dx * t - x[i];
      const ey = y[first] + dy * t - y[i];
      const d2 = ex * ex + ey * ey;
      if (d2 > worst2) {
        worst2 = d2;
        worst = i;
      }
    }
    work += last - first;
    if (work > workLimit) return null;
    if (worst > 0) {
      keep[worst] = 1;
      stack.push(first, worst, worst, last);
    }
  }
  const kept = [];
  for (let i = 0; i < n; i++) if (keep[i]) kept.push(i);
  return kept;
}

/**
 * A shape's polyline: simplified at TRAFIKLAB_SHAPE_TOLERANCE_M, and at
 * twice that and so on up to TRAFIKLAB_SHAPE_MAX_TOLERANCE_M while it keeps
 * more than ROUTE_SHAPE_MAX_POINTS points.
 * @param {ArrayLike<number>} lat
 * @param {ArrayLike<number>} lon
 * @returns {string} '' when no tolerance makes it fit, or it is no line.
 */
export function shapeToPolyline(lat, lon) {
  for (
    let tolerance = TRAFIKLAB_SHAPE_TOLERANCE_M;
    tolerance <= TRAFIKLAB_SHAPE_MAX_TOLERANCE_M;
    tolerance *= 2
  ) {
    const kept = simplifyShape(lat, lon, tolerance);
    if (!kept) return '';
    if (kept.length > ROUTE_SHAPE_MAX_POINTS) continue;
    const coords = new Array(kept.length * 2);
    for (let k = 0; k < kept.length; k++) {
      coords[2 * k] = lat[kept[k]];
      coords[2 * k + 1] = lon[kept[k]];
    }
    return encodeRouteShape(coords);
  }
  return '';
}

/** One CSV line's fields, quoted ones with doubled quotes too. */
function splitLine(line) {
  if (!line.includes('"')) return line.split(',');
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (line[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      fields.push(field);
      field = '';
    } else field += ch;
  }
  fields.push(field);
  return fields;
}

/**
 * A `shapes.txt` reader fed text in chunks: `push(text)` as it is inflated,
 * then `end()` for the shapes, simplified and encoded (see the module
 * comment for its bounds).
 * @param {{wanted?: Set<string>|null, maxBytes?: number,
 *   maxRawPoints?: number}} [options]
 *   `wanted`: the shape ids to keep (those some trip names), or every one.
 * @returns {{push: (text: string) => void,
 *   end: () => {shapes: Map<string, string>, dropped: number, overBudget: number}}}
 */
export function createShapesReader({
  wanted = null,
  maxBytes = TRAFIKLAB_SHAPES_MAX_BYTES,
  maxRawPoints = TRAFIKLAB_SHAPE_MAX_RAW_POINTS,
} = {}) {
  const shapes = new Map();
  /** Shapes whose rows have ended, kept or not. */
  const finished = new Set();
  const dropped = new Set();
  let overBudget = 0;
  let bytes = 0;
  let col = null;
  let carry = '';
  let started = false;
  let current = null;

  function drop(id) {
    const encoded = shapes.get(id);
    if (encoded !== undefined) {
      bytes -= id.length + encoded.length;
      shapes.delete(id);
    }
    if (!dropped.has(id)) dropped.add(ownCopy(id));
  }

  function finish() {
    const shape = current;
    current = null;
    // An id no request could name is never kept.
    if (!shape || shape.unnamed) return;
    finished.add(shape.id);
    if (shape.overflow || shape.lat.length < 2) return drop(shape.id);
    let { lat, lon } = shape;
    if (!shape.ordered) {
      const order = shape.seq.map((_, i) => i);
      order.sort((a, b) => shape.seq[a] - shape.seq[b]);
      lat = order.map((i) => shape.lat[i]);
      lon = order.map((i) => shape.lon[i]);
    }
    const encoded = shapeToPolyline(lat, lon);
    if (!encoded) return drop(shape.id);
    if (bytes + shape.id.length + encoded.length > maxBytes) {
      overBudget += 1;
      return drop(shape.id);
    }
    bytes += shape.id.length + encoded.length;
    shapes.set(shape.id, encoded);
  }

  function line(text) {
    if (!text) return;
    const fields = splitLine(text);
    if (!col) {
      const header = fields.map((name) => name.trim());
      col = {
        id: header.indexOf('shape_id'),
        lat: header.indexOf('shape_pt_lat'),
        lon: header.indexOf('shape_pt_lon'),
        seq: header.indexOf('shape_pt_sequence'),
      };
      if (Object.values(col).some((index) => index < 0))
        throw new Error(
          'shapes.txt has no shape_id/shape_pt_lat/shape_pt_lon/shape_pt_sequence columns',
        );
      return;
    }
    const id = fields[col.id];
    if (!id || (wanted && !wanted.has(id))) return;
    if (current?.id !== id) {
      finish();
      // Its rows came before: the file is not grouped by shape, and a shape
      // put together from two runs could be wrong. Straight lines for it.
      if (finished.has(id)) return drop(id);
      current = {
        // Its own copy: the row's is a view into the whole chunk.
        id: ownCopy(id),
        lat: [],
        lon: [],
        seq: [],
        ordered: true,
        overflow: false,
        unnamed: !ROUTE_SHAPE_ID_PATTERN.test(id),
      };
    }
    if (current.overflow || current.unnamed) return;
    if (current.lat.length >= maxRawPoints) {
      current.overflow = true;
      current.lat = [];
      current.lon = [];
      current.seq = [];
      return;
    }
    const latText = fields[col.lat]?.trim();
    const lonText = fields[col.lon]?.trim();
    const seqText = fields[col.seq]?.trim();
    // An empty coordinate or sequence is missing, not zero.
    if (!latText || !lonText || !seqText) return;
    const lat = Number(latText);
    const lon = Number(lonText);
    const seq = Number(seqText);
    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      Math.abs(lat) > 90 ||
      Math.abs(lon) > 180 ||
      !Number.isFinite(seq)
    )
      return;
    const n = current.seq.length;
    if (n && seq < current.seq[n - 1]) current.ordered = false;
    current.lat.push(lat);
    current.lon.push(lon);
    current.seq.push(seq);
  }

  return {
    push(text) {
      if (!text) return;
      let chunk = carry + text;
      if (!started) {
        started = true;
        if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
      }
      let start = 0;
      for (
        let end = chunk.indexOf('\n');
        end !== -1;
        end = chunk.indexOf('\n', start)
      ) {
        line(
          chunk.slice(
            start,
            end > start && chunk.charCodeAt(end - 1) === 13 ? end - 1 : end,
          ),
        );
        start = end + 1;
      }
      carry = chunk.slice(start);
      if (carry.length > MAX_LINE_CHARS)
        throw new Error('shapes.txt has a line too long');
    },
    end() {
      line(carry.endsWith('\r') ? carry.slice(0, -1) : carry);
      carry = '';
      finish();
      return { shapes, dropped: dropped.size, overBudget };
    },
  };
}

/**
 * Read a `shapes.txt` ZIP member, inflating and parsing it in chunks.
 * @param {{method: number, data: Buffer}} member Its stored or deflated bytes.
 * @param {Set<string>|null} wanted Shape ids to keep.
 * @param {{maxBytes?: number, maxFileBytes?: number}} [options]
 * @returns {Promise<{shapes: Map<string, string>, dropped: number, overBudget: number}>}
 */
export async function readShapesMember(
  member,
  wanted,
  {
    maxBytes = TRAFIKLAB_SHAPES_MAX_BYTES,
    maxFileBytes = TRAFIKLAB_SHAPES_MAX_FILE_BYTES,
  } = {},
) {
  const reader = createShapesReader({ wanted, maxBytes });
  const decoder = new StringDecoder('utf8');
  if (member.method === 0) {
    if (member.data.length > maxFileBytes)
      throw new Error('shapes.txt is too large');
    for (let at = 0; at < member.data.length; at += CHUNK_BYTES)
      reader.push(decoder.write(member.data.subarray(at, at + CHUNK_BYTES)));
  } else if (member.method === 8) {
    await new Promise((resolve, reject) => {
      const inflate = zlib.createInflateRaw({ chunkSize: CHUNK_BYTES });
      let total = 0;
      inflate.on('data', (chunk) => {
        total += chunk.length;
        try {
          if (total > maxFileBytes) throw new Error('shapes.txt is too large');
          reader.push(decoder.write(chunk));
        } catch (error) {
          inflate.destroy(error);
        }
      });
      inflate.once('error', reject);
      inflate.once('end', resolve);
      inflate.end(member.data);
    });
  } else throw new Error(`unsupported zip method ${member.method}`);
  reader.push(decoder.end());
  return reader.end();
}

/**
 * Whether a request under the `/api/transit` mount asks for route shapes.
 * @param {string|undefined} requestUrl The URL after the mount.
 * @returns {boolean}
 */
export function isTransitShapesRequest(requestUrl) {
  try {
    const { pathname } = new URL(requestUrl || '/', 'http://localhost');
    return pathname === '/shapes' || pathname === '/shapes/';
  } catch {
    return false;
  }
}

/** The ids a shapes request names: 1..ROUTE_SHAPES_MAX_IDS valid ones, or null. */
function requestedShapeIds(value) {
  if (typeof value !== 'string' || !value || value.length > 4096) return null;
  const ids = [...new Set(value.split(','))];
  if (
    ids.length > ROUTE_SHAPES_MAX_IDS ||
    ids.some((id) => !ROUTE_SHAPE_ID_PATTERN.test(id))
  )
    return null;
  return ids;
}

/**
 * `GET /api/transit/shapes?feed=<feed id>&ids=<id>,<id>`: a Trafiklab feed's
 * route shapes, from the static GTFS cache only. Answers
 * `{version: 1, feedId, staticAt, shapes: {id: polyline}, missing, deferred}`:
 * `staticAt` is when the shapes were downloaded (null when none are cached),
 * `missing` the ids the cache does not hold, `deferred` those left for a later
 * request once the answer reached TRANSIT_SHAPES_MAX_RESPONSE_BYTES. A cache
 * that cannot be read just now answers 503, to be asked again in a minute.
 * Like the feeds' vehicles, it answers the app's own page only.
 * @param {{cachedShapes: (operator: string, ids: string[]) =>
 *   Promise<{staticAt: number|null, shapes: Map<string, string>}>,
 *   allow?: (key: string) => boolean, feedFor?: (id: string) => object|null}} options
 * @returns {(req: import('node:http').IncomingMessage,
 *   res: import('node:http').ServerResponse) => Promise<void>}
 */
export function createTransitShapesHandler({
  cachedShapes,
  allow = makeRateLimiter({ windowMs: 60_000, max: 120, globalMax: 600 }),
  feedFor = getTransitFeed,
}) {
  return async function serveTransitShapes(req, res) {
    const reply = (status, value, headers = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        ...headers,
      });
      res.end(JSON.stringify(value));
    };
    if (admitSameSite(req, res)) return;
    if (req.method !== 'GET')
      return reply(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
    let url;
    try {
      url = new URL(req.url || '/', 'http://localhost');
    } catch {
      return reply(400, { error: 'bad_request' });
    }
    const feed = feedFor(url.searchParams.get('feed') ?? '');
    if (!feed?.staticOperator) return reply(404, { error: 'unknown_feed' });
    const ids = requestedShapeIds(url.searchParams.get('ids'));
    if (!ids) return reply(400, { error: 'bad_ids' });
    if (!allow(clientKey(req)))
      return reply(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
    let found = null;
    try {
      found = await cachedShapes(feed.staticOperator, ids);
    } catch (error) {
      // A cache that could not be read just now is no shape missing: the
      // page asks again in a minute instead of giving the ids up for ten.
      console.warn(
        `[trafiklab-shapes] ${feed.staticOperator} shapes unread: ${error?.code || error?.message || error}`,
      );
      return reply(
        503,
        { error: 'shapes_unavailable' },
        { 'Retry-After': '60' },
      );
    }
    const shapes = [];
    const missing = [];
    const deferred = [];
    let bytes = 0;
    for (const id of ids) {
      const encoded = found?.shapes?.get(id);
      if (typeof encoded !== 'string') missing.push(id);
      else if (
        bytes + id.length + encoded.length >
        TRANSIT_SHAPES_MAX_RESPONSE_BYTES
      )
        deferred.push(id);
      else {
        bytes += id.length + encoded.length;
        shapes.push([id, encoded]);
      }
    }
    return reply(200, {
      version: 1,
      feedId: feed.id,
      staticAt: Number.isFinite(found?.staticAt) ? found.staticAt : null,
      // Own properties whatever the id ("__proto__" too).
      shapes: Object.fromEntries(shapes),
      missing,
      deferred,
    });
  };
}

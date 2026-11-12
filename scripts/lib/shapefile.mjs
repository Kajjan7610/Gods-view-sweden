/**
 * Just enough of ESRI's shapefile format for the snapshot builds: polygon
 * shapes from a .shp, attributes from a .dbf, both read out of a zip.
 * Node only; never part of the app.
 */

import { inflateRawSync } from 'node:zlib';

const MAX_ENTRY_BYTES = 256 * 1024 * 1024;

/**
 * The entries of a zip archive whose names end with one of `suffixes`, as
 * bytes (stored or deflated, no ZIP64).
 * @param {Uint8Array} bytes
 * @param {string[]} suffixes
 * @returns {Map<string, Uint8Array>} Entry name → bytes.
 */
export function zipEntries(bytes, suffixes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const out = new Map();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50)
      throw new Error('damaged zip directory');
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at +=
      46 +
      nameLength +
      view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true);
    if (!suffixes.some((suffix) => name.toLowerCase().endsWith(suffix)))
      continue;
    if (size > MAX_ENTRY_BYTES) throw new Error(`${name} is too large`);
    const start =
      local +
      30 +
      view.getUint16(local + 26, true) +
      view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + compressed);
    out.set(
      name,
      method === 0
        ? data
        : new Uint8Array(
            inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }),
          ),
    );
  }
  return out;
}

/** Twice the signed area of a ring: negative when it runs clockwise. */
function signedArea(ring) {
  let sum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
    sum += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  return sum;
}

function ringContains(ring, [x, y]) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)
      inside = !inside;
  }
  return inside;
}

/**
 * The polygon shapes of a .shp, in file order: each a list of polygons, each
 * a list of rings, outer ring first. Outer rings run clockwise, holes
 * counter-clockwise; a hole joins the outer ring that holds it.
 * @param {Uint8Array} bytes
 * @returns {(number[][][][]|null)[]} null for a null shape.
 */
export function readShpPolygons(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getInt32(0, false) !== 9994) throw new Error('not a shapefile');
  const shapes = [];
  let at = 100;
  while (at + 8 <= bytes.length) {
    const length = view.getInt32(at + 4, false) * 2;
    const record = at + 8;
    at = record + length;
    const type = view.getInt32(record, true);
    if (type === 0) {
      shapes.push(null);
      continue;
    }
    // Polygon, PolygonZ and PolygonM all start the same way.
    if (type !== 5 && type !== 15 && type !== 25)
      throw new Error(`shape type ${type} is not a polygon`);
    const parts = view.getInt32(record + 36, true);
    const points = view.getInt32(record + 40, true);
    const partStart = (i) => view.getInt32(record + 44 + i * 4, true);
    const pointsAt = record + 44 + parts * 4;
    const rings = [];
    for (let p = 0; p < parts; p++) {
      const from = partStart(p);
      const to = p + 1 < parts ? partStart(p + 1) : points;
      const ring = [];
      for (let i = from; i < to; i++)
        ring.push([
          view.getFloat64(pointsAt + i * 16, true),
          view.getFloat64(pointsAt + i * 16 + 8, true),
        ]);
      rings.push(ring);
    }
    const outers = rings.filter((ring) => signedArea(ring) < 0);
    const holes = rings.filter((ring) => signedArea(ring) >= 0);
    // A file that winds every ring the other way still has outer rings.
    const polygons = (outers.length ? outers : holes).map((ring) => [ring]);
    if (outers.length)
      for (const hole of holes) {
        const owner = polygons.find(([outer]) => ringContains(outer, hole[0]));
        if (owner) owner.push(hole);
      }
    shapes.push(polygons);
  }
  return shapes;
}

/**
 * The records of a .dbf as objects keyed by field name, deleted records
 * left out (their place kept as null so records line up with shapes).
 * @param {Uint8Array} bytes
 * @param {string} [encoding] From the .cpg; UTF-8 when absent.
 */
export function readDbf(bytes, encoding = 'utf-8') {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(4, true);
  const headerLength = view.getUint16(8, true);
  const recordLength = view.getUint16(10, true);
  const decoder = new TextDecoder(encoding);
  const fields = [];
  let offset = 1;
  for (let at = 32; at < headerLength - 1 && bytes[at] !== 0x0d; at += 32) {
    const name = decoder
      .decode(bytes.subarray(at, at + 11))
      .replace(/\0.*$/s, '')
      .trim();
    const length = bytes[at + 16];
    fields.push({ name, type: String.fromCharCode(bytes[at + 11]), offset, length });
    offset += length;
  }
  const records = [];
  for (let r = 0; r < count; r++) {
    const start = headerLength + r * recordLength;
    if (bytes[start] === 0x2a) {
      records.push(null);
      continue;
    }
    const record = {};
    for (const field of fields) {
      const text = decoder
        .decode(bytes.subarray(start + field.offset, start + field.offset + field.length))
        .trim();
      record[field.name] =
        field.type === 'N' || field.type === 'F'
          ? text === ''
            ? null
            : Number(text)
          : text;
    }
    records.push(record);
  }
  return records;
}

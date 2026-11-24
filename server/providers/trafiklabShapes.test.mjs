// Swedish fork: route shapes read from the Trafiklab static GTFS, simplified
// and served from the cache only (trafiklabShapes.js).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import v8 from 'node:v8';
import vm from 'node:vm';
import zlib from 'node:zlib';

import {
  TRANSIT_SHAPES_MAX_RESPONSE_BYTES,
  createShapesReader,
  createTransitShapesHandler,
  isTransitShapesRequest,
  readShapesMember,
  shapeToPolyline,
  simplifyShape,
} from './trafiklabShapes.js';
import { createTrafiklabStatic } from './trafiklabStatic.js';
import { transitProxy } from './transit.js';
import {
  ROUTE_SHAPE_MAX_POINTS,
  decodeRouteShape,
} from '../../src/data/transitRouteShapes.js';

const M_PER_DEG = 111_320;
const metres = (a, b) =>
  Math.hypot(
    (b[0] - a[0]) * M_PER_DEG,
    (b[1] - a[1]) * M_PER_DEG * Math.cos((a[0] * Math.PI) / 180),
  );

/** A street north 1.1 km, then east, sampled every `stepDeg`, with jitter. */
function lShape(stepDeg = 0.00002, jitterM = 0.5) {
  const lat = [];
  const lon = [];
  const wobble = (i) => (((i * 7919) % 11) / 10 - 0.5) * 2 * jitterM;
  for (let v = 59.3; v < 59.31; v += stepDeg) {
    lat.push(v);
    lon.push(18 + wobble(lat.length) / (M_PER_DEG * 0.51));
  }
  for (let v = 18; v <= 18.02 + 1e-12; v += stepDeg) {
    lat.push(59.31 + wobble(lat.length) / M_PER_DEG);
    lon.push(v);
  }
  return { lat, lon };
}

test('simplification keeps the corner and drops what lies within 2 m', () => {
  const { lat, lon } = lShape();
  assert.ok(lat.length > 1000);
  const kept = simplifyShape(lat, lon, 2);
  assert.ok(kept.length <= 4, `${kept.length} points kept`);
  assert.equal(kept[0], 0);
  assert.equal(kept.at(-1), lat.length - 1);
  assert.ok(
    kept.some((i) => metres([lat[i], lon[i]], [59.31, 18]) < 3),
    'the corner',
  );
  // A way out and back keeps its turn, though it lies on the line between.
  const outAndBack = simplifyShape([59.3, 59.31, 59.3], [18, 18, 18], 2);
  assert.deepEqual(outAndBack, [0, 1, 2]);
  assert.deepEqual(simplifyShape([59.3], [18], 2), [0]);
  // A shape that would take too long gives up.
  assert.equal(simplifyShape(lat, lon, 2, 10), null);
});

test('a polyline keeps the shape to the metre, coarser only when it must', () => {
  const { lat, lon } = lShape();
  const coords = decodeRouteShape(shapeToPolyline(lat, lon));
  assert.ok(coords.length >= 6 && coords.length <= 8);
  const points = [];
  for (let i = 0; i < coords.length; i += 2)
    points.push([coords[i], coords[i + 1]]);
  assert.ok(
    points.some((p) => metres(p, [59.31, 18]) < 3),
    'the corner',
  );
  // 4,500 points zig-zagging 3 m either side: too many at 2 m, two at 4 m.
  const zigLat = [];
  const zigLon = [];
  for (let i = 0; i < ROUTE_SHAPE_MAX_POINTS + 500; i++) {
    zigLat.push(59.3 + i * 0.00001);
    zigLon.push(18 + ((i % 2 ? 1 : -1) * 3) / (M_PER_DEG * 0.51));
  }
  assert.ok(simplifyShape(zigLat, zigLon, 2).length > ROUTE_SHAPE_MAX_POINTS);
  assert.equal(decodeRouteShape(shapeToPolyline(zigLat, zigLon)).length, 4);
  assert.equal(shapeToPolyline([59.3], [18]), '', 'one point is no line');
});

const SHAPES =
  '﻿shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence,shape_dist_traveled\r\n' +
  'L,59.30,18.00,1,0\r\n' +
  'L,59.305,18.00,2,556\r\n' +
  'L,59.31,18.00,3,1113\r\n' +
  'L,59.31,18.02,4,2249\r\n' +
  'UNUSED,59.40,18.10,1,0\r\n' +
  'UNUSED,59.41,18.10,2,1113\r\n' +
  '"Q""1",59.20,18.00,1,0\r\n' +
  '"Q""1",59.21,18.00,2,1113\r\n' +
  // An id no request can name (it holds the separator) is never kept.
  '"Q,2",59.20,18.10,1,0\r\n' +
  '"Q,2",59.21,18.10,2,1113\r\n' +
  'BACK,59.21,17.00,2,1113\r\n' +
  'BACK,59.20,17.00,1,0\r\n' +
  'BACK,59.22,17.00,3,2226\r\n' +
  'HOLE,59.10,17.00,1,0\r\n' +
  'HOLE,,17.00,2,\r\n' +
  'HOLE,59.105,17.10,,\r\n' +
  'HOLE,59.11,17.00,3,1113\r\n' +
  'SPLIT,59.00,16.00,1,0\r\n' +
  'L2,59.00,15.00,1,0\r\n' +
  'L2,59.01,15.00,2,1113\r\n' +
  'SPLIT,59.01,16.00,2,1113\r\n';
const WANTED = new Set(['L', 'Q"1', 'BACK', 'HOLE', 'SPLIT', 'L2']);

/** Feed `text` to a reader in pieces of `size`, cutting lines anywhere. */
function readInPieces(text, size, options) {
  const reader = createShapesReader(options);
  for (let i = 0; i < text.length; i += size)
    reader.push(text.slice(i, i + size));
  return reader.end();
}

test('shapes.txt is read in pieces: only the wanted shapes, grouped by shape', () => {
  for (const size of [1, 7, 64, SHAPES.length]) {
    const read = readInPieces(SHAPES, size, { wanted: WANTED });
    assert.deepEqual(
      [...read.shapes.keys()].sort(),
      ['BACK', 'HOLE', 'L', 'L2', 'Q"1'],
      `pieces of ${size}`,
    );
    // Rows in two runs: put together, it could be wrong; straight lines.
    assert.equal(read.shapes.has('SPLIT'), false);
    assert.ok(read.dropped >= 1);
    // The corner kept; the point on the straight run dropped.
    assert.deepEqual(
      decodeRouteShape(read.shapes.get('L')),
      [59.3, 18, 59.31, 18, 59.31, 18.02],
    );
    // Out of order by sequence: read in order.
    assert.deepEqual(
      decodeRouteShape(read.shapes.get('BACK')),
      [59.2, 17, 59.22, 17],
    );
    // An empty coordinate or sequence is a missing point, not zero.
    assert.deepEqual(
      decodeRouteShape(read.shapes.get('HOLE')),
      [59.1, 17, 59.11, 17],
    );
  }
  // Without a list, every shape a request could name is kept.
  const all = readInPieces(SHAPES, 100);
  assert.ok(all.shapes.has('UNUSED'));
  assert.equal(all.shapes.has('Q,2'), false, 'no id with a comma');
});

test('a shape past the raw-point or size bounds is left out', () => {
  const raw = readInPieces(SHAPES, 50, { wanted: WANTED, maxRawPoints: 3 });
  assert.equal(raw.shapes.has('L'), false, 'four points over three');
  assert.ok(raw.shapes.has('L2'));
  const small = readInPieces(SHAPES, 50, { wanted: WANTED, maxBytes: 30 });
  assert.ok(small.overBudget >= 1);
  const bytes = [...small.shapes].reduce(
    (sum, [id, text]) => sum + id.length + text.length,
    0,
  );
  assert.ok(bytes <= 30);
  assert.throws(
    () => readInPieces('trip_id,lat\n1,2\n', 50),
    /shapes\.txt has no shape_id/,
  );
  assert.throws(
    () =>
      readInPieces(
        `shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n${'a'.repeat(5000)}`,
        6000,
      ),
    /line too long/,
  );
});

test('a shapes.txt member is inflated in chunks, and an oversized one refused', async () => {
  const deflated = {
    method: 8,
    data: zlib.deflateRawSync(Buffer.from(SHAPES, 'utf8')),
  };
  const read = await readShapesMember(deflated, WANTED);
  assert.ok(read.shapes.has('L'));
  const stored = await readShapesMember(
    { method: 0, data: Buffer.from(SHAPES, 'utf8') },
    WANTED,
  );
  assert.deepEqual([...stored.shapes], [...read.shapes]);
  await assert.rejects(
    readShapesMember(deflated, WANTED, { maxFileBytes: 100 }),
    /too large/,
  );
  await assert.rejects(
    readShapesMember({ method: 12, data: Buffer.alloc(4) }, WANTED),
    /unsupported zip method 12/,
  );
});

test('the shapes kept hold no part of the file they were read from', async (t) => {
  // 500 shapes of 400 points with SL's 19-digit ids: some 8 MB of text.
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  const rows = ['shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n'];
  const wanted = new Set();
  for (let s = 0; s < 500; s++) {
    const id = String(1014010000478800000n + BigInt(s));
    wanted.add(id);
    let lat = 59.2 + (s % 50) * 0.003;
    let lon = 17.9 + Math.floor(s / 50) * 0.003;
    for (let p = 1; p <= 400; p++) {
      lat += 0.00002 * (p % 7 === 0 ? 4 : 1);
      lon += (0.00002 * ((p % 13) - 6)) / 6;
      rows.push(`${id},${lat.toFixed(6)},${lon.toFixed(6)},${p}\n`);
    }
  }
  const text = Buffer.from(rows.join(''));
  rows.length = 0;
  const member = { method: 8, data: zlib.deflateRawSync(text) };
  const heap = () => {
    gc();
    gc();
    return process.memoryUsage().heapUsed;
  };
  const before = heap();
  const read = await readShapesMember(member, wanted);
  const held = heap() - before;
  t.diagnostic(
    `${(held / 1048576).toFixed(1)} MB held after reading ${(text.length / 1048576).toFixed(1)} MB of shapes.txt`,
  );
  assert.equal(read.shapes.size, 500);
  let kept = 0;
  for (const [id, encoded] of read.shapes) kept += id.length + encoded.length;
  // What is kept, and its maps: not the text's 256 KB chunks.
  assert.ok(
    held < Math.max(4 * 1024 * 1024, 10 * kept),
    `${(held / 1048576).toFixed(1)} MB held for ${(kept / 1048576).toFixed(2)} MB of shapes, from ${(text.length / 1048576).toFixed(1)} MB of text`,
  );
});

test('only the shapes path under the transit mount is the shapes route', () => {
  assert.equal(isTransitShapesRequest('/shapes?feed=trafiklab-sl&ids=1'), true);
  assert.equal(isTransitShapesRequest('/shapes/'), true);
  assert.equal(isTransitShapesRequest('/x/../shapes?ids=1'), true);
  assert.equal(isTransitShapesRequest('/vehicles/trafiklab-sl'), false);
  assert.equal(isTransitShapesRequest('/shapes/sl'), false);
  assert.equal(isTransitShapesRequest(undefined), false);
});

const OWN = {
  host: 'localhost:4173',
  origin: 'http://localhost:4173',
  'sec-fetch-site': 'same-origin',
};
const FOREIGN = {
  host: 'localhost:4173',
  origin: 'https://example.com',
  'sec-fetch-site': 'cross-site',
};

function response() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    destroyed: false,
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
    writeHead(status, headers = {}) {
      this.statusCode = status;
      for (const [name, value] of Object.entries(headers))
        this.headers[name.toLowerCase()] = value;
    },
    end(body = '') {
      this.body = String(body);
    },
  };
}

async function ask(handler, url, { method = 'GET', headers = OWN } = {}) {
  const res = response();
  await handler({ method, url, headers, socket: {} }, res);
  return res;
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-trafiklab-shapes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('an empty cache answers no shapes and never downloads', async (t) => {
  let fetched = 0;
  const loader = createTrafiklabStatic({
    env: { TRAFIKLAB_GTFS_STATIC_KEY: 'secret-static-key' },
    fetchImpl: async () => {
      fetched += 1;
      return new Response('');
    },
    cacheDir: tempDir(t),
  });
  t.after(loader.close);
  const handler = createTransitShapesHandler({
    cachedShapes: loader.cachedShapes,
  });
  for (let i = 0; i < 3; i++) {
    const res = await ask(handler, '/shapes?feed=trafiklab-sl&ids=S1,S2');
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(JSON.parse(res.body), {
      version: 1,
      feedId: 'trafiklab-sl',
      staticAt: null,
      shapes: {},
      missing: ['S1', 'S2'],
      deferred: [],
    });
  }
  assert.equal(fetched, 0, 'Trafiklab is never asked');
});

test('the shapes route validates the feed and the ids, and caps them', async () => {
  const asked = [];
  const handler = createTransitShapesHandler({
    cachedShapes: async (operator, ids) => {
      asked.push([operator, ids]);
      return {
        staticAt: 1_000,
        shapes: new Map(ids.map((id) => [id, '_p~iF~ps|U_ulLnnqC'])),
      };
    },
  });
  const ok = await ask(handler, '/shapes?feed=trafiklab-otraf&ids=A,B,A');
  assert.equal(ok.statusCode, 200);
  const body = JSON.parse(ok.body);
  assert.deepEqual(Object.keys(body.shapes), ['A', 'B'], 'each id once');
  assert.equal(body.staticAt, 1_000);
  assert.deepEqual(asked.at(-1), ['otraf', ['A', 'B']]);
  // "__proto__" is an id like any other.
  const proto = JSON.parse(
    (await ask(handler, '/shapes?feed=trafiklab-sl&ids=__proto__')).body,
  );
  assert.equal(Object.hasOwn(proto.shapes, '__proto__'), true);

  const status = async (url, options) =>
    (await ask(handler, url, options)).statusCode;
  const before = asked.length;
  assert.equal(
    await status('/shapes?feed=trafiklab-sl&ids=A', { method: 'POST' }),
    405,
  );
  assert.equal(await status('/shapes?feed=nowhere&ids=A'), 404);
  // A feed without static GTFS has no shapes.
  assert.equal(await status('/shapes?feed=mbta&ids=A'), 404);
  assert.equal(await status('/shapes?feed=trafiklab-sl'), 400);
  assert.equal(await status('/shapes?feed=trafiklab-sl&ids='), 400);
  assert.equal(await status('/shapes?feed=trafiklab-sl&ids=a%20b'), 400);
  assert.equal(await status('/shapes?feed=trafiklab-sl&ids=A,,B'), 400);
  const many = Array.from({ length: 33 }, (_, i) => `S${i}`).join(',');
  assert.equal(await status(`/shapes?feed=trafiklab-sl&ids=${many}`), 400);
  assert.equal(
    await status(`/shapes?feed=trafiklab-sl&ids=${'x'.repeat(65)}`),
    400,
  );
  // Another site's page is refused before anything is read.
  assert.equal(
    await status('/shapes?feed=trafiklab-sl&ids=A', { headers: FOREIGN }),
    403,
  );
  assert.equal(asked.length, before, 'no refused request reads the cache');
});

test('an answer past its size cap defers the rest; a busy client is told to wait', async () => {
  const big = 'A'.repeat(400 * 1024);
  let allowed = true;
  const handler = createTransitShapesHandler({
    cachedShapes: async (_operator, ids) => ({
      staticAt: 5,
      shapes: new Map(ids.map((id) => [id, big])),
    }),
    allow: () => allowed,
  });
  const body = JSON.parse(
    (await ask(handler, '/shapes?feed=trafiklab-sl&ids=A,B,C,D')).body,
  );
  assert.deepEqual(Object.keys(body.shapes), ['A', 'B']);
  assert.deepEqual(body.deferred, ['C', 'D']);
  assert.ok(2 * big.length <= TRANSIT_SHAPES_MAX_RESPONSE_BYTES);
  allowed = false;
  const busy = await ask(handler, '/shapes?feed=trafiklab-sl&ids=A');
  assert.equal(busy.statusCode, 429);
  assert.equal(busy.headers['retry-after'], '60');
});

test('a cache that cannot be read just now is unavailable, not missing', async (t) => {
  const lines = [];
  t.mock.method(console, 'warn', (...args) => lines.push(args.join(' ')));
  const handler = createTransitShapesHandler({
    cachedShapes: async () => {
      throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' });
    },
  });
  const res = await ask(handler, '/shapes?feed=trafiklab-sl&ids=A');
  // Not "missing": the page would give the ids up for ten minutes.
  assert.equal(res.statusCode, 503);
  assert.equal(res.headers['retry-after'], '60');
  assert.deepEqual(JSON.parse(res.body), { error: 'shapes_unavailable' });
  assert.ok(lines.some((line) => line.includes('EACCES')));
});

test('a shapes file that cannot be read is asked for again, not taken for none', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const cacheDir = tempDir(t);
  // A file that cannot be read: a folder where it should be.
  fs.mkdirSync(path.join(cacheDir, 'shapes-sl.json'), { recursive: true });
  const loader = createTrafiklabStatic({
    env: {},
    fetchImpl: async () => {
      throw new Error('no download in this test');
    },
    cacheDir,
  });
  t.after(loader.close);
  const handler = createTransitShapesHandler({
    cachedShapes: loader.cachedShapes,
  });
  const first = await ask(handler, '/shapes?feed=trafiklab-sl&ids=S1');
  assert.equal(first.statusCode, 503);
  // Readable a moment later: served at once, with no wait of minutes.
  fs.rmSync(path.join(cacheDir, 'shapes-sl.json'), { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, 'shapes-sl.json'),
    JSON.stringify({
      version: 1,
      operator: 'sl',
      fetchedAt: 42,
      shapes: { S1: '_p~iF~ps|U_ulLnnqC' },
    }),
  );
  const second = await ask(handler, '/shapes?feed=trafiklab-sl&ids=S1');
  assert.equal(second.statusCode, 200);
  assert.deepEqual(JSON.parse(second.body).shapes, {
    S1: '_p~iF~ps|U_ulLnnqC',
  });
});

test('the transit mount answers shapes from the cache, never from an operator', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('no network in this test');
  });
  let asked = 0;
  let read = 0;
  const plugin = transitProxy({
    fetchImpl: async () => {
      asked += 1;
      return new Response('{}', { status: 500 });
    },
    env: { TRAFIKLAB_GTFS_RT_KEY: 'shapes-mount-key' },
    enrichVehicles: (_feed, vehicles) => vehicles,
    cachedShapes: async (operator, ids) => {
      read += 1;
      return { staticAt: 7, shapes: new Map([[ids[0], `${operator}-shape`]]) };
    },
  });
  t.after(() => plugin.closeBundle());
  let handler = null;
  plugin.configureServer({
    middlewares: { use: (_path, fn) => (handler = fn) },
  });
  const own = await ask(handler, '/shapes?feed=trafiklab-sl&ids=S1');
  assert.equal(own.statusCode, 200);
  assert.deepEqual(JSON.parse(own.body).shapes, { S1: 'sl-shape' });
  const foreign = await ask(handler, '/shapes?feed=trafiklab-sl&ids=S1', {
    headers: FOREIGN,
  });
  assert.equal(foreign.statusCode, 403);
  assert.equal(read, 1);
  assert.equal(asked, 0, 'no operator is asked for shapes');
  assert.equal(own.body.includes('shapes-mount-key'), false);
});

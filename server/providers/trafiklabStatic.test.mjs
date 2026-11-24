import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';

import {
  TRAFIKLAB_STATIC_MAX_AGE_MS,
  TRAFIKLAB_STATIC_RETRY_MS,
  buildTripRouteIndex,
  createTrafiklabStatic,
  gtfsRouteMode,
  parseCsv,
  readZipMembers,
} from './trafiklabStatic.js';
import {
  getTransitFeed,
  transitRouteLabel,
  transitModeFor,
} from '../../src/data/transitFeeds.js';
import { decodeRouteShape } from '../../src/data/transitRouteShapes.js';
import { TRAFIKLAB_ALERT_OPERATORS } from './transitAlerts.js';

/** A minimal ZIP writer: `deflate` members are compressed, others stored. */
function makeZip(members) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, text, deflate } of members) {
    const raw = Buffer.from(text, 'utf8');
    const data = deflate ? zlib.deflateRawSync(raw) : raw;
    const nameBytes = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(deflate ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const ROUTES =
  '﻿route_id,agency_id,route_short_name,route_long_name,route_type\r\n' +
  'R4,SL,4,,700\r\n' +
  'R7,SL,7,"Spårväg City, Djurgården",900\r\n' +
  'RT,SL,,Tunnelbanans gröna linje,401\r\n' +
  'RF,SL,80,,1000\r\n';
const TRIPS =
  'route_id,service_id,trip_id\n' +
  'R4,1,T-4-a\n' +
  'R7,1,T-7-a\n' +
  'RT,1,T-green\n' +
  'RF,1,T-ferry\n' +
  'MISSING,1,T-orphan\n';

test('GTFS basic and extended route types map to layer modes', () => {
  assert.equal(gtfsRouteMode(3), 'bus');
  assert.equal(gtfsRouteMode('700'), 'bus');
  assert.equal(gtfsRouteMode(900), 'tram');
  assert.equal(gtfsRouteMode(401), 'subway');
  assert.equal(gtfsRouteMode(109), 'rail');
  assert.equal(gtfsRouteMode(1000), 'ferry');
  assert.equal(gtfsRouteMode(1500), null);
  assert.equal(gtfsRouteMode(''), null);
});

test('CSV parsing handles a BOM, CRLF and quoted commas', () => {
  const rows = [];
  const header = parseCsv(ROUTES, (fields) => rows.push(fields));
  assert.equal(header[0], 'route_id');
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[1], [
    'R7',
    'SL',
    '7',
    'Spårväg City, Djurgården',
    '900',
  ]);
});

test('ZIP members are read whether stored or deflated, in any folder', () => {
  const zip = makeZip([
    { name: 'agency.txt', text: 'ignored' },
    { name: 'sl/routes.txt', text: ROUTES, deflate: true },
    { name: 'trips.txt', text: TRIPS },
  ]);
  const members = readZipMembers(zip, ['routes.txt', 'trips.txt']);
  assert.equal(members.get('routes.txt').toString('utf8'), ROUTES);
  assert.equal(members.get('trips.txt').toString('utf8'), TRIPS);
  assert.throws(() => readZipMembers(Buffer.from('nope'), ['x']), /not a zip/);
});

test('trips join to `<mode>:<short name>` routes, long name as fallback', () => {
  const trips = buildTripRouteIndex(ROUTES, TRIPS);
  assert.equal(trips.get('T-4-a'), 'bus:4');
  assert.equal(trips.get('T-7-a'), 'tram:7');
  assert.equal(trips.get('T-green'), 'subway:Tunnelbanans gröna linje');
  assert.equal(trips.get('T-ferry'), 'ferry:80');
  assert.equal(trips.has('T-orphan'), false);
});

test('the registry hooks read the joined route back', () => {
  const sl = getTransitFeed('trafiklab-sl');
  assert.equal(transitModeFor(sl, 'tram:7'), 'tram');
  assert.equal(transitRouteLabel(sl, 'tram:7'), '7');
  // An unjoined id falls back to the feed default and stays as sent.
  assert.equal(transitModeFor(sl, '9011001000400000'), 'bus');
  assert.equal(transitRouteLabel(sl, '9011001000400000'), '9011001000400000');
});

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-trafiklab-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the static join downloads once, enriches vehicles and caches on disk', async (t) => {
  t.mock.method(console, 'log', () => {});
  const cacheDir = tempDir(t);
  const zip = makeZip([
    { name: 'routes.txt', text: ROUTES, deflate: true },
    { name: 'trips.txt', text: TRIPS, deflate: true },
  ]);
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    return new Response(zip);
  };
  const feed = getTransitFeed('trafiklab-sl');
  const vehicles = [
    { id: 'v1', tripId: 'T-7-a', routeId: null },
    { id: 'v2', tripId: 'unknown', routeId: null },
  ];
  const first = createTrafiklabStatic({
    env: { TRAFIKLAB_GTFS_STATIC_KEY: 'static-key' },
    fetchImpl,
    cacheDir,
  });
  t.after(first.close);
  // Before the join is ready, vehicles pass through untouched.
  assert.deepEqual(first.enrichVehicles(feed, vehicles), vehicles);
  await first.ready('sl');
  const enriched = first.enrichVehicles(feed, vehicles);
  assert.equal(enriched[0].routeId, 'tram:7');
  assert.equal(enriched[1].routeId, null);
  assert.equal(requested.length, 1);
  assert.match(
    requested[0],
    /^https:\/\/opendata\.samtrafiken\.se\/gtfs\/sl\/sl\.zip\?key=static-key$/,
  );
  assert.ok(fs.existsSync(path.join(cacheDir, 'static-sl.json')));

  // A second process reads the week-old-at-most cache instead of downloading.
  const second = createTrafiklabStatic({
    env: { TRAFIKLAB_GTFS_STATIC_KEY: 'static-key' },
    fetchImpl,
    cacheDir,
  });
  t.after(second.close);
  await second.ready('sl');
  assert.equal(second.enrichVehicles(feed, vehicles)[0].routeId, 'tram:7');
  assert.equal(requested.length, 1);
});

test('without a static key nothing is fetched and vehicles pass through', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  const helper = createTrafiklabStatic({
    env: {},
    fetchImpl: async () => {
      calls++;
      return new Response('');
    },
    cacheDir: tempDir(t),
  });
  t.after(helper.close);
  const feed = getTransitFeed('trafiklab-skane');
  const vehicles = [{ id: 'v', tripId: 'T', routeId: null }];
  helper.enrichVehicles(feed, vehicles);
  await helper.ready('skane');
  assert.deepEqual(helper.enrichVehicles(feed, vehicles), vehicles);
  assert.equal(calls, 0);
});

test('a failed download waits six hours and never logs the key', async (t) => {
  const lines = [];
  t.mock.method(console, 'warn', (...args) => lines.push(args.join(' ')));
  let clock = 1_000_000;
  let calls = 0;
  const helper = createTrafiklabStatic({
    env: { TRAFIKLAB_GTFS_STATIC_KEY: 'secret-static-key' },
    fetchImpl: async () => {
      calls++;
      return new Response('quota', { status: 429 });
    },
    cacheDir: tempDir(t),
    now: () => clock,
  });
  t.after(helper.close);
  await helper.ready('ul');
  assert.equal(calls, 1);
  await helper.ready('ul');
  assert.equal(calls, 1, 'no retry inside the window');
  clock += TRAFIKLAB_STATIC_RETRY_MS + 1;
  await helper.ready('ul');
  assert.equal(calls, 2);
  assert.ok(lines.some((line) => /HTTP 429/.test(line)));
  assert.equal(
    lines.some((line) => line.includes('secret-static-key')),
    false,
  );
});

const STOPS =
  'stop_id,stop_name,stop_lat,stop_lon,location_type,parent_station\n' +
  'A,Hagaskolan,58.599512,16.161094,1,\n' +
  'A1,Hagaskolan,58.5996,16.1612,0,A\n' +
  'BAD,Utan läge,,16,0,\n';

test('stops are kept from the same download, asked for once, one at a time', async (t) => {
  t.mock.method(console, 'log', () => {});
  const cacheDir = tempDir(t);
  const zip = makeZip([
    { name: 'routes.txt', text: ROUTES },
    { name: 'trips.txt', text: TRIPS },
    { name: 'stops.txt', text: STOPS, deflate: true },
  ]);
  let open = 0;
  let most = 0;
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    open += 1;
    most = Math.max(most, open);
    await new Promise((resolve) => setTimeout(resolve, 5));
    open -= 1;
    return new Response(zip);
  };
  const loader = createTrafiklabStatic({
    env: { TRAFIKLAB_GTFS_STATIC_KEY: 'static-key' },
    fetchImpl,
    cacheDir,
  });
  t.after(loader.close);
  assert.equal(loader.stopsFor('sl'), null, 'not on hand yet');
  assert.equal(loader.stopsFor('ul'), null);
  await Promise.all([loader.ready('sl'), loader.ready('ul')]);
  assert.equal(most, 1, 'downloads never overlap');
  const stops = loader.stopsFor('sl');
  assert.deepEqual(stops.get('A1'), [16.1612, 58.5996, 'Hagaskolan', 'A']);
  assert.deepEqual(stops.get('A'), [16.16109, 58.59951, 'Hagaskolan', '']);
  assert.equal(stops.has('BAD'), false);
  assert.ok(fs.existsSync(path.join(cacheDir, 'stops-sl.json')));
  assert.equal(requested.length, 2);
});

test("renewing every operator's stops fits the Bronze key's 50 downloads a month", () => {
  // A month of 31 days asks each operator at most this many times.
  const perOperator = Math.ceil(
    (31 * 24 * 60 * 60_000) / TRAFIKLAB_STATIC_MAX_AGE_MS,
  );
  assert.ok(TRAFIKLAB_ALERT_OPERATORS.length >= 16);
  assert.ok(
    perOperator * TRAFIKLAB_ALERT_OPERATORS.length <= 50,
    `${perOperator} × ${TRAFIKLAB_ALERT_OPERATORS.length} downloads`,
  );
});

// Swedish fork: route shapes from the same download (trafiklabShapes.js).
const TRIPS_WITH_SHAPES =
  'route_id,service_id,trip_id,shape_id\n' +
  'R4,1,T-4-a,SH4\n' +
  'R7,1,T-7-a,SH7\n' +
  'R7,1,T-7-b,SH7\n' +
  'RT,1,T-green,\n' +
  'MISSING,1,T-orphan,SH9\n';
const SHAPES_TXT =
  'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n' +
  'SH4,59.30,18.00,1\n' +
  'SH4,59.305,18.00,2\n' +
  'SH4,59.31,18.00,3\n' +
  'SH4,59.31,18.02,4\n' +
  'SH7,59.33,18.06,1\n' +
  'SH7,59.34,18.07,2\n' +
  'SH9,59.20,18.00,1\n' +
  'SH9,59.21,18.00,2\n' +
  'SH-UNUSED,59.40,18.10,1\n' +
  'SH-UNUSED,59.41,18.10,2\n';
const zipWithShapes = (shapes = SHAPES_TXT) =>
  makeZip([
    { name: 'routes.txt', text: ROUTES, deflate: true },
    { name: 'trips.txt', text: TRIPS_WITH_SHAPES, deflate: true },
    ...(shapes === null
      ? []
      : [{ name: 'shapes.txt', text: shapes, deflate: true }]),
  ]);

test('each trip’s route shape comes with the same download and the vehicle names it', async (t) => {
  t.mock.method(console, 'log', () => {});
  const cacheDir = tempDir(t);
  const zip = zipWithShapes();
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    return new Response(zip);
  };
  const feed = getTransitFeed('trafiklab-sl');
  const vehicles = [
    { id: 'v1', tripId: 'T-4-a', routeId: null },
    { id: 'v2', tripId: 'T-7-b', routeId: null },
    { id: 'v3', tripId: 'T-green', routeId: null },
    { id: 'v4', tripId: 'T-orphan', routeId: null },
  ];
  const first = createTrafiklabStatic({
    env: { TRAFIKLAB_GTFS_STATIC_KEY: 'static-key' },
    fetchImpl,
    cacheDir,
  });
  t.after(first.close);
  first.enrichVehicles(feed, vehicles);
  await first.ready('sl');
  const [bus, tram, metro, orphan] = first.enrichVehicles(feed, vehicles);
  assert.equal(bus.routeId, 'bus:4');
  assert.equal(bus.shapeId, 'SH4');
  assert.equal(tram.shapeId, 'SH7');
  assert.equal(Object.hasOwn(metro, 'shapeId'), false, 'its trip names none');
  // A trip with a shape but no route still has its shape.
  assert.equal(orphan.shapeId, 'SH9');
  assert.equal(orphan.routeId, null);

  const join = JSON.parse(
    fs.readFileSync(path.join(cacheDir, 'static-sl.json'), 'utf8'),
  );
  assert.equal(join.version, 1, 'the join file keeps its version');
  assert.deepEqual([...join.shapeIds].sort(), ['SH4', 'SH7', 'SH9']);
  assert.equal(join.shapeIds[join.tripShapes['T-7-a']], 'SH7');
  const file = JSON.parse(
    fs.readFileSync(path.join(cacheDir, 'shapes-sl.json'), 'utf8'),
  );
  assert.equal(file.operator, 'sl');
  assert.equal(file.fetchedAt, join.fetchedAt);
  assert.deepEqual(Object.keys(file.shapes).sort(), ['SH4', 'SH7', 'SH9']);
  // Simplified: the point on the straight run is gone, the corner kept.
  assert.deepEqual(
    decodeRouteShape(file.shapes.SH4),
    [59.3, 18, 59.31, 18, 59.31, 18.02],
  );
  const served = await first.cachedShapes('sl', ['SH4', 'SH-UNUSED', 'NOPE']);
  assert.deepEqual([...served.shapes.keys()], ['SH4']);
  assert.equal(served.staticAt, join.fetchedAt);

  // A second process reads the join and the shapes instead of downloading.
  const second = createTrafiklabStatic({
    env: { TRAFIKLAB_GTFS_STATIC_KEY: 'static-key' },
    fetchImpl,
    cacheDir,
  });
  t.after(second.close);
  await second.ready('sl');
  assert.equal(second.enrichVehicles(feed, vehicles)[0].shapeId, 'SH4');
  assert.equal(
    (await second.cachedShapes('sl', ['SH7'])).shapes.get('SH7'),
    file.shapes.SH7,
  );
  assert.equal(requested.length, 1);
});

test('a join cached before shapes stays in use until it expires; the next download brings them', async (t) => {
  t.mock.method(console, 'log', () => {});
  const cacheDir = tempDir(t);
  let clock = 1_800_000_000_000;
  // As the loader wrote it before it read shapes.
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(
    path.join(cacheDir, 'static-sl.json'),
    JSON.stringify({
      version: 1,
      operator: 'sl',
      fetchedAt: clock - 60_000,
      trips: { 'T-4-a': 'bus:4' },
    }),
  );
  let calls = 0;
  const zip = zipWithShapes();
  const loader = createTrafiklabStatic({
    env: { TRAFIKLAB_GTFS_STATIC_KEY: 'static-key' },
    fetchImpl: async () => {
      calls += 1;
      return new Response(zip);
    },
    cacheDir,
    now: () => clock,
  });
  t.after(loader.close);
  const feed = getTransitFeed('trafiklab-sl');
  const vehicles = [{ id: 'v1', tripId: 'T-4-a', routeId: null }];
  loader.enrichVehicles(feed, vehicles);
  await loader.ready('sl');
  const [early] = loader.enrichVehicles(feed, vehicles);
  assert.equal(early.routeId, 'bus:4');
  assert.equal(Object.hasOwn(early, 'shapeId'), false);
  assert.equal((await loader.cachedShapes('sl', ['SH4'])).shapes.size, 0);
  assert.equal(calls, 0, 'shapes alone never cost a download');

  clock += TRAFIKLAB_STATIC_MAX_AGE_MS;
  loader.enrichVehicles(feed, vehicles);
  await loader.ready('sl');
  assert.equal(calls, 1, 'renewed at its normal expiry');
  assert.equal(loader.enrichVehicles(feed, vehicles)[0].shapeId, 'SH4');
  assert.ok(
    (await loader.cachedShapes('sl', ['SH4'])).shapes.has('SH4'),
    'served at once, though the cache had none a moment ago',
  );
});

test('an archive without shapes.txt still joins routes; its vehicles name no shape', async (t) => {
  t.mock.method(console, 'log', () => {});
  const cacheDir = tempDir(t);
  const zip = zipWithShapes(null);
  const loader = createTrafiklabStatic({
    env: { TRAFIKLAB_GTFS_STATIC_KEY: 'static-key' },
    fetchImpl: async () => new Response(zip),
    cacheDir,
  });
  t.after(loader.close);
  const feed = getTransitFeed('trafiklab-dt');
  const vehicles = [{ id: 'v1', tripId: 'T-7-a', routeId: null }];
  loader.enrichVehicles(feed, vehicles);
  await loader.ready('dt');
  const [tram] = loader.enrichVehicles(feed, vehicles);
  assert.equal(tram.routeId, 'tram:7');
  assert.equal(Object.hasOwn(tram, 'shapeId'), false);
  assert.equal((await loader.cachedShapes('dt', ['SH7'])).shapes.size, 0);
});

test('a broken shapes.txt keeps the route join, and no error names the key', async (t) => {
  const lines = [];
  for (const method of ['log', 'warn'])
    t.mock.method(console, method, (...args) => lines.push(args.join(' ')));
  const cacheDir = tempDir(t);
  const key = 'secret-static-key';
  const broken = zipWithShapes('id,lat,lon\nSH4,59.3,18\n');
  const loader = createTrafiklabStatic({
    env: { TRAFIKLAB_GTFS_STATIC_KEY: key },
    fetchImpl: async () => new Response(broken),
    cacheDir,
  });
  t.after(loader.close);
  const feed = getTransitFeed('trafiklab-ul');
  const vehicles = [{ id: 'v1', tripId: 'T-4-a', routeId: null }];
  loader.enrichVehicles(feed, vehicles);
  await loader.ready('ul');
  assert.equal(loader.enrichVehicles(feed, vehicles)[0].routeId, 'bus:4');
  assert.ok(lines.some((line) => /route shapes unread/.test(line)));
  const served = await loader.cachedShapes('ul', ['SH4']);
  assert.equal(served.shapes.size, 0);

  // A refused download, too.
  const refused = createTrafiklabStatic({
    env: { TRAFIKLAB_GTFS_STATIC_KEY: key },
    fetchImpl: async () => new Response('quota', { status: 429 }),
    cacheDir: tempDir(t),
  });
  t.after(refused.close);
  refused.enrichVehicles(getTransitFeed('trafiklab-xt'), vehicles);
  await refused.ready('xt');
  assert.ok(lines.some((line) => /HTTP 429/.test(line)));
  assert.equal(
    lines.some((line) => line.includes(key)),
    false,
    lines.join('\n'),
  );
  for (const name of fs.readdirSync(cacheDir))
    assert.equal(
      fs.readFileSync(path.join(cacheDir, name), 'utf8').includes(key),
      false,
      name,
    );
});

/** A Trafiklab loader over `zip`, counting its downloads, on its own clock. */
function countingLoader(t, zip, { cacheDir = tempDir(t), key = 'k' } = {}) {
  const loader = {
    calls: 0,
    clock: 1_800_000_000_000,
    cacheDir,
  };
  loader.static = createTrafiklabStatic({
    env: { TRAFIKLAB_GTFS_STATIC_KEY: key },
    fetchImpl: async () => {
      loader.calls += 1;
      return typeof zip === 'function' ? zip() : new Response(zip);
    },
    cacheDir,
    now: () => loader.clock,
  });
  t.after(loader.static.close);
  return loader;
}

test('a corrupt shapes.txt costs no download: the route join is kept', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const zip = zipWithShapes();
  // The local header of shapes.txt (its name's first copy) is broken.
  zip.writeUInt32LE(0xdeadbeef, zip.indexOf('shapes.txt') - 30);
  const loader = countingLoader(t, zip);
  const feed = getTransitFeed('trafiklab-sl');
  const vehicles = [{ id: 'v1', tripId: 'T-4-a', routeId: null }];
  loader.static.enrichVehicles(feed, vehicles);
  await loader.static.ready('sl');
  const [bus] = loader.static.enrichVehicles(feed, vehicles);
  assert.equal(bus.routeId, 'bus:4');
  assert.equal(Object.hasOwn(bus, 'shapeId'), false);
  assert.ok(fs.existsSync(path.join(loader.cacheDir, 'static-sl.json')));
  // A day on, the join is still fresh: no download every six hours.
  for (let i = 0; i < 4; i++) {
    loader.clock += TRAFIKLAB_STATIC_RETRY_MS;
    loader.static.enrichVehicles(feed, vehicles);
    await loader.static.ready('sl');
  }
  assert.equal(loader.calls, 1);
});

test('a download is cached though the loader closed while it was read', async (t) => {
  t.mock.method(console, 'log', () => {});
  const zip = zipWithShapes();
  let loader = null;
  loader = countingLoader(t, () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    async arrayBuffer() {
      // Closed as the archive arrives, before it is read.
      queueMicrotask(() => loader.static.close());
      return zip;
    },
  }));
  loader.static.enrichVehicles(getTransitFeed('trafiklab-sl'), []);
  await loader.static.ready('sl');
  for (const name of ['static-sl.json', 'shapes-sl.json'])
    assert.ok(fs.existsSync(path.join(loader.cacheDir, name)), name);
});

test('a join names no shapes when they could not be written', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const loader = countingLoader(t, zipWithShapes());
  // Where the shapes would be written, a folder: the write fails.
  fs.mkdirSync(
    path.join(loader.cacheDir, `shapes-sl.json.${process.pid}.tmp`),
    { recursive: true },
  );
  const feed = getTransitFeed('trafiklab-sl');
  const vehicles = [{ id: 'v1', tripId: 'T-4-a', routeId: null }];
  loader.static.enrichVehicles(feed, vehicles);
  await loader.static.ready('sl');
  const [bus] = loader.static.enrichVehicles(feed, vehicles);
  assert.equal(bus.routeId, 'bus:4', 'the route join stands');
  assert.equal(Object.hasOwn(bus, 'shapeId'), false, 'no shape to ask for');
  const join = JSON.parse(
    fs.readFileSync(path.join(loader.cacheDir, 'static-sl.json'), 'utf8'),
  );
  assert.equal(Object.hasOwn(join, 'shapeIds'), false);
});

test('a download keeps shapes in memory only for an operator already asked for', async (t) => {
  t.mock.method(console, 'log', () => {});
  const loader = countingLoader(t, zipWithShapes());
  const feed = getTransitFeed('trafiklab-sl');
  loader.static.enrichVehicles(feed, []);
  await loader.static.ready('sl');
  // Nobody asked for SL's shapes: they wait in their file.
  fs.rmSync(path.join(loader.cacheDir, 'shapes-sl.json'));
  assert.equal(
    (await loader.static.cachedShapes('sl', ['SH4'])).shapes.size,
    0,
    'not held in memory',
  );
  // Asked for now, a renewal replaces them in memory too.
  fs.writeFileSync(
    path.join(loader.cacheDir, 'shapes-sl.json'),
    JSON.stringify({
      version: 1,
      operator: 'sl',
      fetchedAt: 1,
      shapes: { SH4: 'old' },
    }),
  );
  loader.clock += 10 * 60_000;
  assert.equal(
    (await loader.static.cachedShapes('sl', ['SH4'])).shapes.get('SH4'),
    'old',
  );
  loader.clock += TRAFIKLAB_STATIC_MAX_AGE_MS;
  loader.static.enrichVehicles(feed, []);
  await loader.static.ready('sl');
  assert.equal(loader.calls, 2);
  assert.notEqual(
    (await loader.static.cachedShapes('sl', ['SH4'])).shapes.get('SH4'),
    'old',
  );
});

test('a shape id no request could name is not read, nor given to a vehicle', async (t) => {
  t.mock.method(console, 'log', () => {});
  const zip = makeZip([
    { name: 'routes.txt', text: ROUTES },
    {
      name: 'trips.txt',
      text:
        'route_id,service_id,trip_id,shape_id\n' +
        'R4,1,T-4-a,"S 4"\n' +
        'R7,1,T-7-a,SH7\n',
    },
    {
      name: 'shapes.txt',
      text:
        'shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\n' +
        '"S 4",59.30,18.00,1\n' +
        '"S 4",59.31,18.00,2\n' +
        'SH7,59.33,18.06,1\n' +
        'SH7,59.34,18.07,2\n',
    },
  ]);
  const loader = countingLoader(t, zip);
  const feed = getTransitFeed('trafiklab-sl');
  const vehicles = [
    { id: 'v1', tripId: 'T-4-a', routeId: null },
    { id: 'v2', tripId: 'T-7-a', routeId: null },
  ];
  loader.static.enrichVehicles(feed, vehicles);
  await loader.static.ready('sl');
  const [bus, tram] = loader.static.enrichVehicles(feed, vehicles);
  assert.equal(Object.hasOwn(bus, 'shapeId'), false);
  assert.equal(tram.shapeId, 'SH7');
  const file = JSON.parse(
    fs.readFileSync(path.join(loader.cacheDir, 'shapes-sl.json'), 'utf8'),
  );
  assert.deepEqual(Object.keys(file.shapes), ['SH7']);
});

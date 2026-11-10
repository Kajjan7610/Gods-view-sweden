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

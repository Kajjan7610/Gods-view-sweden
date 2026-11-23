import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, coreTools } from '../index.js';
import {
  findNextSatellitePass,
  lookAnglesAt,
} from '../../data/satellitePass.js';
import { gpSatrec, noradIdFromSatnum, parseGpCsv } from '../../sources/gp.js';
import {
  GP_CSV_HEADER,
  gpCsv,
  gpCsvRow,
} from '../../testSupport/gpFixtures.mjs';
import {
  SATRECS_IDLE_MS,
  _satelliteSatrecsForTest,
  dropSatelliteSatrecs,
} from './space.js';

// Element sets published for 1 January 2024, as CelesTrak GP fields.
const ISS = Object.freeze({
  OBJECT_NAME: 'ISS (ZARYA)',
  OBJECT_ID: '1998-067A',
  EPOCH: '2024-01-01T12:00:00.000000',
  MEAN_MOTION: '15.50377579',
  ECCENTRICITY: '.0006703',
  INCLINATION: '51.6416',
  RA_OF_ASC_NODE: '247.4627',
  ARG_OF_PERICENTER: '130.5360',
  MEAN_ANOMALY: '325.0288',
  EPHEMERIS_TYPE: '0',
  CLASSIFICATION_TYPE: 'U',
  NORAD_CAT_ID: '25544',
  ELEMENT_SET_NO: '999',
  REV_AT_EPOCH: '43241',
  BSTAR: '.30270E-3',
  MEAN_MOTION_DOT: '.00016717',
  MEAN_MOTION_DDOT: '0',
});
const CSS = Object.freeze({
  OBJECT_NAME: 'CSS (TIANHE)',
  OBJECT_ID: '2021-035A',
  EPOCH: '2024-01-01T12:00:00.000000',
  MEAN_MOTION: '15.61287398',
  ECCENTRICITY: '.0005643',
  INCLINATION: '41.4697',
  RA_OF_ASC_NODE: '175.8913',
  ARG_OF_PERICENTER: '312.8370',
  MEAN_ANOMALY: '141.6893',
  EPHEMERIS_TYPE: '0',
  CLASSIFICATION_TYPE: 'U',
  NORAD_CAT_ID: '48274',
  ELEMENT_SET_NO: '999',
  REV_AT_EPOCH: '15000',
  BSTAR: '.24481E-3',
  MEAN_MOTION_DOT: '.00020137',
  MEAN_MOTION_DDOT: '0',
});
const GP = gpCsv(ISS, CSS);
const CLOCK = { now: () => Date.UTC(2024, 0, 1, 12) };
const satellites = (text = GP, ok = true) => ({
  calls: [],
  async readGroup(group) {
    this.calls.push(group);
    return { ok, status: ok ? 200 : 503, text };
  },
});

test('GP CSV parses into named entries with catalog numbers', () => {
  const entries = parseGpCsv(`${GP}BROKEN\nnot,a,row\nnor this\n`);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['ISS (ZARYA)', 'CSS (TIANHE)'],
  );
  assert.equal(entries[0].noradId, 25544);
  // The TLE format is not read at all.
  assert.deepEqual(
    parseGpCsv(
      'ISS (ZARYA)\n1 25544U 98067A   24001.50000000  .00016717  00000-0  30270-3 0  9994\n2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.50377579432414',
    ),
    [],
  );
});

for (const [missing, cut] of [
  ['a field', (row) => row.replace(',51.6416,', ',')],
  ['its last field', (row) => row.slice(0, row.lastIndexOf(','))],
]) {
  test(`GP parsing resumes after a row missing ${missing}`, () => {
    const rows = Array.from({ length: 8 }, (_, i) =>
      gpCsvRow({
        ...ISS,
        OBJECT_NAME: `SAT ${i}`,
        NORAD_CAT_ID: `${4000 + i}`,
      }),
    );
    rows[1] = cut(rows[1]);
    const entries = parseGpCsv([GP_CSV_HEADER, ...rows].join('\r\n'));
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ['SAT 0', 'SAT 2', 'SAT 3', 'SAT 4', 'SAT 5', 'SAT 6', 'SAT 7'],
    );
    assert.ok(entries.every((entry) => gpSatrec(entry)));
  });
}

test('GP parsing rejects a row spliced from two objects and resumes', () => {
  // One object's name and number with the next one's elements run on.
  const spliced = `${gpCsvRow({ ...ISS, OBJECT_NAME: 'SAT A' })},${gpCsvRow(CSS)}`;
  const text = [
    GP_CSV_HEADER,
    spliced,
    gpCsvRow({ ...CSS, OBJECT_NAME: 'SAT B' }),
  ].join('\n');
  const entries = parseGpCsv(text);
  assert.deepEqual(
    entries.map((entry) => entry.name),
    ['SAT B'],
  );
  assert.equal(entries[0].noradId, 48274);
});

test('GP parsing reads catalog numbers above 99999 as they are', () => {
  const ids = [100000, 100404, 179999, 180000, 229999, 230000, 270449, 339999];
  // Past what even Alpha-5 could spell in a TLE.
  ids.push(340000, 412345);
  const text = gpCsv(
    ...ids.map((id) => ({
      ...CSS,
      OBJECT_NAME: `SAT ${id}`,
      NORAD_CAT_ID: `${id}`,
    })),
  );
  const entries = parseGpCsv(text);
  assert.deepEqual(
    entries.map((entry) => entry.noradId),
    ids,
  );
  for (const entry of entries)
    assert.equal(noradIdFromSatnum(gpSatrec(entry).satnum), entry.noradId);
});

test('GP parsing rejects a row whose catalog number is malformed and resumes', () => {
  const malformed = [
    '2554A',
    '255 4',
    '-1234',
    '0x1F0',
    '1.5',
    '1e3',
    'A0000',
    '',
  ];
  const text = gpCsv(
    ...malformed.map((id) => ({
      ...ISS,
      OBJECT_NAME: 'SAT MALFORMED',
      NORAD_CAT_ID: id,
    })),
    ISS,
    CSS,
  );
  assert.deepEqual(
    parseGpCsv(text).map((entry) => entry.name),
    ['ISS (ZARYA)', 'CSS (TIANHE)'],
  );
});

test('a digit catalog number reads as it did before', () => {
  assert.equal(noradIdFromSatnum('25544'), 25544);
  assert.equal(noradIdFromSatnum('00404'), 404);
  assert.equal(noradIdFromSatnum('  404'), 404);
  assert.equal(
    parseGpCsv(gpCsv({ ...ISS, NORAD_CAT_ID: '00404' }))[0].noradId,
    404,
  );
  // A GP satrec carries the number unpadded, past five digits.
  assert.equal(noradIdFromSatnum('100000'), 100000);
});

test('a malformed catalog number is no number', () => {
  for (const field of [
    'A0000',
    'I0000',
    'a0404',
    'A00',
    '2554A',
    '255 4',
    '-1234',
    '0x1F0',
    '1.5',
    '1e3',
    '',
    '     ',
  ]) {
    assert.ok(Number.isNaN(noradIdFromSatnum(field)), JSON.stringify(field));
    assert.deepEqual(
      parseGpCsv(gpCsv({ ...ISS, NORAD_CAT_ID: field })),
      [],
      JSON.stringify(field),
    );
  }
  assert.ok(Number.isNaN(noradIdFromSatnum(undefined)));
});

test('a satellite numbered above 99999 keeps its number and is found by it', async () => {
  // The ISS set under 412345, a number no TLE (not even Alpha-5) can spell.
  const text = gpCsv({ ...ISS, NORAD_CAT_ID: '412345' }, CSS);
  const [iss] = parseGpCsv(text);
  assert.equal(noradIdFromSatnum(gpSatrec(iss).satnum), 412345);
  const catalog = composeCatalog({
    tools: coreTools,
    services: { satellites: satellites(text), clock: CLOCK },
  });
  const result = await catalog.call('next_satellite_pass', {
    location: { lat: 40.7, lon: -74 },
    satellite: '412345',
  });
  assert.equal(result.data.satellite, 'ISS (ZARYA)');
  assert.equal(result.data.norad, 412345);
  assert.ok(Date.parse(result.data.pass.rise) >= CLOCK.now());
  // And it is overhead when the ISS would be.
  const atPeak = await composeCatalog({
    tools: coreTools,
    services: {
      satellites: satellites(text),
      clock: { now: () => Date.parse(result.data.pass.peak) },
    },
  }).call('satellites_overhead', { location: { lat: 40.7, lon: -74 } });
  assert.equal(atPeak.data.rows[0].norad, 412345);
});

test('the next pass defaults to the ISS and reports times, peak and direction', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: { satellites: satellites(), clock: CLOCK },
  });
  const result = await catalog.call('next_satellite_pass', {
    location: { lat: 40.7, lon: -74 },
  });
  const { pass } = result.data;
  assert.equal(result.data.satellite, 'ISS (ZARYA)');
  assert.equal(result.data.norad, 25544);
  assert.ok(Date.parse(pass.rise) >= CLOCK.now());
  assert.ok(Date.parse(pass.rise) < Date.parse(pass.peak));
  assert.ok(Date.parse(pass.peak) < Date.parse(pass.set));
  assert.ok(pass.max_elevation_deg >= 10 && pass.max_elevation_deg <= 90);
  assert.match(pass.rise_direction, /^[NESW]{1,3}$/);
  assert.match(
    result.summary,
    new RegExp(
      `^ISS \\(ZARYA\\) next rises over 40.7000, -74.0000 at ${pass.rise} in the ${pass.rise_direction}, peaking at \\d+°`,
    ),
  );
});

test('a satellite whose elements are no orbit is passed over, and the overhead list skips it', async () => {
  const broken = gpCsv({ ...ISS, MEAN_MOTION: 'fast' }, CSS);
  const catalog = composeCatalog({
    tools: coreTools,
    services: { satellites: satellites(broken), clock: CLOCK },
  });
  await assert.rejects(
    catalog.call('next_satellite_pass', { location: { lat: 0, lon: 0 } }),
    /No satellite matching "ISS" is in the stations group/,
  );
  const tianhe = await catalog.call('next_satellite_pass', {
    location: { lat: 0, lon: 0 },
    satellite: 'tianhe',
  });
  assert.equal(tianhe.data.norad, 48274);
  const overhead = await catalog.call('satellites_overhead', {
    location: { lat: 0, lon: 0 },
    min_elevation_deg: 0,
  });
  assert.ok(overhead.data.rows.every((row) => row.norad !== 25544));
});

test('satellites are matched by name or catalog number within the group', async () => {
  const source = satellites();
  const catalog = composeCatalog({
    tools: coreTools,
    services: { satellites: source, clock: CLOCK },
  });
  const byName = await catalog.call('next_satellite_pass', {
    location: { lat: 0, lon: 0 },
    satellite: 'tianhe',
  });
  assert.equal(byName.data.norad, 48274);
  const byNumber = await catalog.call('next_satellite_pass', {
    location: { lat: 0, lon: 0 },
    satellite: '48274',
    group: 'visual',
  });
  assert.equal(byNumber.data.satellite, 'CSS (TIANHE)');
  assert.deepEqual(source.calls, ['stations', 'visual']);
  await assert.rejects(
    catalog.call('next_satellite_pass', {
      location: { lat: 0, lon: 0 },
      satellite: 'Hubble',
    }),
    /No satellite matching "Hubble" is in the stations group/,
  );
  await assert.rejects(
    catalog.call('next_satellite_pass', {
      location: { lat: 0, lon: 0 },
      group: 'weather',
    }),
    /must be one of/,
  );
});

test('a pass that never comes is a normal answer, and catalog failures are unavailable', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: { satellites: satellites(), clock: CLOCK },
  });
  // The ISS orbit is inclined 51.6°, so it never rises 10° above the pole.
  const none = await catalog.call('next_satellite_pass', {
    location: { lat: 89.9, lon: 0 },
    hours: 6,
  });
  assert.equal(none.data.pass, null);
  assert.equal(
    none.summary,
    'ISS (ZARYA) has no pass over 89.9000, 0.0000 in the next 6 hours.',
  );
  const down = composeCatalog({
    tools: coreTools,
    services: { satellites: satellites('', false), clock: CLOCK },
  });
  await assert.rejects(
    down.call('next_satellite_pass', { location: { lat: 0, lon: 0 } }),
    (error) => error.code === 'unavailable' && /HTTP 503/.test(error.message),
  );
});

test('satellites overhead are those above the elevation, highest first', async () => {
  const source = satellites();
  const services = { satellites: source, clock: CLOCK };
  const catalog = composeCatalog({ tools: coreTools, services });
  const pass = (
    await catalog.call('next_satellite_pass', {
      location: { lat: 40.7, lon: -74 },
    })
  ).data.pass;
  const atPeak = {
    satellites: source,
    clock: { now: () => Date.parse(pass.peak) },
  };
  const overhead = await composeCatalog({
    tools: coreTools,
    services: atPeak,
  }).call('satellites_overhead', {
    location: { lat: 40.7, lon: -74 },
  });
  assert.equal(overhead.data.rows[0].name, 'ISS (ZARYA)');
  assert.ok(
    Math.abs(overhead.data.rows[0].elevation_deg - pass.max_elevation_deg) < 1,
  );
  assert.equal(overhead.data.at, pass.peak);
  const strict = await composeCatalog({
    tools: coreTools,
    services: atPeak,
  }).call('satellites_overhead', {
    location: { lat: 40.7, lon: -74 },
    min_elevation_deg: 90,
  });
  assert.equal(strict.data.total, 0);
  assert.match(
    strict.summary,
    /^0 satellites from the stations group are at least 90° above/,
  );
});

test('satellite azimuths that round to 360 read as 0', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: { satellites: satellites(), clock: CLOCK },
  });
  // At these points the ISS's raw azimuths fall just below 360°; check that
  // first so the test cannot pass on a raw value near 0.
  const iss = gpSatrec(parseGpCsv(GP)[0]);
  const nearNorth = (deg) => deg > 359.5 && deg < 360;
  const rawPass = findNextSatellitePass({
    satrec: iss,
    latDeg: 10,
    lonDeg: 30,
    fromMs: CLOCK.now(),
  });
  assert.ok(nearNorth(rawPass.riseAzDeg), `rise ${rawPass.riseAzDeg}°`);
  const rawLook = lookAnglesAt(iss, CLOCK.now(), 39.25, 65.75);
  assert.ok(nearNorth(rawLook.azDeg), `azimuth ${rawLook.azDeg}°`);
  const pass = await catalog.call('next_satellite_pass', {
    location: { lat: 10, lon: 30 },
  });
  assert.equal(pass.data.pass.rise_azimuth_deg, 0);
  assert.equal(pass.data.pass.rise_direction, 'N');
  const overhead = await catalog.call('satellites_overhead', {
    location: { lat: 39.25, lon: 65.75 },
  });
  assert.equal(overhead.data.rows[0].name, 'ISS (ZARYA)');
  assert.equal(overhead.data.rows[0].azimuth_deg, 0);
});

test('stale orbit and launch data are reported', async () => {
  const stale = {
    readGroup: async () => ({ ok: true, status: 200, text: GP, stale: true }),
  };
  const catalog = composeCatalog({
    tools: coreTools,
    services: {
      satellites: stale,
      clock: CLOCK,
      launches: {
        getLaunchSnapshot: async () => ({ payload: [], stale: true }),
      },
    },
  });
  const overhead = await catalog.call('satellites_overhead', {
    location: { lat: 0, lon: 0 },
  });
  assert.equal(overhead.data.stale, true);
  assert.match(overhead.summary, /\(orbit data may be stale\)\.$/);
  const launches = await catalog.call('get_recent_launches', {});
  assert.equal(launches.data.stale, true);
  assert.match(launches.summary, /\(data may be stale\)\.$/);
});

// Swedish fork: the proxy serves the same rows for 6 h.
test('a second question about a group builds none of its satrecs again, and an idle while drops them', async (t) => {
  dropSatelliteSatrecs();
  t.after(dropSatelliteSatrecs);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const catalog = composeCatalog({
    tools: coreTools,
    services: { satellites: satellites(), clock: CLOCK },
  });
  const overhead = () =>
    catalog.call('satellites_overhead', {
      location: { lat: 40.7, lon: -74 },
      min_elevation_deg: 0,
    });
  await overhead();
  const satrecs = _satelliteSatrecsForTest('stations');
  // The same rows read again find the satrecs the list built.
  const [iss, css] = parseGpCsv(GP);
  const issSatrec = satrecs.satrec(iss);
  const cssSatrec = satrecs.satrec(css);
  await overhead();
  assert.equal(satrecs.satrec(iss), issSatrec, 'not built again');
  assert.equal(satrecs.satrec(css), cssSatrec);
  // A pass question asks the same cache.
  await catalog.call('next_satellite_pass', {
    location: { lat: 40.7, lon: -74 },
  });
  assert.equal(_satelliteSatrecsForTest('stations'), satrecs);
  assert.equal(satrecs.satrec(iss), issSatrec);
  // Each question puts the drop back; none for SATRECS_IDLE_MS drops all.
  t.mock.timers.tick(SATRECS_IDLE_MS - 1);
  assert.equal(_satelliteSatrecsForTest('stations'), satrecs);
  t.mock.timers.tick(1);
  assert.equal(_satelliteSatrecsForTest('stations'), undefined);
});

test('satellite and launch sources read the proxies stale markers', async () => {
  const { createSatelliteSource } =
    await import('../../layers/satellites/source.js');
  const { createLaunchSource } =
    await import('../../layers/launches/source.js');
  const satellites = createSatelliteSource({
    fetchImpl: async () =>
      new Response(GP, { headers: { 'x-tle-cache': 'STALE-ERROR' } }),
  });
  assert.equal((await satellites.readGroup('stations')).stale, true);
  const launches = createLaunchSource({
    fetchImpl: async () =>
      Response.json([], { headers: { 'X-GEV-Cache': 'STALE-ERROR' } }),
  });
  assert.deepEqual(await launches.getLaunchSnapshot(), {
    payload: [],
    stale: true,
  });
  const { getLaunches } = launches;
  assert.deepEqual(await getLaunches(), []);
});

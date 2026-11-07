// OurAirports' list by IATA code: CSV fields, which airports are kept, and
// the index's week-long cache with its fallback.
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAirportIndex, csvFields, parseAirports } from './ourAirports.js';

const HEADER =
  'id,ident,type,name,latitude_deg,longitude_deg,elevation_ft,continent,iso_country,iso_region,municipality,scheduled_service,icao_code,iata_code,gps_code,local_code,home_link,wikipedia_link,keywords';
const row = (type, name, lat, lon, town, country, iata) =>
  `1,X,${type},"${name}",${lat},${lon},0,EU,${country},R,"${town}",yes,XXXX,${iata},,,,,`;

test('CSV fields: quotes, commas inside and doubled quotes', () => {
  assert.deepEqual(csvFields('a,"b, c","say ""hi""",'), [
    'a',
    'b, c',
    'say "hi"',
    '',
  ]);
});

test('airports with an IATA code; the larger kind wins a shared code', () => {
  const csv = [
    HEADER,
    row(
      'large_airport',
      'Stockholm-Arlanda Airport',
      59.6519,
      17.9186,
      'Stockholm',
      'SE',
      'ARN',
    ),
    row('closed', 'Old field', 1, 1, 'X', 'SE', 'OLD'),
    row('heliport', 'Pad', 1, 1, 'X', 'SE', 'HEL'),
    row('small_airport', 'Strip', 60.1, 24.9, 'Helsinki', 'FI', 'HEL'),
    row(
      'large_airport',
      'Helsinki Vantaa Airport',
      60.3172,
      24.9633,
      'Helsinki',
      'FI',
      'HEL',
    ),
    row('medium_airport', 'No code', 1, 1, 'X', 'SE', ''),
  ].join('\n');
  const airports = parseAirports(csv);
  assert.deepEqual(Object.keys(airports).sort(), ['ARN', 'HEL']);
  assert.deepEqual(airports.HEL, [
    60.3172,
    24.9633,
    'Helsinki Vantaa Airport',
    'Helsinki',
    'FI',
  ]);
  assert.deepEqual(parseAirports('nope'), {});
});

test('the index: downloaded once, kept a week on disk, older copy on failure', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'gev-ourairports-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cacheFile = path.join(dir, 'airports-iata.json');
  const many = [HEADER];
  for (let i = 0; i < 1100; i += 1) {
    const letter = (n) => String.fromCharCode(65 + (n % 26));
    const code = `${letter(i)}${letter(Math.floor(i / 26))}${letter(Math.floor(i / 676) + 3)}`;
    many.push(
      row('medium_airport', `Airport ${i}`, 50, 10, 'Town', 'DE', code),
    );
  }
  many.push(
    row(
      'large_airport',
      'Helsinki Vantaa Airport',
      60.3172,
      24.9633,
      'Helsinki',
      'FI',
      'HEL',
    ),
  );
  let calls = 0;
  let fail = false;
  let clock = Date.parse('2026-11-07T12:00:00Z');
  const fetchImpl = async () => {
    calls += 1;
    if (fail) return new Response('', { status: 503 });
    return new Response(many.join('\n'));
  };
  const index = createAirportIndex({ fetchImpl, now: () => clock, cacheFile });
  const found = await index.lookup(['HEL', 'XXX']);
  assert.deepEqual(found.HEL, {
    lat: 60.3172,
    lon: 24.9633,
    name: 'Helsinki Vantaa Airport',
    town: 'Helsinki',
    country: 'FI',
  });
  assert.equal(found.XXX, undefined);
  assert.ok(JSON.parse(await readFile(cacheFile, 'utf8')).airports.HEL);
  // A new process reads the week-old file instead of downloading.
  const again = createAirportIndex({ fetchImpl, now: () => clock, cacheFile });
  await again.lookup(['HEL']);
  assert.equal(calls, 1);
  // After a week the download fails: the older copy still answers.
  clock += 8 * 24 * 60 * 60_000;
  fail = true;
  const later = createAirportIndex({ fetchImpl, now: () => clock, cacheFile });
  assert.ok((await later.lookup(['HEL'])).HEL);
  assert.equal(calls, 2);
});

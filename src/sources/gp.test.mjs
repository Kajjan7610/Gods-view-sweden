import test from 'node:test';
import assert from 'node:assert/strict';
import { json2satrec, propagate, twoline2satrec } from 'satellite.js';
import {
  createGpSatrecCache,
  gpCosparId,
  gpRecord,
  gpSatrec,
  gpTleLines,
  noradIdFromSatnum,
  parseGpCsv,
} from './gp.js';
import {
  GP_CSV_FIELDS,
  GP_CSV_HEADER,
  gpCsv,
  gpCsvRow,
} from '../testSupport/gpFixtures.mjs';

// The ISS set of 20 September 2008, as published with its TLE (lines below),
// its fields written by hand in the form CelesTrak's CSV gives them.
const ISS_2008 = Object.freeze({
  OBJECT_NAME: 'ISS (ZARYA)',
  OBJECT_ID: '1998-067A',
  EPOCH: '2008-09-20T12:25:40.104192',
  MEAN_MOTION: '15.72125391',
  ECCENTRICITY: '.0006703',
  INCLINATION: '51.6416',
  RA_OF_ASC_NODE: '247.4627',
  ARG_OF_PERICENTER: '130.5360',
  MEAN_ANOMALY: '325.0288',
  EPHEMERIS_TYPE: '0',
  CLASSIFICATION_TYPE: 'U',
  NORAD_CAT_ID: '25544',
  ELEMENT_SET_NO: '292',
  REV_AT_EPOCH: '56353',
  BSTAR: '-.11606E-4',
  MEAN_MOTION_DOT: '-.00002182',
  MEAN_MOTION_DDOT: '0',
});
const ISS_2008_LINE1 =
  '1 25544U 98067A   08264.51782528 -.00002182  00000-0 -11606-4 0  2927';
const ISS_2008_LINE2 =
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.72125391563537';

const one = (fields) => {
  const entries = parseGpCsv(gpCsv(fields));
  assert.equal(entries.length, 1);
  return entries[0];
};

/** How far apart two satrecs put their satellite at `date`, km. */
function kmApart(a, b, date) {
  const p = propagate(a, date).position;
  const q = propagate(b, date).position;
  return Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z);
}

test('GP CSV parses into named entries with catalog numbers and launch years', () => {
  // CRLF line ends and a byte order mark are read as well.
  const entries = parseGpCsv(
    `${String.fromCharCode(0xfeff)}${gpCsv(
      ISS_2008,
      {
        ...ISS_2008,
        OBJECT_NAME: 'CSS (TIANHE)',
        OBJECT_ID: '2021-035A',
        NORAD_CAT_ID: '48274',
      },
      // A name with a comma comes quoted.
      {
        ...ISS_2008,
        OBJECT_NAME: 'OBJECT A, B',
        OBJECT_ID: '',
        NORAD_CAT_ID: '48275',
      },
    ).replaceAll('\n', '\r\n')}`,
  );
  assert.deepEqual(
    entries.map(({ name, noradId, launchYear }) => [name, noradId, launchYear]),
    [
      ['ISS (ZARYA)', 25544, 1998],
      ['CSS (TIANHE)', 48274, 2021],
      ['OBJECT A, B', 48275, null],
    ],
  );
  // The entries of one text share its header's indexes.
  assert.equal(entries[0].columns, entries[2].columns);
  assert.equal(gpRecord(entries[2]).OBJECT_NAME, 'OBJECT A, B');
  assert.equal(gpRecord(entries[1]).NORAD_CAT_ID, '48274');
  assert.equal(gpRecord(null), null);
});

test('a text without the GP header gives no entries', () => {
  for (const text of [
    '',
    'No GP data found',
    '<!DOCTYPE html><html><body>502 Bad Gateway</body></html>',
    // SATCAT's CSV names objects but carries no elements.
    'OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER\nISS (ZARYA),1998-067A,25544,PAY,+,ISS',
    // The ISS TLE: the old format is not read.
    `ISS (ZARYA)\n${ISS_2008_LINE1}\n${ISS_2008_LINE2}`,
    // A header missing one needed field.
    gpCsv(ISS_2008).replace('BSTAR', 'B_STAR'),
  ])
    assert.deepEqual(parseGpCsv(text), [], JSON.stringify(text.slice(0, 40)));
  assert.deepEqual(parseGpCsv(undefined), []);
});

test('the header is read by name, in any order', () => {
  const reversed = [...GP_CSV_FIELDS].reverse();
  const text = [
    reversed.join(','),
    reversed.map((name) => ISS_2008[name]).join(','),
  ].join('\n');
  const [entry] = parseGpCsv(text);
  assert.equal(entry.noradId, 25544);
  assert.deepEqual(gpTleLines(entry), gpTleLines(one(ISS_2008)));
});

test('a malformed row is skipped and the next is read', () => {
  const good = (noradId) => ({
    ...ISS_2008,
    OBJECT_NAME: `SAT ${noradId}`,
    NORAD_CAT_ID: String(noradId),
  });
  const row = gpCsvRow(good(40001));
  const text = [
    GP_CSV_HEADER,
    gpCsvRow(good(40000)),
    // Truncated, and two rows spliced into one: neither can pair one
    // object's fields with another's.
    row.slice(0, row.lastIndexOf(',')),
    `${row},${gpCsvRow(good(40002))}`,
    '',
    gpCsvRow(good(40003)),
    ...[
      ['NORAD_CAT_ID', '2554A'],
      ['NORAD_CAT_ID', '-1234'],
      ['NORAD_CAT_ID', '1.5'],
      ['NORAD_CAT_ID', '1e3'],
      ['NORAD_CAT_ID', '0'],
      ['NORAD_CAT_ID', ''],
      ['EPOCH', '2008-09-31T12:25:40.104192'],
      ['EPOCH', '2007-02-29T00:00:00'],
      ['EPOCH', '2008-09-20T24:00:00'],
      ['EPOCH', '08264.51782528'],
      ['EPOCH', ''],
    ].map(([name, value]) => gpCsvRow({ ...good(40009), [name]: value })),
    gpCsvRow(good(40004)),
  ].join('\n');
  assert.deepEqual(
    parseGpCsv(text).map((entry) => entry.noradId),
    [40000, 40003, 40004],
  );
  // 29 February of a leap year is a day like any other.
  assert.equal(
    one({ ...good(40005), EPOCH: '2008-02-29T00:00:00' }).noradId,
    40005,
  );
});

test('a row whose elements are no orbit gives no satrec, as a bad TLE gave none', () => {
  for (const [name, value] of [
    ['MEAN_MOTION', 'fast'],
    ['MEAN_MOTION', '0'],
    ['MEAN_MOTION', '-15.7'],
    ['ECCENTRICITY', '1.2'],
    ['ECCENTRICITY', '-.1'],
    ['INCLINATION', 'NaN'],
    ['INCLINATION', '0x1F'],
    ['RA_OF_ASC_NODE', '247.4627 deg'],
    ['BSTAR', ''],
    ['MEAN_ANOMALY', 'Infinity'],
  ]) {
    // Read as a row, its number known, but never drawn.
    const entry = one({ ...ISS_2008, [name]: value });
    assert.equal(entry.noradId, 25544, `${name} ${value}`);
    assert.equal(gpSatrec(entry), null, `${name} ${value}`);
    assert.equal(gpTleLines(entry), null, `${name} ${value}`);
  }
});

test('catalog numbers above 99999 read as the plain numbers they are', () => {
  for (const id of [
    '100000',
    '179999',
    '270449',
    '339999',
    '412345',
    '999999999',
  ])
    assert.equal(
      one({ ...ISS_2008, NORAD_CAT_ID: id }).noradId,
      Number(id),
      id,
    );
  assert.equal(one({ ...ISS_2008, NORAD_CAT_ID: '00404' }).noradId, 404);
  assert.deepEqual(
    parseGpCsv(gpCsv({ ...ISS_2008, NORAD_CAT_ID: '1234567890' })),
    [],
  );
});

test('a satrec number reads as digits of any length, anything else as NaN', () => {
  assert.equal(noradIdFromSatnum('25544'), 25544);
  assert.equal(noradIdFromSatnum('00404'), 404);
  assert.equal(noradIdFromSatnum('  404'), 404);
  assert.equal(noradIdFromSatnum('412345'), 412345);
  for (const field of [
    'A0000',
    '2554A',
    '-1234',
    '1.5',
    '1e3',
    '',
    '   ',
    undefined,
  ])
    assert.ok(Number.isNaN(noradIdFromSatnum(field)), JSON.stringify(field));
});

test('elements read in place are, bit for bit, the numbers Number() reads', () => {
  // A seeded generator: the same 3,000 rows every run.
  let seed = 20261123;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  const digits = (count) =>
    Array.from({ length: count }, () => Math.floor(next() * 10)).join('');
  // A number written as CelesTrak might, or as a JSON writer would, or
  // long enough that Number() reads it from a slice.
  const spell = (value) => {
    const pick = next();
    if (pick < 0.2) return value.toExponential(4).replace('e', 'E');
    if (pick < 0.4) return String(value);
    if (pick < 0.5)
      return `${value < 0 ? '-' : ''}.${digits(5)}E-${1 + Math.floor(next() * 9)}`;
    if (pick < 0.6) return `${value.toFixed(4)}${digits(18)}`;
    if (pick < 0.7)
      return `${value < 0 ? '-' : '+'}${Math.abs(value).toFixed(8)}`;
    if (pick < 0.8) return `${value.toFixed(3)}e${Math.floor(next() * 5)}`;
    return value.toFixed(Math.floor(next() * 9));
  };
  const fields = Array.from({ length: 3000 }, () => ({
    MEAN_MOTION: spell(1 + next() * 15),
    ECCENTRICITY: spell(next() * 0.2).replace(/E\d|e\d/, 'E-1'),
    INCLINATION: spell(next() * 180),
    RA_OF_ASC_NODE: spell(next() * 360),
    ARG_OF_PERICENTER: spell(next() * 360),
    MEAN_ANOMALY: spell(next() * 360),
    BSTAR: spell((next() - 0.5) * 1e-3),
  }));
  let compared = 0;
  for (const elements of fields) {
    const entry = one({ ...ISS_2008, ...elements });
    const built = gpSatrec(entry);
    const omm = {
      NORAD_CAT_ID: '25544',
      EPOCH: '2008-09-20T12:25:40.104Z',
      MEAN_MOTION_DOT: Number(ISS_2008.MEAN_MOTION_DOT),
      MEAN_MOTION_DDOT: 0,
      ...Object.fromEntries(
        Object.entries(elements).map(([name, text]) => [name, Number(text)]),
      ),
    };
    const valid =
      omm.MEAN_MOTION > 0 && omm.ECCENTRICITY >= 0 && omm.ECCENTRICITY < 1;
    if (!valid) {
      assert.equal(built, null, JSON.stringify(elements));
      continue;
    }
    const reference = json2satrec(omm);
    if (reference.error !== 0) continue;
    for (const key of ['no', 'ecco', 'inclo', 'nodeo', 'argpo', 'mo', 'bstar'])
      assert.ok(
        Object.is(built[key], reference[key]),
        `${key} ${JSON.stringify(elements)}`,
      );
    compared++;
  }
  // Some spellings make no orbit (both agree there) or one SGP4 rejects.
  assert.ok(compared > 2000, `${compared} compared`);
});

test('the satrec is the orbit satellite.js reads from the same elements as a TLE', () => {
  const satrec = gpSatrec(one(ISS_2008));
  const fromTle = twoline2satrec(ISS_2008_LINE1, ISS_2008_LINE2);
  assert.equal(satrec.error, 0);
  assert.equal(satrec.satnum, '25544');
  for (const key of ['inclo', 'nodeo', 'ecco', 'argpo', 'mo', 'no', 'bstar'])
    assert.ok(Math.abs(satrec[key] - fromTle[key]) < 1e-12, key);
  // The epoch to the millisecond (the TLE's to 0.864 ms).
  assert.ok(Math.abs(satrec.jdsatepoch - fromTle.jdsatepoch) * 86_400_000 < 1);
  const dayOn = new Date(Date.UTC(2008, 8, 21, 12));
  assert.ok(kmApart(satrec, fromTle, dayOn) < 0.01, 'within 10 m a day on');
  // An epoch without a fraction, or ending in Z, reads the same way.
  for (const EPOCH of ['2008-09-20T12:25:40', '2008-09-20T12:25:40.104192Z'])
    assert.ok(gpSatrec(one({ ...ISS_2008, EPOCH })), EPOCH);
  // Blank rates (SGP4 does not use them) and plain decimals are read too.
  const plain = gpSatrec(
    one({
      ...ISS_2008,
      MEAN_MOTION_DOT: '',
      MEAN_MOTION_DDOT: '',
      ECCENTRICITY: '0.0006703',
      BSTAR: '-1.1606e-5',
    }),
  );
  assert.equal(plain.ecco, satrec.ecco);
  assert.equal(plain.bstar, satrec.bstar);
  // A zero in exponent form is a zero, not a hex prefix.
  for (const BSTAR of ['0', '0.0', '0E+0', '0e-5', '.00000E+0'])
    assert.equal(gpSatrec(one({ ...ISS_2008, BSTAR }))?.bstar, 0, BSTAR);
  assert.equal(gpSatrec(null), null);
  assert.equal(gpSatrec({ row: 'x', columns: { EPOCH: 0 } }), null);
});

test('an object numbered 100000 or up propagates like any other', () => {
  const big = gpSatrec(one({ ...ISS_2008, NORAD_CAT_ID: '412345' }));
  assert.equal(noradIdFromSatnum(big.satnum), 412345);
  const iss = gpSatrec(one(ISS_2008));
  assert.equal(kmApart(big, iss, new Date(Date.UTC(2008, 8, 21))), 0);
});

test('the TLE lines say the published elements, each with its checksum', () => {
  const lines = gpTleLines(one(ISS_2008));
  // A zero second derivative is written 00000+0, so line 1's checksum is 6.
  assert.equal(
    lines.line1,
    '1 25544U 98067A   08264.51782528 -.00002182  00000+0 -11606-4 0  2926',
  );
  assert.equal(lines.line2, ISS_2008_LINE2);
  const back = twoline2satrec(lines.line1, lines.line2);
  const published = twoline2satrec(ISS_2008_LINE1, ISS_2008_LINE2);
  assert.equal(kmApart(back, published, new Date(Date.UTC(2008, 8, 23))), 0);
});

test('the TLE lines write each column as CelesTrak does', () => {
  const lines = (fields) => gpTleLines(one({ ...ISS_2008, ...fields }));
  const columns = ({ line1, line2 }) => ({
    designator: line1.slice(9, 17),
    epoch: line1.slice(18, 32),
    ndot: line1.slice(33, 43),
    nddot: line1.slice(44, 52),
    bstar: line1.slice(53, 61),
    elset: line1.slice(64, 68),
    eccentricity: line2.slice(26, 33),
    meanMotion: line2.slice(52, 63),
    rev: line2.slice(63, 68),
  });
  assert.deepEqual(
    columns(
      lines({
        OBJECT_ID: '2024-123BC',
        EPOCH: '2024-01-01T12:00:00.000000',
        BSTAR: '.30370E-3',
        MEAN_MOTION_DOT: '.00016717',
        MEAN_MOTION_DDOT: '0.0000123',
        ECCENTRICITY: '0.1234567',
        MEAN_MOTION: '1.00271527',
        ELEMENT_SET_NO: '999',
        REV_AT_EPOCH: '144',
      }),
    ),
    {
      designator: '24123BC ',
      epoch: '24001.50000000',
      ndot: ' .00016717',
      nddot: ' 12300-4',
      bstar: ' 30370-3',
      elset: ' 999',
      eccentricity: '1234567',
      meanMotion: ' 1.00271527',
      rev: '  144',
    },
  );
  const bstar = (BSTAR) => columns(lines({ BSTAR })).bstar;
  assert.equal(bstar('0'), ' 00000+0');
  assert.equal(bstar('1e-5'), ' 10000-4');
  assert.equal(bstar('9.999996e-4'), ' 10000-2', 'rounds up to the next power');
  assert.equal(bstar('-0.12345'), '-12345+0');
  assert.equal(bstar('5e-15'), ' 00000+0', 'too small for one digit of power');
  // A blank designator, a rate CelesTrak left out, a long revolution count.
  assert.deepEqual(
    (({ designator, ndot, rev }) => ({ designator, ndot, rev }))(
      columns(
        lines({ OBJECT_ID: '', MEAN_MOTION_DOT: '', REV_AT_EPOCH: '123456' }),
      ),
    ),
    { designator: '        ', ndot: ' .00000000', rev: '23456' },
  );
  // Rounding past midnight on the last day of the year starts the next.
  assert.equal(
    columns(lines({ EPOCH: '2023-12-31T23:59:59.999999' })).epoch,
    '24001.00000000',
  );
});

test('no TLE lines for an object numbered 100000 or up, or elements that do not fit', () => {
  assert.equal(gpTleLines(one({ ...ISS_2008, NORAD_CAT_ID: '100000' })), null);
  assert.equal(gpTleLines(one({ ...ISS_2008, MEAN_MOTION: '100.5' })), null);
  assert.equal(
    gpTleLines(one({ ...ISS_2008, EPOCH: '2057-01-01T00:00:00' })),
    null,
  );
  assert.equal(gpTleLines(one({ ...ISS_2008, BSTAR: '2e10' })), null);
  assert.equal(gpTleLines(null), null);
  // The number padded to five digits.
  assert.match(
    gpTleLines(one({ ...ISS_2008, NORAD_CAT_ID: '5' })).line1,
    /^1 00005U /,
  );
});

test('the COSPAR id is the designator CelesTrak gives', () => {
  assert.equal(gpCosparId(one(ISS_2008)), '1998-067A');
  assert.equal(
    gpCosparId(one({ ...ISS_2008, OBJECT_ID: '1957-001B' })),
    '1957-001B',
  );
  assert.equal(
    gpCosparId(one({ ...ISS_2008, OBJECT_ID: '2024-123BC' })),
    '2024-123BC',
  );
  for (const OBJECT_ID of ['', 'UNKNOWN', '98067A', '1998-67A'])
    assert.equal(gpCosparId(one({ ...ISS_2008, OBJECT_ID })), null, OBJECT_ID);
  assert.equal(gpCosparId(undefined), null);
});

test('an entry carries its epoch in whole microseconds, which name its element set', () => {
  assert.equal(
    one(ISS_2008).epoch,
    Date.UTC(2008, 8, 20, 12, 25, 40) * 1000 + 104192,
  );
  // With the Z, without a fraction, or with a longer one cut at microseconds.
  for (const [EPOCH, micros] of [
    ['2008-09-20T12:25:40.104192Z', 104192],
    ['2008-09-20T12:25:40', 0],
    ['2008-09-20T12:25:40.1', 100000],
    ['2008-09-20T12:25:40.1041929', 104192],
  ])
    assert.equal(
      one({ ...ISS_2008, EPOCH }).epoch,
      Date.UTC(2008, 8, 20, 12, 25, 40) * 1000 + micros,
      EPOCH,
    );
});

test('the satrec cache builds an unchanged element set once, and keeps only what a build asked for', () => {
  const cache = createGpSatrecCache();
  const entry = (fields) => one({ ...ISS_2008, ...fields });
  const iss = entry({});
  const css = entry({ NORAD_CAT_ID: '48274' });
  cache.begin();
  const first = cache.satrec(iss);
  const tianhe = cache.satrec(css);
  cache.end();
  assert.ok(first && tianhe && first !== tianhe);
  assert.equal(first.satnum, '25544');
  // The next build: the same rows, read again, give the same satrecs.
  cache.begin();
  assert.equal(cache.satrec(entry({})), first);
  // A new epoch is a new element set.
  const newer = cache.satrec(entry({ EPOCH: '2008-09-21T00:00:00' }));
  assert.ok(newer && newer !== first);
  cache.end();
  // CSS was not asked for: it is gone, and built anew when it comes back.
  cache.begin();
  assert.notEqual(cache.satrec(css), tianhe);
  assert.equal(cache.satrec(entry({ EPOCH: '2008-09-21T00:00:00' })), newer);
  // A build cut short (no end) loses nothing it had for the next.
  cache.begin();
  assert.equal(cache.satrec(entry({ EPOCH: '2008-09-21T00:00:00' })), newer);
  assert.ok(cache.satrec(css));
  // A row SGP4 rejects is never kept, and the earlier satrec of its number
  // is not handed out for it.
  assert.equal(cache.satrec(entry({ MEAN_MOTION: '0' })), null);
  cache.end();
  cache.begin();
  assert.notEqual(cache.satrec(iss), newer);
  assert.notEqual(cache.satrec(iss), first, 'built anew after the reject');
  cache.end();
  // An entry without an epoch is built each time, never kept.
  const bare = { ...iss, epoch: undefined };
  assert.notEqual(cache.satrec(bare), cache.satrec(bare));
  assert.equal(cache.satrec(null), null);
  // Cleared, every satrec is built anew.
  const held = cache.satrec(iss);
  cache.clear();
  cache.begin();
  assert.notEqual(cache.satrec(iss), held);
});

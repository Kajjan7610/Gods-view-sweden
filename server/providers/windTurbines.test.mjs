// The wind turbines route: the bundled snapshot read once, served per view —
// the nearest turbines of the kinds asked for first — and no upstream calls.
import assert from 'node:assert/strict';
import test from 'node:test';

import { WIND_TURBINES_FILE, windTurbinesProxy } from './windTurbines.js';
import {
  PACKED_FIELDS,
  normalizeTurbines,
  packTurbines,
  unpackTurbines,
} from '../../src/layers/windTurbines/records.js';

const row = (VERKID, STATUS, [x, y], extra = {}) => ({
  VERKID,
  STATUS,
  PROJNAMN: 'Vindpark Exempelberget',
  TOTALHOJD: 180,
  MAXEFFEKT: 4.2,
  KOMNAMN: 'Timrå',
  LANSNAMN: 'Västernorrlands län',
  EL_NAMN: 'Sundsvall',
  ORGNAMN: 'Exempel Vind AB',
  ORGNMR: '556677-8899',
  ...extra,
  _xy: [x, y],
});
const ROWS = [
  row('A-1', 'Uppfört', [620000, 6930000]),
  row('A-2', 'Uppfört', [621000, 6930500]),
  row('A-3', 'Beviljat', [620500, 6931000]),
  row('A-4', 'Avslag', [620200, 6930200]),
  // Far to the south: outside the view.
  row('B-1', 'Uppfört', [380000, 6170000]),
];
const SNAPSHOT = {
  source: 'Länsstyrelserna, Vindbrukskollen',
  licence: 'CC0 1.0',
  exported: '2026-11-20',
  built: '2026-11-21',
  updated: '2026-11-02',
  ...packTurbines(
    normalizeTurbines(
      ROWS,
      ROWS.map((r) => r._xy),
    ),
  ),
};

function harness({ files = { [WIND_TURBINES_FILE]: SNAPSHOT } } = {}) {
  let handler;
  const reads = [];
  const fetches = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    fetches.push(args);
    throw new Error('no upstream calls');
  };
  windTurbinesProxy({
    read: async (file) => {
      reads.push(file);
      if (!files[file]) throw new Error(`no ${file}`);
      return JSON.stringify(files[file]);
    },
  }).configureServer({
    middlewares: {
      use: (path, fn) => (
        assert.equal(path, '/api/wind-turbines'),
        (handler = fn)
      ),
    },
  });
  const request = async (url, method = 'GET') => {
    const res = {
      destroyed: false,
      writeHead(code) {
        this.status = code;
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ method, url, headers: {} }, res);
    return { status: res.status, json: JSON.parse(res.body) };
  };
  const restore = () => (globalThis.fetch = realFetch);
  return { request, reads, fetches, files, restore };
}

const view = (bbox, center, extra = '') =>
  `/?bbox=${bbox.join(',')}&center=${center.join(',')}${extra}`;
const TIMRA = view([16.5, 61.5, 18.5, 63], [17.3, 62.45]);

test('a view gets its built turbines nearest first, and every kind counted', async (t) => {
  const { request, reads, fetches, restore } = harness();
  t.after(restore);
  const { status, json } = await request(TIMRA);
  assert.equal(status, 200);
  assert.equal(json.tooWide, false);
  assert.equal(json.capped, false);
  assert.equal(json.stale, false);
  assert.equal(json.fetchedAt, Date.parse('2026-11-20'), 'the export date');
  assert.equal(json.updated, '2026-11-02');
  assert.equal(json.total, 2);
  assert.equal(json.builtMW, 8.4, 'the built ones only');
  assert.deepEqual(json.counts, {
    built: 2,
    planned: 1,
    dismantled: 0,
    rejected: 1,
    withdrawn: 0,
    unknown: 0,
  });
  // Compact rows, nearest first: no card fields, no empty ones.
  assert.deepEqual(
    json.turbines.map(({ i, s }) => [i, s]),
    [
      ['A-1', 0],
      ['A-2', 0],
    ],
  );
  assert.deepEqual(Object.keys(json.turbines[0]).sort(), [
    'c',
    'h',
    'i',
    'n',
    'p',
    's',
    'w',
  ]);
  assert.equal(json.turbines[0].h, 180);
  assert.equal(json.turbines[0].c, 'Timrå');
  // A second view reads nothing again, and nobody upstream is ever asked.
  await request(view([16.6, 61.6, 18.4, 62.9], [17.3, 62.4]));
  assert.equal(reads.length, 1);
  assert.equal(fetches.length, 0);
});

test('the kinds asked for are drawn, unknown kinds fall back to built', async (t) => {
  const { request, restore } = harness();
  t.after(restore);
  const both = await request(`${TIMRA}&kinds=built,planned,rejected`);
  assert.deepEqual(both.json.turbines.map(({ i }) => i).sort(), [
    'A-1',
    'A-2',
    'A-3',
    'A-4',
  ]);
  const nonsense = await request(`${TIMRA}&kinds=everything`);
  assert.equal(nonsense.json.total, 2);
});

test('a small limit keeps the nearest and marks the view capped', async (t) => {
  const { request, restore } = harness();
  t.after(restore);
  const { json } = await request(`${TIMRA}&limit=1`);
  assert.equal(json.turbines.length, 1);
  assert.equal(json.turbines[0].i, 'A-1');
  assert.equal(json.capped, true);
});

test('one turbine’s full row comes from the detail route', async (t) => {
  const { request, reads, fetches, restore } = harness();
  t.after(restore);
  const { status, json } = await request('/turbine?id=A-1');
  assert.equal(status, 200);
  assert.equal(json.fetchedAt, Date.parse('2026-11-20'));
  assert.equal(json.turbine.id, 'A-1');
  assert.equal(json.turbine.operator, 'Exempel Vind AB');
  assert.equal(json.turbine.zone, 'SE2');
  assert.equal((await request('/turbine?id=nope')).status, 404);
  assert.equal((await request('/turbine?id=a%20b')).status, 400);
  assert.equal((await request('/turbine')).status, 400);
  assert.equal(reads.length, 1);
  assert.equal(fetches.length, 0);
});

test('a missing snapshot is a 502, and is read again by the next view', async (t) => {
  const { request, reads, files, restore } = harness({ files: {} });
  t.after(restore);
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.equal((await request(TIMRA)).status, 502);
  } finally {
    console.warn = warn;
  }
  files[WIND_TURBINES_FILE] = SNAPSHOT;
  assert.equal((await request(TIMRA)).status, 200);
  assert.equal(reads.length, 2);
});

test('a wide view reads nothing, and a bad request is refused', async (t) => {
  const { request, reads, restore } = harness();
  t.after(restore);
  const wide = await request(view([10, 55, 24, 69], [17, 62]));
  assert.equal(wide.json.tooWide, true);
  assert.equal(reads.length, 0);
  assert.equal((await request('/?bbox=1,2,3')).status, 400);
  assert.equal(
    (await request(view([18, 62, 17, 63], [17.5, 62.5]))).status,
    400,
  );
  assert.equal((await request('/other')).status, 404);
  assert.equal((await request(TIMRA, 'POST')).status, 405);
});

test('the bundled snapshot holds what the build promises, and no more', async () => {
  const { readFile, stat } = await import('node:fs/promises');
  const raw = await readFile(WIND_TURBINES_FILE, 'utf8');
  const file = JSON.parse(raw);
  assert.equal(file.source, 'Länsstyrelserna, Vindbrukskollen');
  assert.equal(file.licence, 'CC0 1.0');
  assert.match(file.exported, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(file.fields, PACKED_FIELDS);
  const rows = unpackTurbines(file);
  assert.ok(rows.length > 10_000);
  assert.ok(rows.filter((r) => r.kind === 'built').length > 4000);
  assert.ok(
    rows.every(
      (r) =>
        r.point[0] > 9 &&
        r.point[0] < 25 &&
        r.point[1] > 54.5 &&
        r.point[1] < 69.5,
    ),
    'every turbine in Sweden',
  );
  // No organisation numbers, personal or not, and no permit-case words.
  assert.doesNotMatch(raw, /\b\d{6}-\d{4}\b/);
  assert.doesNotMatch(raw, /\b\d{6}-xxxx\b/i);
  assert.doesNotMatch(
    raw,
    /miljöbalken|Plan och bygglagen|Privatperson|ej registrerad/,
  );
  // No metering-point ids or property designations in any text.
  assert.ok(
    file.strings.every((s) => !/\d{8,}/.test(s) && !/\b\d+:\d+\b/.test(s)),
  );
  // A build year only on built and dismantled turbines.
  assert.ok(
    rows.every(
      (r) => !r.built || r.kind === 'built' || r.kind === 'dismantled',
    ),
  );
  const size = (await stat(WIND_TURBINES_FILE)).size;
  assert.ok(size < 3 * 1024 * 1024, `the snapshot stays small (${size} bytes)`);
});

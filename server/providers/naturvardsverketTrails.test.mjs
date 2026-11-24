// The trails route: the bundled snapshot read once, served per view —
// nearest facilities first, trails cut to the view — and no upstream calls.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FACILITIES_FILE,
  TRAILS_FILE,
  naturvardsverketTrailsProxy,
} from './naturvardsverketTrails.js';
import {
  OUTDOOR_MAX_SPAN_DEG,
  clipOutdoorBox,
  decodeLine,
  encodeLine,
} from '../../src/layers/outdoorTrails/records.js';
import { clipViewBox } from '../../src/layers/shelters/records.js';

const FACILITIES = {
  source: 'Naturvårdsverket',
  built: '2026-11-19',
  facilities: [
    {
      i: '1',
      p: [18.27, 59.176],
      n: 'Vindskydd',
      t: 'Vindskydd',
      k: 'shelter',
      a: 'Tyresta',
    },
    { i: '3', p: [18.21, 59.16], t: 'Dass', k: 'toilet', x: 1 },
    { i: '4', p: [18.6, 59.3], t: 'Dass', k: 'toilet' },
  ],
};
const line = [
  [18.25, 59.17],
  [18.28, 59.175],
  [18.31, 59.18],
];
const TRAILS = {
  source: 'Naturvårdsverket',
  built: '2026-11-19',
  trails: [
    {
      i: 'l10',
      n: 'Led 10',
      t: 'Vandringsled',
      k: 'hike',
      s: 1,
      l: 9.2,
      b: [18.25, 59.17, 18.31, 59.18],
      g: [encodeLine(line)],
    },
    {
      i: 'l11',
      n: 'Långt bort',
      k: 'ski',
      b: [20, 67, 20.1, 67.1],
      g: [
        encodeLine([
          [20, 67],
          [20.1, 67.1],
        ]),
      ],
    },
  ],
};

function harness({
  files = { [FACILITIES_FILE]: FACILITIES, [TRAILS_FILE]: TRAILS },
} = {}) {
  let handler;
  const reads = [];
  const fetches = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    fetches.push(args);
    throw new Error('no upstream calls');
  };
  naturvardsverketTrailsProxy({
    read: async (file) => {
      reads.push(file);
      if (!files[file]) throw new Error(`no ${file}`);
      return JSON.stringify(files[file]);
    },
  }).configureServer({
    middlewares: {
      use: (path, fn) => (
        assert.equal(path, '/api/outdoor-trails'),
        (handler = fn)
      ),
    },
  });
  const request = async (url) => {
    const res = {
      destroyed: false,
      writeHead(code) {
        this.status = code;
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ method: 'GET', url, headers: {} }, res);
    return { status: res.status, json: JSON.parse(res.body) };
  };
  const restore = () => (globalThis.fetch = realFetch);
  return { request, reads, fetches, files, restore };
}

const view = (bbox, center, extra = '') =>
  `/?bbox=${bbox.join(',')}&center=${center.join(',')}${extra}`;
const TYRESTA = view([18.2, 59.15, 18.35, 59.2], [18.27, 59.175]);

test('a view gets its facilities nearest first and its trails cut and encoded', async (t) => {
  const { request, reads, fetches, restore } = harness();
  t.after(restore);
  const { status, json } = await request(TYRESTA);
  assert.equal(status, 200);
  assert.equal(json.tooWide, false);
  assert.equal(json.capped, false);
  assert.equal(json.stale, false);
  assert.equal(json.fetchedAt, Date.parse('2026-11-19'), 'the build date');
  assert.equal(json.facilityTotal, 2, 'nothing outside the view');
  assert.deepEqual(
    json.facilities.map(({ id, kind, accessible }) => [id, kind, accessible]),
    [
      ['1', 'shelter', false],
      ['3', 'toilet', true],
    ],
  );
  assert.equal(json.facilities[0].area, 'Tyresta');
  assert.ok(json.facilities[0].distance < json.facilities[1].distance);
  assert.equal(json.trailTotal, 1);
  const [led] = json.trails;
  assert.equal(led.name, 'Led 10');
  assert.equal(led.stateTrail, true);
  assert.equal(led.lengthKm, 9.2);
  assert.deepEqual(decodeLine(led.lines[0])[0], [18.25, 59.17]);
  assert.ok(Array.isArray(led.anchor));
  // A second view reads nothing again, and nobody upstream is ever asked.
  await request(view([18.21, 59.14, 18.34, 59.19], [18.28, 59.16]));
  assert.equal(reads.length, 2);
  assert.equal(fetches.length, 0);
});

test('a small limit keeps the nearest and marks the view capped', async (t) => {
  const { request, restore } = harness();
  t.after(restore);
  const { json } = await request(
    view([18.2, 59.15, 18.35, 59.2], [18.27, 59.175], '&limit=1'),
  );
  assert.equal(json.facilities.length, 1);
  assert.equal(json.facilities[0].id, '1');
  assert.equal(json.capped, true);
});

test('a missing snapshot is a 502, and is read again by the next view', async (t) => {
  const { request, reads, files, restore } = harness({ files: {} });
  t.after(restore);
  assert.equal((await request(TYRESTA)).status, 502);
  files[FACILITIES_FILE] = FACILITIES;
  files[TRAILS_FILE] = TRAILS;
  assert.equal((await request(TYRESTA)).status, 200);
  assert.equal(reads.length, 4);
});

test('a wide view reads nothing, and a bad box is refused', async (t) => {
  const { request, reads, restore } = harness();
  t.after(restore);
  const wide = await request(view([17, 59, 18.5, 59.3], [17.75, 59.1]));
  assert.equal(wide.json.tooWide, true);
  assert.equal(reads.length, 0);
  assert.equal((await request('/?bbox=1,2,3')).status, 400);
  assert.equal(
    (await request(view([18, 59, 17, 60], [17.5, 59.5]))).status,
    400,
  );
  assert.equal((await request('/other')).status, 404);
});

test('the bundled snapshot holds what the build promises', async () => {
  const { readFile, stat } = await import('node:fs/promises');
  const facilities = JSON.parse(await readFile(FACILITIES_FILE, 'utf8'));
  const trails = JSON.parse(await readFile(TRAILS_FILE, 'utf8'));
  assert.equal(facilities.source, 'Naturvårdsverket');
  assert.ok(facilities.facilities.length > 15_000);
  assert.ok(trails.trails.length > 3000);
  assert.ok(
    !facilities.facilities.some((row) => /bostad/i.test(`${row.t} ${row.u}`)),
    'no residences',
  );
  const size =
    (await stat(FACILITIES_FILE)).size + (await stat(TRAILS_FILE)).size;
  assert.ok(size < 8 * 1024 * 1024, `the snapshot stays small (${size} bytes)`);
});

test('a view over Åre from 30 km finds Tännforsen in the bundled snapshot', async (t) => {
  // The route as the app runs it: the bundled files, and nobody upstream.
  const fetches = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    fetches.push(args);
    throw new Error('no upstream calls');
  };
  t.after(() => (globalThis.fetch = realFetch));
  t.mock.method(console, 'log', () => {});
  let handler;
  naturvardsverketTrailsProxy().configureServer({
    middlewares: { use: (_path, fn) => (handler = fn) },
  });
  const request = async (url) => {
    const res = {
      destroyed: false,
      writeHead(code) {
        this.status = code;
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ method: 'GET', url, headers: {} }, res);
    return { status: res.status, json: JSON.parse(res.body) };
  };
  // A 60° view straight down from 30 km over Åre: 34.6 km across, 0.70° of
  // longitude at 63.4° N, and 9/16 of that from south to north.
  const centre = [13.08, 63.4];
  const screen = [12.73, 63.31, 13.43, 63.49];
  const bbox = clipOutdoorBox(screen, centre);
  assert.ok(OUTDOOR_MAX_SPAN_DEG >= 0.9);
  assert.deepEqual(bbox, screen, 'the whole view is asked');
  const { status, json } = await request(view(bbox, centre));
  assert.equal(status, 200);
  assert.equal(json.tooWide, false);
  // Tännforsen's and Hammarberget's facilities, 17 km west of the village,
  // and the trail at the falls.
  assert.ok(json.facilityTotal >= 10, `${json.facilityTotal} facilities`);
  assert.ok(json.facilities.some((row) => row.area === 'Tännforsen'));
  assert.ok(json.trailTotal >= 1);
  assert.ok(json.trails.every((row) => row.lines.length > 0));
  // The box of 0.4° a side the layer asked for before held none of it.
  const before = clipViewBox(screen, centre, 0.4);
  const old = await request(view(before, centre));
  assert.equal(old.json.facilityTotal + old.json.trailTotal, 0);
  assert.equal(fetches.length, 0);
});

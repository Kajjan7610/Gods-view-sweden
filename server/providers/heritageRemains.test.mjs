import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RAA_BUILDINGS_URL,
  RAA_PROTECTION_AREAS_URL,
  RAA_REMAINS_URL,
  RAA_WORLD_HERITAGE_URL,
  REMAINS_RETRY_AFTER_FAILURE_MS,
  UPSTREAM_LIMIT,
  heritageRemainsProxy,
} from './heritageRemains.js';

const point = (id, lon, lat, assessment = 'Fornlämning') => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: {
    pk_id: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    url: `https://pub.raa.se/visa/objekt/lamning/10000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    lamningstyp: 'Gravfält',
    lamningsnummer: `L1:${id}`,
    kommun: 'Västerås',
    antikvariskbedomning: assessment,
    aktualitetstatus: 'Bekräftad i fält',
  },
});

function harness({ features = [], status = 200, matched } = {}) {
  let handler;
  let clock = Date.parse('2026-11-12T20:00:00Z');
  const calls = [];
  heritageRemainsProxy({
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (status !== 200)
        return { ok: false, status, body: { cancel: async () => {} } };
      // `features` may answer by URL: each collection its own.
      const list = typeof features === 'function' ? features(url) : features;
      const body = JSON.stringify({
        type: 'FeatureCollection',
        numberMatched: matched ?? list.length,
        features: list,
      });
      return new Response(body, { status: 200 });
    },
    now: () => clock,
  }).configureServer({
    middlewares: { use: (path, fn) => (assert.equal(path, '/api/heritage-remains'), (handler = fn)) },
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
    await handler({ method: 'GET', url, headers: {}, socket: { remoteAddress: '127.0.0.1' } }, res);
    return { status: res.status, json: JSON.parse(res.body) };
  };
  return { request, calls, advance: (ms) => (clock += ms) };
}

const view = (bbox, center) => `/?bbox=${bbox.join(',')}&center=${center.join(',')}`;
const VASTERAS = view([16.481, 59.581, 16.619, 59.639], [16.5448, 59.6105]);

test('a view asks RAÄ once for its grid box and answers nearby views from memory', async () => {
  const { request, calls } = harness({
    features: [point(1, 16.545, 59.611), point(2, 16.6, 59.62, 'Möjlig fornlämning'), point(3, 17.5, 59.9)],
  });
  const first = await request(VASTERAS);
  assert.equal(first.status, 200);
  assert.equal(first.json.total, 2, 'only the remains inside the view');
  assert.deepEqual(first.json.remains.map(({ number }) => number), ['L1:1', 'L1:2']);
  assert.equal(first.json.capped, false);
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(`${url.origin}${url.pathname}`, RAA_REMAINS_URL);
  assert.equal(url.searchParams.get('bbox'), '16.48,59.58,16.62,59.64');
  assert.equal(url.searchParams.get('limit'), String(UPSTREAM_LIMIT));
  assert.match(calls[0].init.headers['User-Agent'], /GodsEyeViewSverige/);
  // A view a little to the side falls in the same grid box.
  await request(view([16.49, 59.585, 16.61, 59.635], [16.55, 59.61]));
  assert.equal(calls.length, 1);
});

test('a box RAÄ fills to the limit is marked capped', async () => {
  const { request } = harness({ features: [point(1, 16.545, 59.611)], matched: 9000 });
  assert.equal((await request(VASTERAS)).json.capped, true);
});

test('a wide view asks nobody, and a bad box is refused', async () => {
  const { request, calls } = harness();
  const wide = await request(view([10, 55, 24, 69], [16, 62]));
  assert.equal(wide.status, 200);
  assert.equal(wide.json.tooWide, true);
  assert.equal(calls.length, 0);
  for (const url of ['/', '/?bbox=1,2,3&center=1,2', view([16.6, 59.6, 16.5, 59.7], [16.5, 59.6])])
    assert.equal((await request(url)).status, 400, url);
});

test('a failed request answers 502 and leaves RAÄ alone for a while', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const { request, calls, advance } = harness({ status: 503 });
  assert.equal((await request(VASTERAS)).status, 502);
  assert.equal((await request(view([17.55, 59.83, 17.7, 59.92], [17.62, 59.875]))).status, 502);
  assert.equal(calls.length, 1, 'paused after the failure');
  advance(REMAINS_RETRY_AFTER_FAILURE_MS + 1);
  await request(VASTERAS);
  assert.equal(calls.length, 2);
});

const box = (lon, lat, d = 0.001) => [
  [
    [lon, lat],
    [lon + d, lat],
    [lon + d, lat + d],
    [lon, lat + d],
    [lon, lat],
  ],
];
const inventoried = (n, skyddstyp_namn) => ({
  type: 'Feature',
  geometry: { type: 'MultiPolygon', coordinates: [box(16.546, 59.612)] },
  properties: {
    id: `b0000000-0000-4000-8000-00000000000${n}`,
    namn: `Hus ${n}`,
    skyddstyp_namn,
    registerbyggnad_id: '403443fc-6850-4f13-ae0e-c12208ea29e4',
    kommunnamn: 'Västerås',
    url: `https://pub.raa.se/visa/objekt/bebyggelse/b0000000-0000-4000-8000-00000000000${n}`,
  },
});
const protectionArea = {
  type: 'Feature',
  geometry: { type: 'MultiPolygon', coordinates: [box(16.54, 59.61, 0.002)] },
  properties: {
    id: 'a1',
    namn: 'Västerås slott',
    skyddstyp_namn: 'Statligt byggnadsminne',
    havt_skydd: false,
  },
};
const byCollection = (url) =>
  url.startsWith(RAA_BUILDINGS_URL)
    ? [
        inventoried(1, 'Byggnadsminne'),
        // Even were RAÄ to ignore the filter, a private home goes no further.
        inventoried(2, 'Identifierat kulturvärde'),
      ]
    : url.startsWith(RAA_PROTECTION_AREAS_URL)
      ? [protectionArea]
      : url.startsWith(RAA_WORLD_HERITAGE_URL)
        ? [
            {
              type: 'Feature',
              geometry: { type: 'MultiPolygon', coordinates: [box(15.98, 59.97, 0.02)] },
              properties: {
                id: 'se-556',
                sitename_sve: 'Engelsbergs bruk',
                sitename_eng: 'Engelsberg Ironworks',
                legalfoundationyear: 1993,
                unesco_href: 'https://whc.unesco.org/en/list/556',
              },
            },
          ]
        : [];
const BUILDINGS = (bbox, center) =>
  `/buildings?bbox=${bbox.join(',')}&center=${center.join(',')}`;

test('a view asks each building collection once, the inventory for protected buildings only', async () => {
  const { request, calls } = harness({ features: byCollection });
  const first = await request(BUILDINGS([16.481, 59.581, 16.619, 59.639], [16.5448, 59.6105]));
  assert.equal(first.status, 200);
  assert.equal(calls.length, 2, 'one request per collection');
  const urls = calls.map(({ url }) => new URL(url));
  const inventory = urls.find((url) => `${url.origin}${url.pathname}` === RAA_BUILDINGS_URL);
  const areas = urls.find((url) => `${url.origin}${url.pathname}` === RAA_PROTECTION_AREAS_URL);
  assert.equal(inventory.searchParams.get('filter-lang'), 'cql2-text');
  assert.equal(
    inventory.searchParams.get('filter'),
    "skyddstyp_namn = 'Byggnadsminne' OR skyddstyp_namn = 'Statligt byggnadsminne' OR skyddstyp_namn = 'Kyrkligt kulturminne'",
  );
  assert.equal(inventory.searchParams.get('bbox'), '16.48,59.58,16.62,59.64');
  assert.equal(inventory.searchParams.get('limit'), String(UPSTREAM_LIMIT));
  assert.equal(areas.searchParams.get('bbox'), '16.48,59.58,16.62,59.64');
  assert.deepEqual(first.json.buildings.map(({ name }) => name), ['Hus 1']);
  assert.equal(first.json.total, 1);
  assert.deepEqual(first.json.areas.map(({ name }) => name), ['Västerås slott']);
  assert.ok(!JSON.stringify(first.json).includes('403443fc'), 'no register building id');
  // A view a little to the side is answered from memory.
  await request(BUILDINGS([16.49, 59.585, 16.61, 59.635], [16.55, 59.61]));
  assert.equal(calls.length, 2);
});

test('a wide buildings view asks nobody; a failure answers 502 without pausing the remains', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const wide = harness({ features: byCollection });
  const answer = await wide.request(BUILDINGS([10, 55, 24, 69], [16, 62]));
  assert.equal(answer.json.tooWide, true);
  assert.equal(wide.calls.length, 0);
  assert.equal((await wide.request('/buildings?bbox=1,2')).status, 400);
  const failing = harness({ status: 503 });
  assert.equal((await failing.request(BUILDINGS([16.481, 59.581, 16.619, 59.639], [16.5448, 59.6105]))).status, 502);
  assert.equal(failing.calls.length, 2);
  await failing.request(VASTERAS);
  assert.equal(failing.calls.length, 3, 'the remains are asked all the same');
});

test('the World Heritage sites are read once and kept', async () => {
  const { request, calls } = harness({ features: byCollection });
  const first = await request('/world-heritage');
  assert.equal(first.status, 200);
  assert.deepEqual(first.json.sites.map(({ nameEn, inscribed }) => [nameEn, inscribed]), [
    ['Engelsberg Ironworks', 1993],
  ]);
  await request('/world-heritage');
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(`${url.origin}${url.pathname}`, RAA_WORLD_HERITAGE_URL);
  assert.equal(url.searchParams.get('bbox'), null);
  assert.equal((await request('/nothing-here')).status, 404);
});

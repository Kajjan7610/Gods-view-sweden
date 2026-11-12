import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RAA_REMAINS_URL,
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
      const body = JSON.stringify({
        type: 'FeatureCollection',
        numberMatched: matched ?? features.length,
        features,
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

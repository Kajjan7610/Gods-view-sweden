// The EMSC route: one day in the Nordic box, earthquakes only, kept five
// minutes and never served older than the EMSC's ten.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  EMSC_EVENTS_URL,
  emscNordicProxy,
  emscQueryUrl,
  normalizeEmscEvents,
} from './emscNordic.js';

const feature = (properties) => ({
  type: 'Feature',
  id: properties.unid,
  geometry: { type: 'Point', coordinates: [properties.lon, properties.lat] },
  properties: {
    time: '2026-11-19T03:12:45.1Z',
    lat: 59.1,
    lon: 15.2,
    depth: 9,
    mag: 1.4,
    magtype: 'ml',
    auth: 'UPP',
    flynn_region: 'SOUTHERN SWEDEN',
    evtype: 'ke',
    ...properties,
  },
});
const ANSWER = {
  type: 'FeatureCollection',
  features: [
    feature({ unid: 'a' }),
    feature({ unid: 'b', evtype: 'km', flynn_region: 'NORTHERN SWEDEN' }),
    feature({ unid: 'c', evtype: '' }),
    feature({
      unid: 'd',
      evtype: 'fe',
      time: '2026-11-19T05:00:00Z',
      flynn_region: 'NORWAY-SWEDEN BORDER REG.',
    }),
  ],
};

test('the query asks for one day in the Nordic box, newest first', () => {
  const url = new URL(emscQueryUrl(Date.parse('2026-11-19T12:00:00Z')));
  assert.equal(`${url.origin}${url.pathname}`, EMSC_EVENTS_URL);
  assert.equal(url.searchParams.get('starttime'), '2026-11-18T12:00:00');
  assert.equal(url.searchParams.get('minlat'), '54');
  assert.equal(url.searchParams.get('maxlon'), '33');
  assert.equal(url.searchParams.get('format'), 'json');
});

test('earthquakes only: mining blasts and untyped events are left out', () => {
  const events = normalizeEmscEvents(ANSWER);
  assert.deepEqual(
    events.map(({ id, region, magType, auth }) => [id, region, magType, auth]),
    [
      ['d', 'Norway-Sweden Border Reg.', 'ML', 'UPP'],
      ['a', 'Southern Sweden', 'ML', 'UPP'],
    ],
  );
  assert.equal(events[1].depthKm, 9);
  assert.equal(events[1].time, Date.parse('2026-11-19T03:12:45.1Z'));
  assert.equal(normalizeEmscEvents({}), null);
});

async function call(plugin) {
  let handler;
  plugin.configureServer({
    middlewares: { use: (_path, fn) => (handler = fn) },
  });
  return new Promise((resolve) => {
    const res = {
      destroyed: false,
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        resolve({ status: this.status, body: JSON.parse(body) });
      },
    };
    handler(
      { method: 'GET', url: '/', headers: { 'sec-fetch-site': 'same-origin' } },
      res,
      () => resolve({ status: 404 }),
    );
  });
}

test('kept five minutes; a failure serves the last answer only within ten', async () => {
  let clock = Date.parse('2026-11-19T12:00:00Z');
  let calls = 0;
  let down = false;
  const proxy = emscNordicProxy({
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      return down
        ? new Response('', { status: 503 })
        : new Response(JSON.stringify(ANSWER));
    },
  });
  const first = await call(proxy);
  assert.equal(first.status, 200);
  assert.equal(first.body.events.length, 2);
  clock += 4 * 60_000;
  await proxy.read();
  assert.equal(calls, 1, 'within five minutes nothing is asked');
  clock += 2 * 60_000;
  down = true;
  const stale = await proxy.read();
  assert.equal(stale.stale, true);
  // Past ten minutes the old answer is no longer served.
  clock += 5 * 60_000;
  assert.equal((await call(proxy)).status, 502);
});

test('a quiet day is an empty list, not a failure', async () => {
  const proxy = emscNordicProxy({
    fetchImpl: async () => new Response(null, { status: 204 }),
  });
  const answer = await call(proxy);
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.events, []);
});

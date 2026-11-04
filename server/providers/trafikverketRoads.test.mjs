import assert from 'node:assert/strict';
import test from 'node:test';

import {
  trafikverketRoadsProxy,
  trafikverketRoadsQuery,
} from './trafikverketRoads.js';

const PAYLOAD = {
  RESPONSE: {
    RESULT: [
      {
        RoadCondition: [
          {
            Id: 'RC-1',
            ConditionCode: 2,
            ConditionText: 'Besvärligt (risk för)',
            Geometry: { WGS84: 'LINESTRING (17 59, 17.1 59.1)' },
          },
        ],
      },
      {
        Situation: [
          {
            Id: 'S1',
            Deviation: [
              {
                Id: 'D1',
                MessageType: 'Vägarbete',
                StartTime: '2026-01-01T00:00:00Z',
                ValidUntilFurtherNotice: true,
                Geometry: { Point: { WGS84: 'POINT (18 59.3)' } },
              },
            ],
          },
        ],
      },
    ],
  },
};

/** Drive the plugin's middleware with a minimal req/res pair. */
function harness(options) {
  let handler;
  const plugin = trafikverketRoadsProxy(options);
  plugin.configureServer({
    middlewares: { use: (_path, fn) => (handler = fn) },
  });
  return async (method = 'GET', url = '/') => {
    const res = {
      destroyed: false,
      status: 0,
      headers: {},
      body: '',
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ method, url, headers: {}, socket: {} }, res);
    return { ...res, json: () => JSON.parse(res.body) };
  };
}

test('the query asks for both object types and escapes the key', () => {
  const body = trafikverketRoadsQuery('k"<&');
  assert.match(body, /authenticationkey="k&quot;&lt;&amp;"/);
  assert.match(
    body,
    /objecttype="RoadCondition" namespace="Road.TrafficInfo" schemaversion="1.3"/,
  );
  assert.match(
    body,
    /objecttype="Situation" namespace="Road.TrafficInfo" schemaversion="1.6"/,
  );
  assert.match(body, /<INCLUDE>Deviation.Geometry.Point.WGS84<\/INCLUDE>/);
});

test('without a key the route answers not_configured and never fetches', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  const request = harness({
    env: {},
    fetchImpl: async () => {
      calls++;
      return Response.json(PAYLOAD);
    },
  });
  const response = await request();
  assert.equal(response.status, 503);
  assert.equal(response.json().error, 'not_configured');
  assert.equal(calls, 0);
});

test('with a key one POST serves normalized rows, then the cache', async (t) => {
  t.mock.method(console, 'log', () => {});
  const calls = [];
  let clock = Date.parse('2026-11-04T08:00:00Z');
  const request = harness({
    env: { TRAFIKVERKET_API_KEY: 'secret-key' },
    now: () => clock,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json(PAYLOAD);
    },
  });
  const first = await request();
  assert.equal(first.status, 200);
  const body = first.json();
  assert.equal(body.conditions.length, 1);
  assert.equal(body.incidents[0].kind, 'roadwork');
  assert.equal(first.body.includes('secret-key'), false);
  assert.equal(calls[0].init.method, 'POST');
  assert.match(calls[0].init.body, /authenticationkey="secret-key"/);
  clock += 60_000;
  await request();
  assert.equal(calls.length, 1, 'served from the 3-minute cache');
  assert.equal((await request('POST')).status, 405);
  assert.equal((await request('GET', '/other')).status, 404);
});

test('a failed refresh serves the last snapshot marked stale, without the key in logs', async (t) => {
  const lines = [];
  t.mock.method(console, 'warn', (...args) => lines.push(args.join(' ')));
  t.mock.method(console, 'log', () => {});
  let clock = Date.parse('2026-11-04T08:00:00Z');
  let fail = false;
  const request = harness({
    env: { TRAFIKVERKET_API_KEY: 'secret-key' },
    now: () => clock,
    fetchImpl: async () =>
      fail ? new Response('down', { status: 500 }) : Response.json(PAYLOAD),
  });
  await request();
  fail = true;
  clock += 4 * 60_000;
  const stale = await request();
  assert.equal(stale.status, 200);
  assert.equal(stale.json().stale, true);
  clock += 2 * 60 * 60_000;
  const gone = await request();
  assert.equal(gone.status, 502);
  assert.equal(
    lines.some((line) => line.includes('secret-key')),
    false,
  );
});

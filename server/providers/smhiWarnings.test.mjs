import assert from 'node:assert/strict';
import test from 'node:test';

import { SMHI_WARNINGS_URL, smhiWarningsProxy } from './smhiWarnings.js';

const PAYLOAD = [
  {
    id: 3388,
    event: { sv: 'Vind', en: 'Wind', code: 'WIND' },
    warningAreas: [
      {
        id: 10731,
        approximateStart: '2026-11-04T11:00:00Z',
        approximateEnd: '2026-11-05T00:00:00Z',
        warningLevel: { code: 'YELLOW' },
        areaName: { sv: 'Fjälltrakterna', en: 'The mountain regions' },
        area: {
          type: 'Feature',
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [18, 67],
                [19, 67],
                [19, 68],
                [18, 67],
              ],
            ],
          },
        },
      },
    ],
  },
];

/** Drive the plugin's middleware with a minimal req/res pair. */
function harness(options) {
  let route;
  let handler;
  const plugin = smhiWarningsProxy(options);
  plugin.configureServer({
    middlewares: { use: (path, fn) => ((route = path), (handler = fn)) },
  });
  const request = async (method = 'GET', url = '/') => {
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
  return Object.assign(request, { route: () => route });
}

test('one GET serves normalized warning areas, then the 5-minute cache', async (t) => {
  t.mock.method(console, 'log', () => {});
  const calls = [];
  let clock = Date.parse('2026-11-04T17:00:00Z');
  const request = harness({
    now: () => clock,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return Response.json(PAYLOAD);
    },
  });
  assert.equal(request.route(), '/api/smhi-warnings');
  const first = await request();
  assert.equal(first.status, 200);
  const [area] = first.json().areas;
  assert.equal(area.id, '3388:10731');
  assert.equal(area.level, 'YELLOW');
  assert.equal(calls[0].url, SMHI_WARNINGS_URL);
  clock += 4 * 60_000;
  await request();
  assert.equal(calls.length, 3, 'served from the cache (SMHI, VMAs, news)');
  clock += 2 * 60_000;
  await request();
  assert.equal(calls.length, 6, 'refreshed after 5 minutes');
  assert.equal((await request('POST')).status, 405);
  assert.equal((await request('GET', '/other')).status, 404);
});

test('a failed refresh serves the last snapshot marked stale, then gives up', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  let clock = Date.parse('2026-11-04T17:00:00Z');
  let fail = false;
  const request = harness({
    now: () => clock,
    fetchImpl: async () =>
      fail ? new Response('down', { status: 503 }) : Response.json(PAYLOAD),
  });
  await request();
  fail = true;
  clock += 6 * 60_000;
  const stale = await request();
  assert.equal(stale.status, 200);
  assert.equal(stale.json().stale, true);
  clock += 2 * 60 * 60_000;
  const gone = await request();
  assert.equal(gone.status, 502);
  assert.equal(gone.json().error, 'smhi_warnings_unavailable');
});

test('Krisinformation rides along, and its failure leaves the warnings serving', async (t) => {
  t.mock.method(console, 'log', () => {});
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  let clock = Date.parse('2026-11-04T17:00:00Z');
  let crisisDown = false;
  const request = harness({
    now: () => clock,
    fetchImpl: async (url) => {
      if (String(url).includes('krisinformation')) {
        if (crisisDown) return new Response('down', { status: 503 });
        return Response.json(
          String(url).includes('/vmas')
            ? []
            : [
                {
                  identifier: '1238',
                  headline: 'Cyberangrepp',
                  published: '2026-11-03T12:33:06+01:00',
                  area: [{ type: 'Country', description: 'Sverige' }],
                },
              ],
        );
      }
      return Response.json(PAYLOAD);
    },
  });
  const first = (await request()).json();
  assert.equal(first.areas.length, 1);
  assert.deepEqual(
    first.crisis.map((row) => [row.id, row.scope]),
    [['news:1238', 'country']],
  );
  crisisDown = true;
  clock += 6 * 60_000;
  const second = (await request()).json();
  assert.equal(second.areas.length, 1, 'warnings unaffected');
  assert.equal(second.crisis.length, 1, 'last crisis list kept');
  assert.equal(second.crisisStale, true);
  assert.ok(warnings.some((line) => line.includes('krisinformation')));
});

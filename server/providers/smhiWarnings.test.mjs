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

test('after a failed refresh SMHI is left alone for a minute', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  let clock = Date.parse('2026-11-04T17:00:00Z');
  let fail = false;
  let calls = 0;
  const request = harness({
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      return fail
        ? new Response('down', { status: 503 })
        : Response.json(PAYLOAD);
    },
  });
  await request();
  assert.equal(calls, 3);
  fail = true;
  clock += 6 * 60_000;
  const first = await request();
  assert.equal(first.json().stale, true);
  assert.equal(first.headers['X-Data-Stale'], 'true');
  assert.equal(calls, 6);
  // Within the minute: the last snapshot again, nobody asked.
  clock += 30_000;
  for (let i = 0; i < 3; i += 1)
    assert.equal((await request()).json().stale, true);
  assert.equal(calls, 6);
  // After it, asked once more; and once SMHI answers, fresh again.
  clock += 31_000;
  fail = false;
  const back = await request();
  assert.equal(calls, 9);
  assert.equal(back.json().stale, undefined);
  assert.equal(back.headers['X-Data-Stale'], undefined);
});

test('without any snapshot a failed refresh is a 502, also during the pause', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  const request = harness({
    now: () => Date.parse('2026-11-04T17:00:00Z'),
    fetchImpl: async () => {
      calls += 1;
      return new Response('down', { status: 503 });
    },
  });
  assert.equal((await request()).status, 502);
  const paused = await request();
  assert.equal(paused.status, 502);
  assert.equal(paused.json().error, 'smhi_warnings_unavailable');
  assert.equal(calls, 3);
});

test('while Krisinformation fails its last list is kept for an hour, no longer', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  let clock = Date.parse('2026-11-04T17:00:00Z');
  let crisisDown = false;
  const request = harness({
    now: () => clock,
    fetchImpl: async (url) => {
      if (!String(url).includes('krisinformation'))
        return Response.json(PAYLOAD);
      if (crisisDown) return new Response('down', { status: 503 });
      return Response.json(
        String(url).includes('/vmas')
          ? [
              {
                identifier: 'v1',
                headline: 'VMA: Brand i Västerås',
                published: '2026-11-04T17:30:00+01:00',
                area: [{ type: 'Municipality', description: 'Västerås' }],
              },
            ]
          : [],
      );
    },
  });
  assert.equal((await request()).json().crisis.length, 1);
  crisisDown = true;
  clock += 40 * 60_000;
  const kept = (await request()).json();
  assert.deepEqual(
    kept.crisis.map((row) => row.id),
    ['vma:v1'],
  );
  assert.equal(kept.crisisStale, true);
  // Past the hour the VMA may well have ended: off the map, warnings stay.
  clock += 21 * 60_000;
  const dropped = (await request()).json();
  assert.deepEqual(dropped.crisis, []);
  assert.equal(dropped.crisisStale, true);
  assert.equal(dropped.areas.length, 1);
  // Krisinformation back: its list again.
  crisisDown = false;
  clock += 6 * 60_000;
  const back = (await request()).json();
  assert.equal(back.crisis.length, 1);
  assert.equal(back.crisisStale, false);
});

test("news older than three days is left out, by the proxy's clock", async (t) => {
  t.mock.method(console, 'log', () => {});
  const request = harness({
    now: () => Date.parse('2026-11-10T17:00:00+01:00'),
    fetchImpl: async (url) => {
      if (!String(url).includes('krisinformation'))
        return Response.json(PAYLOAD);
      return Response.json(
        String(url).includes('/vmas')
          ? []
          : [
              {
                identifier: 'old',
                headline: 'Oväder väntas 7-8 november',
                published: '2026-11-06T21:00:00+01:00',
                updated: '2026-11-06T21:00:00+01:00',
              },
              {
                identifier: 'updated',
                headline: 'Gränskontroller förlängs',
                published: '2026-11-05T14:00:00+01:00',
                updated: '2026-11-09T08:00:00+01:00',
                area: [{ type: 'Country', description: 'Sverige' }],
              },
            ],
      );
    },
  });
  assert.deepEqual(
    (await request()).json().crisis.map((row) => [row.id, row.scope]),
    [['news:updated', 'country']],
  );
});

test('requests waiting on one refresh share it, logged and saved once', async (t) => {
  const log = t.mock.method(console, 'log', () => {});
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let calls = 0;
  const request = harness({
    fetchImpl: async () => {
      calls += 1;
      await gate;
      return Response.json(PAYLOAD);
    },
  });
  const waiting = [request(), request(), request()];
  await new Promise((resolve) => setImmediate(resolve));
  release();
  const answers = await Promise.all(waiting);
  assert.deepEqual(
    answers.map((answer) => answer.status),
    [200, 200, 200],
  );
  assert.equal(calls, 3);
  assert.equal(log.mock.callCount(), 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  celestrakProxy,
  rocketLaunchesProxy,
  launchLibraryRequestHeaders,
  LL2_CACHE_TTL_MS,
} from 'gods-eye-view/server/providers/space';
import {
  celestrakTleUrl,
  launchLibraryRecentUrl,
} from 'gods-eye-view/sources/space';
import * as compatibility from '../../server/providers/local.js';
import { sharedCelestrakUpstream } from '../../server/providers/space/celestrakUpstream.js';
import { createLaunchSource } from 'gods-eye-view/layers/launches/source';

const TLE = 'ISS\n1 25544U fixture\n2 25544 fixture\n';
const MINUTE = 60_000;

function install(plugin, preview = false) {
  const routes = new Map();
  plugin[preview ? 'configurePreviewServer' : 'configureServer']({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  return async (route, url = '/', method = 'GET', headers = {}) => {
    const res = {
      headersSent: false,
      headers: {},
      writeHead(status, headers) {
        Object.assign(this, { status, headers, headersSent: true });
      },
      // The same-site gates answer 403 through statusCode + setHeader.
      setHeader(name, value) {
        this.headers[name] = value;
      },
      end(body) {
        this.body = body;
        this.status ??= this.statusCode;
      },
    };
    await routes.get(route)({ url, method, headers, socket: {} }, res);
    return res;
  };
}
function isolateDisk(t) {
  t.mock.method(fsp, 'readFile', async () => {
    throw Error('no cache');
  });
  t.mock.method(fsp, 'stat', async () => {
    throw Error('no cache');
  });
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'writeFile', async () => {});
}

/** A response that streams 1 MiB chunks of `text` well past every cap, then ends. */
function oversizedResponse(text) {
  const state = { pulled: 0, cancelled: false };
  const chunk = new TextEncoder().encode(
    text.repeat(Math.ceil((1 << 20) / text.length)),
  );
  const response = new Response(
    new ReadableStream(
      {
        pull(controller) {
          if (++state.pulled > 40) controller.close();
          else controller.enqueue(chunk);
        },
        cancel() {
          state.cancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
  );
  return { response, state };
}

test('portable requests keep fixed origins, encode group data and preserve the 30-day UTC window', () => {
  const tle = celestrakTleUrl('stations&FORMAT=json');
  assert.equal(tle.origin, 'https://celestrak.org');
  assert.equal(tle.pathname, '/NORAD/elements/gp.php');
  assert.equal(tle.searchParams.get('GROUP'), 'stations&FORMAT=json');
  assert.equal(tle.searchParams.get('FORMAT'), 'tle');
  const end = new Date('2026-03-01T12:34:56.000Z');
  const url = launchLibraryRecentUrl(end);
  assert.equal(url.origin, 'https://ll.thespacedevs.com');
  assert.equal(url.pathname, '/2.3.0/launches/');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    net__gte: '2026-01-30T12:34:00.000Z',
    net__lte: '2026-03-01T12:34:00.000Z',
    limit: '100',
    mode: 'detailed',
  });
  assert.equal(end.toISOString(), '2026-03-01T12:34:56.000Z');
});

test('compatibility exports retain the same LL2 header helper and TTL', () => {
  assert.equal(
    compatibility.launchLibraryRequestHeaders,
    launchLibraryRequestHeaders,
  );
  assert.equal(compatibility.LL2_CACHE_TTL_MS, LL2_CACHE_TTL_MS);
});

test('exported CelesTrak plugin coalesces refreshes, retains stale TLEs, and reads disk in a new instance', async (t) => {
  isolateDisk(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'warn', () => {});
  const tle = 'ISS\n1 25544U fixture\n2 25544 fixture';
  let calls = 0,
    release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls++;
    assert.equal(new URL(url).searchParams.get('GROUP'), 'stations');
    await gate;
    return new Response(tle);
  });
  const request = install(celestrakProxy());
  assert.equal((await request('/api/celestrak', '/../bad')).status, 400);
  assert.equal(calls, 0);
  const first = request('/api/celestrak', '/stations');
  const second = request('/api/celestrak', '/stations');
  release();
  for (const res of await Promise.all([first, second]))
    assert.equal(res.body, tle);
  assert.equal(calls, 1);
  assert.equal(
    (await request('/api/celestrak', '/stations')).headers['x-tle-cache'],
    'HIT',
  );
  now += 6 * 3600_000;
  t.mock.method(globalThis, 'fetch', async () => new Response('not a TLE'));
  const stale = await request('/api/celestrak', '/stations');
  assert.equal(stale.body, tle);
  assert.equal(stale.headers['x-tle-cache'], 'STALE-ERROR');
  t.mock.method(fsp, 'readFile', async () =>
    JSON.stringify({ at: now, body: tle }),
  );
  t.mock.method(globalThis, 'fetch', async () => {
    throw Error('fresh disk must prevent fetch');
  });
  const disk = await install(celestrakProxy())('/api/celestrak', '/stations');
  assert.equal(disk.headers['x-tle-cache'], 'HIT');
  assert.equal(disk.body, tle);
});

test('CelesTrak answers 502 to an oversized TLE body without caching it', async (t) => {
  isolateDisk(t);
  t.mock.method(console, 'warn', () => {});
  const bodies = [];
  t.mock.method(globalThis, 'fetch', async () => {
    const oversized = oversizedResponse(
      'ISS\n1 25544U fixture\n2 25544 fixture\n',
    );
    bodies.push(oversized.state);
    return oversized.response;
  });
  const request = install(celestrakProxy());
  const first = await request('/api/celestrak', '/stations');
  assert.equal(first.status, 502);
  assert.equal(bodies[0].cancelled, true);
  assert.ok(bodies[0].pulled <= 17, 'reading stops at the 16 MiB cap');
  assert.equal(fsp.writeFile.mock.callCount(), 0);
  assert.equal((await request('/api/celestrak', '/stations')).status, 502);
  assert.equal(
    bodies.length,
    1,
    'failed bodies are not cached but a cooldown bounds retry work',
  );
});

for (const preview of [false, true])
  test(`exported launch plugin preserves optional server auth and cache in ${preview ? 'preview' : 'development'}`, async (t) => {
    isolateDisk(t);
    const prior = process.env.LL2_API_TOKEN;
    t.after(() => {
      if (prior === undefined) delete process.env.LL2_API_TOKEN;
      else process.env.LL2_API_TOKEN = prior;
    });
    process.env.LL2_API_TOKEN = ' fixture-token ';
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      calls++;
      assert.equal(url.searchParams.get('limit'), '100');
      assert.equal(options.headers.Authorization, 'Token fixture-token');
      return Response.json({ results: [{ id: 'launch-fixture' }] });
    });
    const request = install(rocketLaunchesProxy(), preview);
    assert.equal((await request('/api/launches', '/', 'POST')).status, 405);
    const first = await request('/api/launches');
    assert.equal(first.headers['X-GEV-Cache'], 'MISS');
    assert.doesNotMatch(first.body, /fixture-token/);
    const hit = await request('/api/launches');
    assert.equal(hit.headers['X-GEV-Cache'], 'HIT');
    assert.equal(hit.body, first.body);
    assert.equal(calls, 1);
  });

test('space providers honor Retry-After, gate groups, preserve stale dates and recover', async (t) => {
  isolateDisk(t);
  t.mock.method(console, 'warn', () => {});
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  for (const kind of ['tle', 'launches']) {
    // Swedish fork: CelesTrak's usage policy pauses every call at least 2 h
    // after a 403, whatever shorter Retry-After it gives; Launch Library
    // keeps the Retry-After it asks for.
    const pauseS = kind === 'tle' ? 7200 : 90;
    for (const retryAfter of ['90', new Date(now + 90000).toUTCString()]) {
      let calls = 0;
      let fail = false;
      let cancelled = false;
      t.mock.method(globalThis, 'fetch', async () => {
        calls++;
        if (fail)
          return new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
            {
              status: kind === 'tle' ? 403 : 429,
              headers: { 'Retry-After': retryAfter },
            },
          );
        return new Response(
          kind === 'tle'
            ? 'ISS\n1 25544U fixture\n2 25544 fixture\n'
            : '{"results":[]}',
        );
      });
      const request = install(
        kind === 'tle' ? celestrakProxy() : rocketLaunchesProxy(),
      );
      const route = kind === 'tle' ? '/api/celestrak' : '/api/launches';
      const url = kind === 'tle' ? '/stations' : '/';
      if (kind === 'tle') {
        assert.equal(
          (await request(route, '/not-a-supported-group')).status,
          400,
        );
        assert.equal(calls, 0);
      }
      const first = await request(route, url);
      now += 7 * 3600000;
      // Recompute the HTTP-date relative to the clock at the failed refresh.
      const originalFetch = globalThis.fetch;
      t.mock.method(globalThis, 'fetch', async (...args) => {
        const response = await originalFetch(...args);
        if (fail && !/^\d+$/.test(retryAfter))
          response.headers.set(
            'Retry-After',
            new Date(now + 90000).toUTCString(),
          );
        return response;
      });
      fail = true;
      const stale = await request(route, url);
      assert.equal(stale.status, 200);
      assert.equal(stale.body, first.body);
      assert.equal(stale.headers['Retry-After'], String(pauseS));
      assert.ok(
        stale.headers[kind === 'tle' ? 'X-TLE-Cached-At' : 'X-GEV-Cached-At'],
      );
      if (kind === 'tle')
        assert.equal(
          stale.headers['X-CelesTrak-Held-Until'],
          new Date(now + pauseS * 1000).toISOString(),
        );
      assert.equal(cancelled, true);
      await request(route, url);
      if (kind === 'tle')
        assert.equal((await request(route, '/visual')).status, 502);
      assert.equal(calls, 2, 'cooldown applies across TLE groups');
      now += pauseS * 1000 + 1000;
      fail = false;
      assert.equal((await request(route, url)).status, 200);
      assert.equal(calls, 3);
    }
  }
});

test('Space Missions reads the active catalog through the real proxy while unknown groups stay rejected', async (t) => {
  isolateDisk(t);
  const tle = 'ISS\n1 25544U fixture\n2 25544 fixture\n';
  const fetched = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    fetched.push(new URL(url).searchParams.get('GROUP'));
    return new Response(tle);
  });
  const request = install(celestrakProxy());
  // Route the browser source's real request into the middleware.
  const source = createLaunchSource({
    fetchImpl: async (url) => {
      const prefix = '/api/celestrak';
      assert.ok(url.startsWith(`${prefix}/`));
      const res = await request(prefix, url.slice(prefix.length));
      return new Response(res.body, { status: res.status });
    },
  });
  assert.equal(await source.getActiveTle(), tle);
  assert.deepEqual(fetched, ['active']);
  for (const group of ['/not-a-group', '/active-extra', '/../active'])
    assert.equal((await request('/api/celestrak', group)).status, 400);
  assert.deepEqual(fetched, ['active'], 'rejected groups never reach upstream');
});

test('SATCAT is proxied per core group for a day, separately from TLEs, and served stale on failure', async (t) => {
  isolateDisk(t);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  t.mock.method(console, 'warn', () => {});
  const csv =
    'OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER\nSL-16 R/B,1992-093B,22285,R/B,,CIS\n';
  const fetched = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const parsed = new URL(url);
    fetched.push(`${parsed.pathname}?${parsed.searchParams.get('GROUP')}`);
    return new Response(csv);
  });
  const written = [];
  t.mock.method(fsp, 'writeFile', async (file) => {
    written.push(String(file).split(/[\\/]/).pop());
  });
  const request = install(celestrakProxy());
  for (const group of ['/starlink', '/active', '/../visual', '/nope'])
    assert.equal(
      (await request('/api/celestrak-satcat', group)).status,
      400,
      group,
    );
  assert.deepEqual(fetched, [], 'rejected groups never reach upstream');

  const first = await request('/api/celestrak-satcat', '/visual');
  assert.equal(first.status, 200);
  assert.equal(first.body, csv);
  assert.equal(first.headers['x-satcat-cache'], 'MISS');
  assert.deepEqual(fetched, ['/satcat/records.php?visual']);
  assert.deepEqual(
    written,
    ['celestrak-satcat-visual.json'],
    'its own disk cache',
  );

  now += 23 * 3600_000;
  assert.equal(
    (await request('/api/celestrak-satcat', '/visual')).headers[
      'x-satcat-cache'
    ],
    'HIT',
    'a day-long cache, unlike the 6 h TLEs',
  );
  now += 2 * 3600_000;
  t.mock.method(
    globalThis,
    'fetch',
    async () => new Response('<html>busy</html>'),
  );
  const stale = await request('/api/celestrak-satcat', '/visual');
  assert.equal(stale.body, csv, 'an error page never replaces good records');
  assert.equal(stale.headers['x-satcat-cache'], 'STALE-ERROR');
});

// Swedish fork: CelesTrak's usage policy asks a client to stop on any answer
// but 200, so a bad SATCAT answer now pauses the TLEs too (it used to hold
// off only SATCAT, for 60 s).
test('any CelesTrak failure pauses both routes, and the answers say until when', async (t) => {
  isolateDisk(t);
  t.mock.method(console, 'warn', () => {});
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let satcatAnswer = () => new Response('<html>not csv</html>');
  const fetched = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const parsed = new URL(url);
    fetched.push(parsed.pathname);
    return parsed.pathname.startsWith('/satcat/')
      ? satcatAnswer()
      : new Response(TLE);
  });
  const request = install(celestrakProxy());
  const satcat = await request('/api/celestrak-satcat', '/sar');
  assert.equal(satcat.status, 502);
  // The group that failed is asked again only after its own 2 h…
  assert.equal(
    satcat.headers['X-CelesTrak-Held-Until'],
    new Date(now + 120 * MINUTE).toISOString(),
  );
  // …and every other call waits the 15-minute pause.
  const until = new Date(now + 15 * MINUTE).toISOString();
  const held = await request('/api/celestrak', '/starlink');
  assert.equal(held.status, 502);
  assert.equal(held.headers['x-tle-cache'], 'NONE');
  assert.equal(held.headers['X-CelesTrak-Held-Until'], until);
  assert.equal(held.headers['Retry-After'], '900');
  assert.deepEqual(fetched, ['/satcat/records.php'], 'nothing more was sent');
  now += 15 * MINUTE;
  const starlink = await request('/api/celestrak', '/starlink');
  assert.equal(starlink.status, 200);
  assert.equal(starlink.body, TLE);
  assert.equal(starlink.headers['X-CelesTrak-Held-Until'], undefined);

  // A 429 is CelesTrak throttling this client: both routes wait 2 h.
  satcatAnswer = () =>
    new Response('slow down', {
      status: 429,
      headers: { 'Retry-After': '120' },
    });
  const throttled = install(celestrakProxy());
  await throttled('/api/celestrak-satcat', '/visual');
  const before = fetched.length;
  const geo = await throttled('/api/celestrak', '/geo');
  assert.equal(geo.status, 502);
  assert.equal(geo.headers['Retry-After'], '7200');
  assert.equal(fetched.length, before, 'nothing went upstream');
});

test('while paused, a group is served from its last copy, however old, with the time it was fetched', async (t) => {
  isolateDisk(t);
  t.mock.method(console, 'warn', () => {});
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const fetchedAt = now - 3 * 24 * 60 * MINUTE;
  t.mock.method(fsp, 'readFile', async () =>
    JSON.stringify({ at: fetchedAt, body: TLE }),
  );
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('', { status: 503 });
  });
  const request = install(celestrakProxy());
  const failed = await request('/api/celestrak', '/stations');
  const held = await request('/api/celestrak', '/visual');
  // The group that failed waits its own 2 h, the other the 15-minute pause.
  for (const [res, minutes] of [
    [failed, 120],
    [held, 15],
  ]) {
    assert.equal(res.status, 200);
    assert.equal(res.body, TLE);
    assert.equal(res.headers['x-tle-cache'], 'STALE-ERROR');
    assert.equal(
      res.headers['X-TLE-Cached-At'],
      new Date(fetchedAt).toISOString(),
      'its real age',
    );
    assert.equal(
      res.headers['X-CelesTrak-Held-Until'],
      new Date(now + minutes * MINUTE).toISOString(),
    );
  }
  assert.equal(calls, 1);
});

// Swedish fork: one CelesTrak call at a time must not hold the browser's
// connections; a group with a copy is answered at once.
test('a refresh waiting its turn is answered from the last copy at once, and lands in the cache for the next poll', async (t) => {
  isolateDisk(t);
  t.mock.method(console, 'warn', () => {});
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const fetchedAt = now - 7 * 60 * MINUTE;
  t.mock.method(fsp, 'readFile', async () =>
    JSON.stringify({ at: fetchedAt, body: TLE }),
  );
  const fresh = 'ISS\n1 25544U fresh\n2 25544 fresh\n';
  const sent = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.mock.method(globalThis, 'fetch', async (url) => {
    sent.push(new URL(url).searchParams.get('GROUP'));
    await gate;
    return new Response(fresh);
  });
  const request = install(celestrakProxy());
  // Its call can start at once: the answer waits for it.
  const first = request('/api/celestrak', '/stations');
  while (sent.length < 1) await new Promise(setImmediate);
  // Queued behind it: the last copy now, with its real age, no pause.
  const queued = await request('/api/celestrak', '/visual');
  assert.equal(queued.status, 200);
  assert.equal(queued.body, TLE);
  assert.equal(queued.headers['x-tle-cache'], 'STALE');
  assert.equal(
    queued.headers['X-TLE-Cached-At'],
    new Date(fetchedAt).toISOString(),
  );
  assert.equal(queued.headers['X-CelesTrak-Held-Until'], undefined);
  assert.deepEqual(sent, ['stations'], 'one call at a time');
  release();
  assert.equal((await first).headers['x-tle-cache'], 'MISS');
  while (sent.length < 2) await new Promise(setImmediate);
  for (let turn = 0; turn < 10; turn++) await new Promise(setImmediate);
  const next = await request('/api/celestrak', '/visual');
  assert.equal(next.headers['x-tle-cache'], 'HIT');
  assert.equal(next.body, fresh);
  assert.deepEqual(sent, ['stations', 'visual']);
});

test('a group CelesTrak answered 404 for is marked as no longer asked, with its copy or without', async (t) => {
  isolateDisk(t);
  t.mock.method(console, 'warn', () => {});
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const fetchedAt = now - 7 * 60 * MINUTE;
  t.mock.method(fsp, 'readFile', async (file) => {
    if (String(file).endsWith('celestrak-stations.json'))
      return JSON.stringify({ at: fetchedAt, body: TLE });
    throw Error('no cache');
  });
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(null, { status: 404 });
  });
  const request = install(celestrakProxy());
  const copy = await request('/api/celestrak', '/stations');
  assert.equal(copy.status, 200);
  assert.equal(copy.headers['x-tle-cache'], 'STALE-ERROR');
  assert.equal(copy.headers['X-CelesTrak-Gone'], '404');
  assert.equal(copy.headers['X-CelesTrak-Held-Until'], undefined);
  // A 404 pauses nothing else: the next group is asked, and gone too.
  const none = await request('/api/celestrak', '/visual');
  assert.equal(none.status, 502);
  assert.equal(none.headers['X-CelesTrak-Gone'], '404');
  assert.equal(calls, 2);
  now += 25 * 60 * MINUTE;
  const later = await request('/api/celestrak', '/stations');
  assert.equal(later.headers['X-CelesTrak-Gone'], '404');
  assert.equal(calls, 2, 'never asked again in this process');
});

test('the composition’s shared transport keeps a pause across an in-process restart', async (t) => {
  isolateDisk(t);
  t.mock.method(console, 'warn', () => {});
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('', { status: 403 });
  });
  // Never written: isolateDisk keeps every write off the disk.
  const statePath = path.join(
    os.tmpdir(),
    `gev-celestrak-restart-${process.pid}-${Date.now()}`,
    'celestrak-policy.json',
  );
  const composed = () =>
    celestrakProxy({ upstream: sharedCelestrakUpstream({ statePath }) });
  assert.equal(
    (await install(composed())('/api/celestrak', '/stations')).status,
    502,
  );
  // KOPPLA PÅ restarts the dev server in this process: new plugins, the
  // same pause.
  const after = await install(composed())('/api/celestrak-satcat', '/visual');
  assert.equal(after.status, 502);
  assert.ok(after.headers['X-CelesTrak-Held-Until']);
  assert.equal(calls, 1);
});

test('CelesTrak admits a same-origin request behind the documented reverse proxy and refuses foreign origins', async (t) => {
  isolateDisk(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('ISS\n1 25544U fixture\n2 25544 fixture\n');
  });
  const request = install(celestrakProxy());
  const proxied = {
    host: 'gev.example.test',
    'x-forwarded-for': '203.0.113.7',
    'x-forwarded-host': 'gev.example.test',
    'x-forwarded-proto': 'https',
    via: '1.1 proxy',
  };
  const app = await request('/api/celestrak', '/stations', 'GET', {
    ...proxied,
    origin: 'https://gev.example.test',
    'sec-fetch-site': 'same-origin',
  });
  assert.equal(app.status, 200);
  assert.equal(app.headers['x-tle-cache'], 'MISS');
  assert.equal(calls, 1);
  for (const headers of [
    { ...proxied, origin: 'https://unrelated.example' },
    { ...proxied, origin: 'null' },
    { ...proxied, 'sec-fetch-site': 'cross-site' },
  ]) {
    const refused = await request('/api/celestrak', '/visual', 'GET', headers);
    assert.equal(refused.status, 403);
  }
  assert.equal(calls, 1, 'refused requests do no provider or cache work');
});

// Swedish fork: CelesTrak calls no longer run side by side (they used to,
// and two failures finishing in either order had to keep the longer of a
// 30 min and a 60 s cooldown). One goes at a time and the first failure
// answers the rest of the burst, so no second failure follows it.
test('a burst reaches CelesTrak one call at a time, and the first failure answers the rest', async (t) => {
  isolateDisk(t);
  t.mock.method(console, 'warn', () => {});
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const sent = [];
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  t.mock.method(globalThis, 'fetch', async (url) => {
    sent.push(new URL(url).searchParams.get('GROUP'));
    await gate;
    return new Response('slow down', {
      status: 429,
      headers: { 'Retry-After': '1800' },
    });
  });
  const request = install(celestrakProxy());
  const answers = Promise.all(
    ['stations', 'visual', 'geo'].map((group) =>
      request('/api/celestrak', `/${group}`),
    ),
  );
  while (sent.length < 1) await new Promise(setImmediate);
  for (let turn = 0; turn < 10; turn++) await new Promise(setImmediate);
  assert.deepEqual(sent, ['stations'], 'one call at a time');
  release();
  for (const res of await answers) {
    assert.equal(res.status, 502);
    assert.equal(
      res.headers['Retry-After'],
      '7200',
      'at least 2 h after a 429',
    );
  }
  assert.deepEqual(sent, ['stations'], 'the first failure stopped the rest');
  now += 7200_000;
  t.mock.method(globalThis, 'fetch', async () => new Response(TLE));
  assert.equal((await request('/api/celestrak', '/geo')).status, 200);
});

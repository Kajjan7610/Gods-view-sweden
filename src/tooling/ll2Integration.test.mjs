import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import http from 'node:http';
import { launchLibraryRecentUrl } from '../data/spaceProviderRequests.js';
import {
  LL2_FAILURE_WAIT_MS,
  LL2_RETRY_AFTER_MAX_MS,
  launchLibraryRequestHeaders,
  rocketLaunchesProxy,
} from '../../server/providers/space/launch-library.js';
import { keySetupStatus } from '../keySetupCore.mjs';
import { initKeySetup } from '../keySetup.js';
import { createPinia } from 'pinia';
import { useProviderSettingsStore } from '../ui/stores/providerSettings.js';
// Swedish fork: what the app reads from the feed, for the allow-list tests.
import { createModel } from '../layers/launches/model.js';
import { createPolicyHelpers } from '../layers/launches/policyHelpers.js';
import { composeCatalog, coreTools } from '../tools/index.js';

test('LL2 requests from the same UTC minute share a cache key without mutating callers', () => {
  const first = new Date('2026-10-17T16:20:00.001Z');
  const last = new Date('2026-10-17T16:20:59.999Z');
  assert.equal(
    launchLibraryRecentUrl(first).href,
    launchLibraryRecentUrl(last).href,
  );
  assert.equal(first.toISOString(), '2026-10-17T16:20:00.001Z');
  assert.equal(last.toISOString(), '2026-10-17T16:20:59.999Z');
});

for (const [date, end] of [
  ['2026-10-17T16:20:00.001Z', '2026-10-17T16:20:00.000Z'],
  ['2026-10-17T16:20:59.999Z', '2026-10-17T16:20:00.000Z'],
  ['2026-10-17T16:21:00.000Z', '2026-10-17T16:21:00.000Z'],
  ['2026-01-01T00:00:00.001Z', '2026-01-01T00:00:00.000Z'],
]) {
  test(`LL2 bounds retain the 30-day UTC window at ${date}`, () => {
    const url = launchLibraryRecentUrl(new Date(date));
    assert.equal(url.origin, 'https://ll.thespacedevs.com');
    assert.equal(url.pathname, '/2.3.0/launches/');
    assert.equal(url.searchParams.get('net__lte'), end);
    assert.equal(
      Date.parse(end) - Date.parse(url.searchParams.get('net__gte')),
      30 * 86400000,
    );
    assert.equal(url.searchParams.get('limit'), '100');
    assert.equal(url.searchParams.get('mode'), 'detailed');
  });
}

test('LL2 headers identify the app and preserve optional server-only authorization', () => {
  const publicHeaders = launchLibraryRequestHeaders('');
  assert.match(publicHeaders['User-Agent'], /^gods-eye-view.*\/1\.0 /);
  assert.ok(
    publicHeaders['User-Agent'].includes(
      'https://github.com/Kajjan7610/Gods-view-sweden',
    ),
  );
  assert.equal(publicHeaders.Accept, 'application/json');
  assert.equal(publicHeaders.Authorization, undefined);
  const paidHeaders = launchLibraryRequestHeaders(' owned-fixture-token ');
  assert.equal(paidHeaders.Authorization, 'Token owned-fixture-token');
  assert.equal(paidHeaders['User-Agent'], publicHeaders['User-Agent']);
});

test('actual setup rendering distinguishes optional paid LL2 from unrelated free keys', async () => {
  const store = useProviderSettingsStore(createPinia());
  const status = keySetupStatus({});
  status.keys = status.keys.filter((key) =>
    ['launch-library', 'mapillary'].includes(key.id),
  );
  const setup = await initKeySetup({
    documentRef: {
      getElementById: (id) => (id === 'key-setup' ? { dataset: {} } : null),
      addEventListener() {},
      removeEventListener() {},
    },
    store,
    fetchImpl: async () => ({ ok: true, json: async () => status }),
  });
  assert.ok(setup);
  try {
    const row = (id) => store.view.rows.find((key) => key.id === id);
    const ll2 = row('launch-library');
    assert.match(ll2.tierTitle, /optional paid token/i);
    assert.match(ll2.unlocks, /leave blank/i);
    assert.match(ll2.unlocks, /no key/i);
    assert.equal(
      row('mapillary').tierTitle,
      'Free key — register, paste, done',
    );
    const serialized = JSON.stringify(status);
    assert.ok(!serialized.includes('owned-fixture-token'));
  } finally {
    setup.destroy();
  }
});

test('real LL2 proxy sends cacheable headers and bounds, retaining its memory cache', async (t) => {
  for (const method of ['readFile', 'stat'])
    t.mock.method(fsp, method, async () => {
      throw new Error('owned fixture has no disk cache');
    });
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'writeFile', async () => {});
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: new URL(url), options });
    return new Response(
      JSON.stringify({ results: [{ id: 'owned-launch-fixture' }] }),
    );
  });
  let handler;
  rocketLaunchesProxy().configureServer({
    middlewares: {
      use(route, value) {
        assert.equal(route, '/api/launches');
        handler = value;
      },
    },
  });
  async function request() {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ method: 'GET' }, res);
    return res;
  }
  const first = await request();
  const second = await request();
  assert.equal(first.status, 200);
  assert.equal(second.body, first.body);
  assert.equal(second.headers['X-GEV-Cache'], 'HIT');
  assert.equal(calls.length, 1);
  assert.match(calls[0].options.headers['User-Agent'], /gods-eye-view/);
  assert.match(calls[0].url.searchParams.get('net__lte'), /:00\.000Z$/);
  assert.match(calls[0].url.searchParams.get('net__gte'), /:00\.000Z$/);
});

for (const preview of [false, true]) {
  test(`LL2 proxy sends its identifying headers over real owned HTTP in ${preview ? 'preview' : 'development'}`, async (t) => {
    for (const method of ['readFile', 'stat'])
      t.mock.method(fsp, method, async () => {
        throw new Error('no owned cache');
      });
    t.mock.method(fsp, 'mkdir', async () => {});
    t.mock.method(fsp, 'writeFile', async () => {});
    const received = [];
    const upstream = http.createServer((req, res) => {
      received.push({
        url: new URL(req.url, 'http://fixture.invalid'),
        headers: req.headers,
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ results: [{ id: 'owned-wire-fixture' }] }));
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const originalFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', (url, options) => {
      const parsed = new URL(url);
      assert.equal(parsed.origin, 'https://ll.thespacedevs.com');
      return originalFetch(
        `http://127.0.0.1:${upstream.address().port}${parsed.pathname}${parsed.search}`,
        options,
      );
    });
    let handler;
    const plugin = rocketLaunchesProxy();
    plugin[preview ? 'configurePreviewServer' : 'configureServer']({
      middlewares: {
        use(_route, value) {
          handler = value;
        },
      },
    });
    const proxy = http.createServer((req, res) => {
      void handler(req, res);
    });
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    try {
      const result = await originalFetch(
        `http://127.0.0.1:${proxy.address().port}/api/launches`,
      );
      assert.equal(result.status, 200);
      assert.deepEqual(await result.json(), {
        results: [{ id: 'owned-wire-fixture' }],
      });
      assert.equal(received.length, 1);
      assert.match(
        received[0].headers['user-agent'],
        /^gods-eye-view-launch-library-proxy\/1\.0 /,
      );
      assert.equal(received[0].headers.authorization, undefined);
      assert.match(received[0].url.searchParams.get('net__lte'), /:00\.000Z$/);
    } finally {
      proxy.closeAllConnections();
      upstream.closeAllConnections();
      await Promise.all([
        new Promise((resolve) => proxy.close(resolve)),
        new Promise((resolve) => upstream.close(resolve)),
      ]);
    }
  });
}

// Swedish fork: the proxy keeps only the fields the app reads. The fixture
// has the shape of a v2.3 detailed launch; what the app never reads is marked
// PRIVATE-FIXTURE (update notes with their contributors and photos, agency
// administrators, image credits, video publishers, crew), and every value is
// made up.
const PRIVATE = 'PRIVATE-FIXTURE';
const NEVER_FORWARDED = [
  'updates',
  'profile_image',
  'created_by',
  'administrator',
  'launch_crew',
  'onboard_crew',
  'landing_crew',
  'astronaut',
  'date_of_birth',
  'bio',
  'social_media_links',
  'image',
  'credit',
  'vid_urls',
  'info_urls',
  'publisher',
  'agencies',
  'program',
  'docking_events',
];
const FEED_NOW = new Date('2026-11-20T00:00:00Z');

function agency(name) {
  return {
    id: 121,
    name,
    abbrev: 'FIX',
    administrator: `${PRIVATE} administrator of ${name}`,
    image: {
      image_url: `https://example.test/${PRIVATE}-logo.png`,
      credit: `${PRIVATE} logo credit`,
    },
    social_media_links: [{ url: `https://example.test/${PRIVATE}-social` }],
  };
}

function crewMember(role) {
  return {
    id: 1,
    role: { id: 1, role, priority: 0 },
    astronaut: {
      id: 9,
      name: `${PRIVATE} ${role}`,
      date_of_birth: '1980-01-01',
      nationality: [{ name: 'Fixtureland' }],
      bio: `${PRIVATE} biography`,
      image: {
        image_url: `https://example.test/${PRIVATE}-portrait.jpg`,
        credit: `${PRIVATE} portrait credit`,
      },
      social_media_links: [{ url: `https://example.test/${PRIVATE}-crew` }],
      agency: agency('Fixture Space Agency'),
    },
  };
}

/** A crewed launch in the v2.3 detailed shape, with all a launch can carry. */
function detailedFeed() {
  return {
    count: 1,
    next: null,
    previous: null,
    results: [
      {
        id: 'crewed-fixture',
        name: 'Falcon 9 Block 5 | Crew-Fixture',
        slug: 'crew-fixture',
        net: '2026-11-10T12:00:00Z',
        window_start: '2026-11-10T12:00:00Z',
        status: { id: 3, name: 'Launch Successful', abbrev: 'Success' },
        launch_service_provider: agency('Fixture Launch Provider'),
        image: {
          image_url: `https://example.test/${PRIVATE}-launch.jpg`,
          credit: `${PRIVATE} launch photo credit`,
        },
        updates: [
          {
            id: 1,
            profile_image: `https://example.test/${PRIVATE}-profile.jpg`,
            comment: `${PRIVATE} update note`,
            created_by: `${PRIVATE} contributor`,
            created_on: '2026-11-09T10:00:00Z',
          },
        ],
        vid_urls: [
          {
            publisher: `${PRIVATE} video publisher`,
            url: `https://example.test/${PRIVATE}-webcast`,
          },
        ],
        info_urls: [{ url: `https://example.test/${PRIVATE}-press-kit` }],
        program: [{ id: 17, name: 'Fixture Program', agencies: [agency('A')] }],
        pad: {
          id: 80,
          name: 'Launch Complex 39A',
          latitude: '28.6082',
          longitude: '-80.6043',
          agencies: [agency('Fixture Pad Agency')],
          image: { credit: `${PRIVATE} pad credit` },
          location: {
            id: 27,
            name: 'Kennedy Space Center, FL, USA',
            image: { credit: `${PRIVATE} location credit` },
          },
        },
        mission: {
          id: 6,
          name: 'Crew-Fixture',
          description: 'A fixture crew flight to the space station.',
          orbit: {
            id: 8,
            name: 'Low Earth Orbit',
            abbrev: 'LEO',
            celestial_body: { id: 1, name: 'Earth' },
          },
          agencies: [agency('Fixture Mission Agency')],
          image: { credit: `${PRIVATE} mission credit` },
        },
        rocket: {
          id: 7,
          configuration: {
            id: 164,
            name: 'Falcon 9',
            full_name: 'Falcon 9 Block 5',
            manufacturer: agency('Fixture Rocket Maker'),
          },
          launcher_stage: [
            {
              id: 11,
              type: 'Core',
              reused: true,
              launcher_flight_number: 4,
              launcher: {
                id: 12,
                serial_number: 'B9999',
                status: { id: 1, name: 'active' },
                image: { credit: `${PRIVATE} booster credit` },
              },
              landing: {
                id: 13,
                attempt: true,
                success: true,
                description: 'The booster landed on the drone ship.',
                downrange_distance: 600,
                landing_location: {
                  id: 14,
                  name: 'Fixture drone ship',
                  latitude: 30.1,
                  longitude: -76.2,
                  image: { credit: `${PRIVATE} ship credit` },
                },
                type: { id: 2, name: 'Drone ship', abbrev: 'ASDS' },
              },
            },
          ],
          spacecraft_stage: [
            {
              id: 21,
              destination: 'Space station',
              launch_crew: [crewMember('Commander'), crewMember('Pilot')],
              onboard_crew: [crewMember('Mission Specialist')],
              landing_crew: [crewMember('Commander')],
              docking_events: [{ id: 31, docking: '2026-11-11T08:00:00Z' }],
              spacecraft: {
                id: 22,
                name: 'Fixture capsule',
                serial_number: 'C999',
                status: { id: 1, name: 'Active' },
                image: { credit: `${PRIVATE} capsule credit` },
              },
              landing: {
                id: 23,
                attempt: false,
                success: null,
                landing_location: {
                  name: 'Atlantic Ocean',
                  latitude: 29,
                  longitude: -80,
                },
                type: { name: 'Splashdown' },
              },
            },
          ],
          payloads: [
            {
              id: 41,
              destination: 'Low Earth Orbit',
              amount: 1,
              payload: {
                id: 42,
                name: 'Fixture cargo',
                type: { id: 5, name: 'Cargo' },
                manufacturer: agency('Fixture Payload Maker'),
                operator: agency('Fixture Payload Operator'),
                mass: 250,
                image: { credit: `${PRIVATE} payload credit` },
              },
            },
          ],
        },
        timeline: [
          { type: { id: 1, abbrev: 'MECO' }, relative_time: 'PT2M30S' },
          { type: { id: 2, abbrev: 'Payload deploy' }, relative_time: 'PT12M' },
        ],
      },
    ],
  };
}

/** The plugin's `/api/launches` handler, as a function answering one GET. */
function launchesRequest(plugin) {
  let handler;
  plugin.configureServer({
    middlewares: {
      use(route, value) {
        assert.equal(route, '/api/launches');
        handler = value;
      },
    },
  });
  return async () => {
    const res = {
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ method: 'GET' }, res);
    return res;
  };
}

/** Assert that a feed text holds nothing the app does not read. */
function assertTrimmed(text, where) {
  assert.doesNotMatch(text, new RegExp(PRIVATE), where);
  for (const key of NEVER_FORWARDED)
    assert.ok(!text.includes(`"${key}"`), `${where}: ${key}`);
}

/** What the app shows from a feed: the layer's records and the voice rows. */
async function appView(payload) {
  const model = createModel({
    parts: { policyHelpers: createPolicyHelpers({}) },
  });
  // The records keep the orbit object and the trajectory points as sent;
  // the app reads the orbit by name and a point by position and stage.
  const records = model
    .normalizeRocketLaunches(payload, FEED_NOW)
    .map(({ orbit, ...record }) => ({ ...record, orbit: orbit?.name ?? null }));
  const catalog = composeCatalog({
    tools: coreTools,
    services: { launches: { getLaunches: async () => payload } },
  });
  const voice = await catalog.call('get_recent_launches', {});
  return { records, rows: voice.data.rows };
}

test('Launch Library: only the fields the app reads reach the answer and the cache file', async (t) => {
  for (const method of ['readFile', 'stat'])
    t.mock.method(fsp, method, async () => {
      throw new Error('no owned cache');
    });
  t.mock.method(fsp, 'mkdir', async () => {});
  const written = [];
  t.mock.method(fsp, 'writeFile', async (_file, text) => {
    written.push(String(text));
  });
  t.mock.method(globalThis, 'fetch', async () => Response.json(detailedFeed()));
  const answer = await launchesRequest(rocketLaunchesProxy())();
  assert.equal(answer.status, 200);
  assertTrimmed(answer.body, 'answer');
  // The cache file is written after the answer.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(written.length, 1);
  assert.doesNotMatch(written[0], new RegExp(PRIVATE), 'cache file');
  const cached = JSON.parse(written[0]);
  assertTrimmed(cached.body, 'cache file');
  assert.equal(cached.body, answer.body);
  // No crew field is read by the app: the stage keeps its capsule and
  // landing only.
  const [stage] = JSON.parse(answer.body).results[0].rocket.spacecraft_stage;
  assert.deepEqual(Object.keys(stage).sort(), ['id', 'landing', 'spacecraft']);
  assert.deepEqual(stage.spacecraft, {
    serial_number: 'C999',
    status: { name: 'Active' },
  });
  // The app shows the same from the cut feed as from the whole one.
  const full = await appView(detailedFeed());
  assert.deepEqual(await appView(JSON.parse(answer.body)), full);
  assert.equal(full.records.length, 1);
  assert.equal(full.records[0].recoveryStages.length, 2);
  assert.equal(
    full.records[0].payloads[0].manufacturer,
    'Fixture Payload Maker',
  );
  assert.equal(full.rows[0].rocket, 'Falcon 9 Block 5');
  assert.equal(full.rows[0].orbit, 'Low Earth Orbit');
});

test('Launch Library: a cache an earlier version wrote is cut when it is read, and so is its file', async (t) => {
  const old = JSON.stringify({
    at: Date.now(),
    body: JSON.stringify(detailedFeed()),
  });
  let file = old;
  t.mock.method(fsp, 'stat', async () => ({ size: file.length }));
  t.mock.method(fsp, 'readFile', async () => file);
  t.mock.method(fsp, 'mkdir', async () => {});
  const written = [];
  t.mock.method(fsp, 'writeFile', async (_file, text) => {
    written.push(String(text));
  });
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('a fresh cache is never fetched again');
  });
  const answer = await launchesRequest(rocketLaunchesProxy())();
  assert.equal(answer.headers['X-GEV-Cache'], 'HIT');
  assertTrimmed(answer.body, 'answer');
  assert.equal(written.length, 1, 'the file is rewritten');
  assert.doesNotMatch(written[0], new RegExp(PRIVATE), 'cache file');
  assert.equal(JSON.parse(written[0]).body, answer.body);
  assert.equal(JSON.parse(written[0]).at, JSON.parse(old).at, 'same age');
  // A file already cut is served as it is and not written again.
  file = written[0];
  const again = await launchesRequest(rocketLaunchesProxy())();
  assert.equal(again.body, answer.body);
  assert.equal(written.length, 1);
});

test('Launch Library: a failed refresh waits four minutes at least, and a Retry-After up to an hour', async (t) => {
  for (const method of ['readFile', 'stat'])
    t.mock.method(fsp, method, async () => {
      throw new Error('no owned cache');
    });
  t.mock.method(fsp, 'mkdir', async () => {});
  t.mock.method(fsp, 'writeFile', async () => {});
  t.mock.method(console, 'warn', () => {});
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  let calls = 0;
  let upstream = () => {
    throw new TypeError('fetch failed');
  };
  t.mock.method(globalThis, 'fetch', async () => {
    calls += 1;
    return upstream();
  });
  const request = launchesRequest(rocketLaunchesProxy());
  // No answer at all: the next call waits four minutes.
  assert.equal((await request()).status, 502);
  now += LL2_FAILURE_WAIT_MS - 1000;
  const held = await request();
  assert.equal(held.status, 502);
  assert.equal(held.headers['Retry-After'], '1');
  assert.equal(calls, 1);
  // A throttle that names an hour is waited out, not cut to 30 minutes.
  now += 2000;
  upstream = () =>
    new Response('', { status: 429, headers: { 'Retry-After': '3600' } });
  assert.equal((await request()).status, 429);
  assert.equal(calls, 2);
  assert.equal((await request()).headers['Retry-After'], '3600');
  now += 31 * 60_000;
  await request();
  assert.equal(calls, 2, 'still waiting after 31 minutes');
  now += LL2_RETRY_AFTER_MAX_MS - 31 * 60_000;
  upstream = () => Response.json({ results: [] });
  assert.equal((await request()).status, 200);
  assert.equal(calls, 3);
});

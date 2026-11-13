// The shared Krisinformation and SMHI warnings readers: one read for every
// part, each part's own rule for an answer that can no longer be confirmed.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FEED_RETRY_AFTER_FAILURE_MS,
  KRISINFORMATION_URL,
  SMHI_WARNINGS_URL,
  createKrisinformationFeed,
  createSmhiWarningsFeed,
} from './swedishAlertFeeds.js';
import { krisinformationProxy } from './krisinformation.js';
import { smhiWarningsProxy } from './smhiWarnings.js';
import { fetchSwedishAlerts } from './regional/sweden.js';

const T0 = Date.parse('2026-11-13T15:00:00Z');
const VMA = {
  identifier: 'v1',
  headline: 'VMA: Brand i Västerås',
  published: '2026-11-13T15:50:00+01:00',
  area: [{ type: 'Municipality', description: 'Västerås' }],
};

/** A fetch answering Krisinformation and SMHI, counting each URL. */
function upstream(state) {
  return async (url) => {
    const key = String(url);
    state.calls[key] = (state.calls[key] ?? 0) + 1;
    if (key.startsWith(KRISINFORMATION_URL)) {
      if (state.crisisDown) return new Response('down', { status: 503 });
      return Response.json(key.includes('/vmas') ? [VMA] : []);
    }
    if (key === SMHI_WARNINGS_URL) return Response.json([]);
    return new Response('unknown', { status: 404 });
  };
}

/** Drive a route plugin once, as the dev server would. */
async function get(plugin) {
  let handler;
  plugin.configureServer({ middlewares: { use: (_p, fn) => (handler = fn) } });
  const res = {
    destroyed: false,
    writeHead(status) {
      this.status = status;
    },
    end(body) {
      this.body = JSON.parse(body);
    },
  };
  await handler({ method: 'GET', url: '/', headers: {}, socket: {} }, res);
  return res;
}

test('the banner, the warnings layer and the cockpit share one read of each source', async (t) => {
  t.mock.method(console, 'log', () => {});
  const state = { calls: {} };
  let clock = T0;
  const now = () => clock;
  const fetchImpl = upstream(state);
  const crisisFeed = createKrisinformationFeed({ fetchImpl, now });
  const warningsFeed = createSmhiWarningsFeed({ fetchImpl, now });
  const banner = await get(krisinformationProxy({ feed: crisisFeed, now }));
  const layer = await get(
    smhiWarningsProxy({ crisisFeed, warningsFeed, now }),
  );
  const cockpit = await fetchSwedishAlerts(
    { latitude: 59.61, longitude: 16.55 },
    { now, crisisFeed, warningsFeed },
  );
  assert.equal(banner.body.vmas[0].headline, VMA.headline);
  assert.deepEqual(
    layer.body.crisis.map((row) => row.id),
    ['vma:v1'],
  );
  assert.equal(cockpit.status, 'ready');
  assert.equal(cockpit.alerts[0]?.kind, 'vma');
  assert.equal(state.calls[`${KRISINFORMATION_URL}/vmas`], 1);
  assert.equal(state.calls[`${KRISINFORMATION_URL}/news?days=3`], 1);
  assert.equal(state.calls[SMHI_WARNINGS_URL], 1);
  // Two minutes on, Krisinformation is read again; SMHI keeps five.
  clock += 2 * 60_000;
  await get(krisinformationProxy({ feed: crisisFeed, now }));
  await fetchSwedishAlerts(
    { latitude: 59.61, longitude: 16.55 },
    { now, crisisFeed, warningsFeed },
  );
  assert.equal(state.calls[`${KRISINFORMATION_URL}/vmas`], 2);
  assert.equal(state.calls[SMHI_WARNINGS_URL], 1);
});

test('while Krisinformation is down each part keeps its own rule', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const state = { calls: {} };
  let clock = T0;
  const now = () => clock;
  const fetchImpl = upstream(state);
  const crisisFeed = createKrisinformationFeed({ fetchImpl, now });
  const warningsFeed = createSmhiWarningsFeed({ fetchImpl, now });
  const point = { latitude: 59.61, longitude: 16.55 };
  const cockpit = () =>
    fetchSwedishAlerts(point, { now, crisisFeed, warningsFeed });
  await crisisFeed.read();
  state.crisisDown = true;
  // 40 minutes without an answer: every part still shows the VMA.
  clock += 40 * 60_000;
  const banner = await get(krisinformationProxy({ feed: crisisFeed, now }));
  assert.equal(banner.body.stale, true);
  assert.equal(banner.body.vmas.length, 1);
  assert.equal((await cockpit()).alerts[0]?.kind, 'vma');
  // Past the hour the map and the cockpit let it go; the banner keeps it,
  // marked stale, and says when it was last confirmed.
  clock += 21 * 60_000;
  assert.equal((await cockpit()).alerts.length, 0);
  const later = await get(krisinformationProxy({ feed: crisisFeed, now }));
  assert.equal(later.body.stale, true);
  assert.equal(later.body.vmas.length, 1);
  assert.equal(later.body.updatedAt, T0);
});

test('a failed read leaves the source alone for a minute', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const state = { calls: {}, crisisDown: true };
  let clock = T0;
  const feed = createKrisinformationFeed({
    fetchImpl: upstream(state),
    now: () => clock,
  });
  await assert.rejects(feed.read(), /503/);
  await assert.rejects(feed.read(), /503/);
  assert.equal(state.calls[`${KRISINFORMATION_URL}/vmas`], 1);
  clock += FEED_RETRY_AFTER_FAILURE_MS;
  state.crisisDown = false;
  const back = await feed.read();
  assert.equal(back.fresh, true);
  assert.equal(back.vmas.length, 1);
  assert.equal(state.calls[`${KRISINFORMATION_URL}/vmas`], 2);
});

test('readers waiting on one read share it', async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  let calls = 0;
  const feed = createKrisinformationFeed({
    fetchImpl: async () => {
      calls += 1;
      await gate;
      return Response.json([]);
    },
    now: () => T0,
  });
  const waiting = [feed.read(), feed.read(), feed.read()];
  release();
  await Promise.all(waiting);
  assert.equal(calls, 2, 'VMAs and news, once');
});

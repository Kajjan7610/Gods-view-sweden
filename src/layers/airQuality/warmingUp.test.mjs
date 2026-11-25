// Swedish fork: while the SMHI proxy gathers its list of stations it answers
// 503 `warming_up` with a Retry-After. The row says SMHI is starting up, in
// the reader's language, as a notice and not a failed feed, and the layer
// reads again after each Retry-After, three times at most, instead of at its
// next 20-minute refresh; switched off or in a hidden page, it does not.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCombinedAirQualitySource,
  createSmhiAirQualitySource,
} from './source.js';
import { createAirQualityLayer } from './index.js';
import { setLocale } from '../../i18n/index.js';
import { LayerLifecycle } from '../../data/lifecycle.js';
import {
  aggregateLayerLoading,
  createLoadingFeedbackState,
  presentLoadingFeedback,
  reduceLoadingFeedback,
} from '../../loadingFeedback.js';
import { translateFeedError } from '../../ui/statusText.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

/** Let a read the timer started run to its end, body and all. */
const settle = async () => {
  for (let i = 0; i < 10; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
};
const warmingUp = (headers = { 'Retry-After': '120' }) =>
  Response.json({ error: 'warming_up' }, { status: 503, headers });

/** A Canadian station, so the row has readings beside SMHI's failure. */
const TORONTO = {
  id: 'eccc:A',
  provider: 'eccc',
  scale: 'AQHI',
  value: 2,
  band: 'low',
  stationId: 'A',
  name: 'Toronto',
  zone: 'ont',
  lat: 43.65,
  lon: -79.38,
  observedMs: Date.now() - 60_000,
  color: '#4cc9f0',
  label: '2',
  risk: 'Low health risk',
  note: null,
};

/**
 * The layer on ECCC and the real SMHI source, whose proxy answers in turn
 * from `answers` (the last one again when they run out).
 */
function warmingLayer(t, answers) {
  t.mock.method(console, 'warn', () => {});
  const asked = [];
  const smhi = createSmhiAirQualitySource({
    fetchImpl: async (url) => {
      asked.push(url);
      return (answers.length > 1 ? answers.shift() : answers[0])();
    },
  });
  const layer = createAirQualityLayer({
    source: createCombinedAirQualitySource([
      { getSnapshot: async () => [TORONTO] },
      smhi,
    ]),
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  const viewer = {};
  bindFakeDraw(viewer);
  layer.init(viewer);
  layer.enable();
  t.after(() => layer.destroy());
  return { layer, asked };
}

test('the warm-up answer is its own error, with the proxy’s Retry-After', async () => {
  const source = (response) =>
    createSmhiAirQualitySource({ fetchImpl: async () => response() });
  const error = await source(() => warmingUp())
    .getSnapshot()
    .catch((e) => e);
  assert.equal(error.message, 'SMHI air quality is starting up');
  assert.equal(error.warmingUp, true);
  assert.equal(error.retryAfterMs, 120_000);
  assert.equal(error.status, 503);
  // No header: the proxy's own two minutes. A zero is not a spin.
  for (const [headers, wait] of [
    [{}, 120_000],
    [{ 'Retry-After': '0' }, 5_000],
    [{ 'Retry-After': '30' }, 30_000],
  ]) {
    const late = await source(() => warmingUp(headers))
      .getSnapshot()
      .catch((e) => e);
    assert.equal(late.retryAfterMs, wait, JSON.stringify(headers));
  }
  // Any other failure stays an HTTP error, read at the normal refresh.
  for (const [response, text] of [
    [
      () => Response.json({ error: 'unavailable' }, { status: 503 }),
      'SMHI air quality HTTP 503',
    ],
    [
      () =>
        Response.json(
          { error: 'smhi_air_quality_unavailable' },
          { status: 502 },
        ),
      'SMHI air quality HTTP 502',
    ],
  ]) {
    const failed = await source(response)
      .getSnapshot()
      .catch((e) => e);
    assert.equal(failed.message, text);
    assert.equal(failed.warmingUp, undefined);
    assert.equal(failed.retryAfterMs, undefined);
  }
});

test('the row says SMHI is starting up; three early reads at most, each after its Retry-After', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const after = (seconds) => () =>
    warmingUp({ 'Retry-After': String(seconds) });
  const { layer, asked } = warmingLayer(t, [
    after(120),
    after(30),
    after(60),
    after(120),
  ]);
  await layer.update();
  assert.equal(asked.length, 1);
  assert.equal(layer.getStats().count, 1, 'Canada’s station is drawn');
  // A notice, not a failed feed: guidance the Layers row shows.
  assert.equal(layer.getStats().error, null);
  assert.equal(layer.getStats().status, 'idle');
  assert.equal(
    layer.getStats().statusMessage,
    'SMHI air quality is starting up',
  );
  setLocale('sv');
  try {
    assert.equal(
      layer.getRowControls().summary.status,
      'SMHI-luftkvalitet startar upp',
    );
  } finally {
    setLocale('en');
  }
  // Each read after the Retry-After of the answer before it.
  for (const [seconds, reads] of [
    [120, 2],
    [30, 3],
    [60, 4],
  ]) {
    t.mock.timers.tick(seconds * 1000 - 1);
    await settle();
    assert.equal(asked.length, reads - 1, `not before ${seconds} s`);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(asked.length, reads, `read after ${seconds} s`);
  }
  // Still starting up after the third: the 20-minute refresh takes over.
  t.mock.timers.tick(20 * 60_000);
  await settle();
  assert.equal(asked.length, 4, 'three early reads, not a loop');
});

test('SMHI’s stations end the warm-up, and a later one gets its three reads again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const station = () =>
    Response.json({
      stations: [
        {
          id: '59.3400,18.0570',
          name: 'Stockholm Hornsgatan',
          lat: 59.34,
          lon: 18.057,
          pollutants: { NO2: { value: 20, at: Date.now() - 30 * 60_000 } },
        },
      ],
    });
  const { layer, asked } = warmingLayer(t, [
    warmingUp,
    warmingUp,
    station,
    warmingUp,
  ]);
  await layer.update();
  t.mock.timers.tick(120_000);
  await settle();
  t.mock.timers.tick(120_000);
  await settle();
  assert.equal(asked.length, 3, 'two early reads, the second answered');
  assert.equal(layer.getStats().error, null);
  assert.equal(layer.getStats().statusMessage, undefined, 'the notice ends');
  assert.equal(layer.getStats().count, 2);
  // The proxy starts over (a restart): the normal refresh meets it warming
  // up, and the count starts over too.
  await layer.update();
  assert.equal(asked.length, 4);
  for (const reads of [5, 6, 7]) {
    t.mock.timers.tick(120_000);
    await settle();
    assert.equal(asked.length, reads);
  }
  t.mock.timers.tick(20 * 60_000);
  await settle();
  assert.equal(asked.length, 7, 'none after the third');
});

test('a layer switched off or taken down before the Retry-After does not read again', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const off = warmingLayer(t, [warmingUp]);
  const gone = warmingLayer(t, [warmingUp]);
  await off.layer.update();
  await gone.layer.update();
  off.layer.disable();
  gone.layer.destroy();
  t.mock.timers.tick(10 * 60_000);
  await settle();
  assert.equal(off.asked.length, 1);
  assert.equal(gone.asked.length, 1);
});

test('a layer switched off after an early read reads no more', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { layer, asked } = warmingLayer(t, [warmingUp]);
  await layer.update();
  t.mock.timers.tick(120_000);
  await settle();
  assert.equal(asked.length, 2);
  layer.disable();
  t.mock.timers.tick(10 * 60_000);
  await settle();
  assert.equal(asked.length, 2);
});

test('the early read waits at most five minutes and goes through the manager', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { layer, asked } = warmingLayer(t, [
    () => warmingUp({ 'Retry-After': '3600' }),
  ]);
  const refreshed = [];
  layer.attachDataManager({
    refreshLayer: async (id) => {
      refreshed.push(id);
      return layer.update();
    },
  });
  await layer.update();
  t.mock.timers.tick(5 * 60_000 - 1);
  await settle();
  assert.deepEqual(refreshed, []);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(refreshed, ['air-quality']);
  assert.equal(asked.length, 2);
});

test('a hidden page makes no early read and spends none', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  const page = { visibilityState: 'hidden' };
  globalThis.document = page;
  t.after(() =>
    previous
      ? Object.defineProperty(globalThis, 'document', previous)
      : delete globalThis.document,
  );
  const { layer, asked } = warmingLayer(t, [warmingUp]);
  await layer.update();
  t.mock.timers.tick(10 * 60_000);
  await settle();
  assert.equal(asked.length, 1, 'no read while hidden');
  // Shown again, the normal refresh meets the warm-up with its three
  // early reads intact.
  page.visibilityState = 'visible';
  await layer.update();
  for (const reads of [3, 4, 5]) {
    t.mock.timers.tick(120_000);
    await settle();
    assert.equal(asked.length, reads);
  }
  t.mock.timers.tick(20 * 60_000);
  await settle();
  assert.equal(asked.length, 5);
});

test('under the real manager a warm-up refresh fails nothing: no LOAD FAILED chip', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] });
  t.mock.method(console, 'warn', () => {});
  const asked = [];
  const layer = createAirQualityLayer({
    source: createCombinedAirQualitySource([
      { getSnapshot: async () => [TORONTO] },
      createSmhiAirQualitySource({
        fetchImpl: async (url) => {
          asked.push(url);
          return warmingUp();
        },
      }),
    ]),
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  const viewer = {};
  bindFakeDraw(viewer);
  const manager = new LayerLifecycle(viewer, {
    visibilityTarget: {
      hidden: false,
      visibilityState: 'visible',
      addEventListener() {},
      removeEventListener() {},
    },
  });
  manager.register(layer);
  layer.attachDataManager(manager);
  t.after(() => manager.destroyAll());
  // The global loading chip, fed as the shell feeds it (shellFeedback.js).
  let feedback = createLoadingFeedbackState();
  const shown = [];
  const failed = [];
  manager.subscribe((change) => {
    if (/failed/.test(change?.type)) failed.push(change.type);
    const summary = aggregateLayerLoading(manager.getAll());
    feedback = reduceLoadingFeedback(feedback, summary, Date.now(), change);
    shown.push(presentLoadingFeedback(feedback, summary, Date.now()));
  });
  await manager.setEnabled(layer.id, true);
  await settle();
  // The early read runs through the manager, as its refreshes do.
  t.mock.timers.tick(120_000);
  await settle();
  assert.equal(asked.length, 2);
  assert.deepEqual(failed, [], 'no failed load or refresh');
  assert.notEqual(feedback.terminal, 'error');
  assert.ok(
    shown.every((presented) => presented?.state !== 'error'),
    JSON.stringify(shown),
  );
  const [row] = manager.getAll();
  assert.equal(row.stats.error, null);
  assert.equal(row.stats.managerRefreshError, null);
  assert.equal(row.stats.status, 'idle');
  assert.equal(row.stats.statusMessage, 'SMHI air quality is starting up');
  setLocale('sv');
  try {
    assert.equal(
      layer.getRowControls().summary.status,
      'SMHI-luftkvalitet startar upp',
    );
  } finally {
    setLocale('en');
  }
});

test('an SMHI HTTP error reads in Swedish', () => {
  setLocale('sv');
  try {
    const shown = translateFeedError('SMHI air quality HTTP 502');
    assert.equal(shown, 'SMHI-luftkvalitet HTTP 502');
    assert.doesNotMatch(shown, /\b(air|quality)\b/i);
    assert.equal(
      translateFeedError('SMHI air quality is starting up'),
      'SMHI-luftkvalitet startar upp',
    );
  } finally {
    setLocale('en');
  }
});

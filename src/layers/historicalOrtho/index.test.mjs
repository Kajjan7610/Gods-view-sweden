// The historical aerial photos layer: the proxy's status read once per
// switch-on, nothing draped without a working login or above the height
// limit, the year, variant and flight-year chips, honest info lines, the
// map-stack host, and the source's same-origin requests.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';
import { fakeGlobePort } from '../../testSupport/fakeGlobePort.mjs';
import { acquireImageryComparison } from '../../maps/imageryComparison.js';
import { setLocale } from '../../i18n/index.js';
import {
  HISTORICAL_ORTHO_LAYER_ID,
  HISTORICAL_ORTHO_MAX_HEIGHT_M,
  createHistoricalOrthoLayer,
  createHistoricalOrthoRenderer,
  createHistoricalOrthoSource,
} from './index.js';

const settle = () => new Promise((resolve) => setImmediate(resolve));
const LOGIN = Object.freeze({
  hasLogin: true,
  authFailed: false,
  dailyCount: 12,
  budget: 20000,
  date: '2026-11-21',
});

function harness({
  status = LOGIN,
  height = 20_000,
  hostKind = 'globe',
  pose = {},
  capabilities = null,
  extra = {},
} = {}) {
  const reads = [];
  const answers = Array.isArray(status) ? [...status] : [status];
  const source = {
    getStatus: async ({ signal } = {}) => {
      reads.push(signal);
      const next = answers.length > 1 ? answers.shift() : answers[0];
      if (next instanceof Error) throw next;
      return { ...next };
    },
    getTileTemplate: (layerId) =>
      `/api/historiska-ortofoton/tile/${layerId}/{z}/{x}/{y}.png`,
  };
  const globe = fakeGlobePort();
  let currentGlobe = globe;
  const camera = fakeCameraPort({
    pose: { lon: 18, lat: 59.3, height, ...pose },
  });
  const viewer = {};
  const hostState = { kind: hostKind };
  const collections = { globe: {}, tileset: {} };
  const renderer = createHistoricalOrthoRenderer({
    tileTemplate: source.getTileTemplate,
  });
  const layer = createHistoricalOrthoLayer({
    source,
    renderer,
    host: () =>
      hostState.kind === 'none'
        ? { collection: null, kind: 'none' }
        : { collection: collections[hostState.kind], kind: hostState.kind },
    globeOf: () => currentGlobe,
    cameraOf: () => camera.port,
    capabilitiesOf: () => capabilities,
    ...extra,
  });
  layer.init(viewer);
  const chip = (id) =>
    layer.getRowControls().chips.find((entry) => entry.id === id);
  const urls = () => globe.layers.map((entry) => entry.spec.url.split('/')[4]);
  return {
    layer,
    globe,
    camera,
    reads,
    hostState,
    chip,
    urls,
    viewer,
    renderer,
    /** The viewer's globe port is replaced (a renderer rebound). */
    swapGlobe: (next) => (currentGlobe = next),
  };
}

test('on enable the status is read once; with a login the 1960 photo drapes', async () => {
  const { layer, reads, urls, globe } = harness();
  assert.equal(layer.id, HISTORICAL_ORTHO_LAYER_ID);
  assert.equal(layer.updateInterval, 0, 'no polling');
  assert.equal(layer.requiresKeyId, 'geotorget');
  layer.enable();
  assert.equal(globe.layers.length, 0, 'nothing before the status is known');
  assert.equal(layer.getStats().loading, true);
  assert.match(layer.getRowControls().info, /Checking the Geotorget login/);
  await settle();
  assert.equal(reads.length, 1);
  assert.deepEqual(urls(), ['1960']);
  await layer.update();
  assert.equal(reads.length, 1, 'update never reads the status again');
  const stats = layer.getStats();
  assert.equal(stats.count, 1);
  assert.equal(stats.countLabel, 'DRAPED');
  assert.equal(stats.error, null);
  assert.ok(Number.isFinite(stats.lastUpdate));
  assert.equal(
    layer.getRowControls().info,
    'Reference year 1960 · Lantmäteriet (CC0) · flight years vary, turn on FLIGHT YEARS',
  );
  layer.disable();
  assert.equal(globe.layers.length, 0, 'disable removes the imagery');
  layer.enable();
  await settle();
  assert.equal(reads.length, 2, 'each switch-on reads it once');
  layer.destroy();
  assert.equal(globe.layers.length, 0);
});

test('without a login nothing drapes and the row says to add the Geotorget account', async () => {
  const { layer, globe } = harness({
    status: { ...LOGIN, hasLogin: false },
  });
  layer.enable();
  await settle();
  assert.equal(globe.layers.length, 0);
  const stats = layer.getStats();
  assert.equal(stats.error, 'Geotorget account needed');
  assert.equal(stats.keyRequired, true);
  assert.equal(stats.lastUpdate, undefined);
  assert.equal(
    layer.getRowControls().info,
    'Needs a free Geotorget account at Lantmäteriet — add it in Provider Settings',
  );
  layer.setParams({ year: 1975 });
  assert.equal(globe.layers.length, 0, 'a choice drapes nothing either');
  assert.deepEqual(layer.getAnalystRecords(), []);
});

test('a refused login drapes nothing and says so', async () => {
  const { layer, globe } = harness({
    status: { ...LOGIN, authFailed: true },
  });
  layer.enable();
  await settle();
  assert.equal(globe.layers.length, 0);
  assert.equal(
    layer.getStats().error,
    'Lantmäteriet refused the Geotorget login',
  );
  assert.match(layer.getRowControls().info, /refused the Geotorget login/);
});

test('failing tiles read the status once more, and a login refused since then takes the photos off', async () => {
  const { layer, globe, reads } = harness({
    status: [LOGIN, { ...LOGIN, authFailed: true }],
  });
  layer.enable();
  await settle();
  assert.equal(globe.layers.length, 1);
  const [photo] = globe.layers;
  // Outside Sweden is no fault.
  for (let i = 0; i < 10; i += 1) photo.fail({ status: 404 });
  assert.equal(reads.length, 1);
  for (let i = 0; i < 4; i += 1) photo.fail({ status: 502 });
  await settle();
  assert.equal(reads.length, 2, 'one re-read');
  assert.equal(globe.layers.length, 0);
  assert.match(layer.getRowControls().info, /refused/);
  for (let i = 0; i < 8; i += 1) photo.fail({ status: 502 });
  assert.equal(reads.length, 2, 'never more than one per switch-on');
});

test('a spent budget and failing tiles are said on the row, and clear when tiles load or the status is well', async () => {
  const { layer, globe } = harness({ status: [LOGIN, LOGIN] });
  layer.enable();
  await settle();
  const [photo] = globe.layers;
  // Bad or outside tiles are no fault.
  for (let i = 0; i < 6; i += 1) photo.fail({ status: 400 });
  for (let i = 0; i < 6; i += 1) photo.fail({ status: 404 });
  assert.equal(layer.getStats().error, null);
  photo.fail({ status: 429 });
  assert.match(layer.getRowControls().info, /budget of new photos/);
  // A tile that loads clears it.
  await photo.request({ x: 0, y: 0, level: 10 }, () =>
    Promise.resolve('tile'),
  );
  await settle();
  assert.doesNotMatch(layer.getRowControls().info, /budget/);
  for (let i = 0; i < 4; i += 1) photo.fail({});
  assert.equal(
    layer.getStats().error,
    'Lantmäteriet’s photos are not loading',
  );
  // The status re-read says all is well: the error clears.
  await settle();
  assert.equal(layer.getStats().error, null);
  assert.equal(globe.layers.length, 1, 'a working login keeps the photo');
});

test('a status that cannot be read is an error, without imagery', async () => {
  const { layer, globe } = harness({ status: new Error('HTTP 500') });
  const warn = console.warn;
  console.warn = () => {};
  try {
    layer.enable();
    await settle();
  } finally {
    console.warn = warn;
  }
  assert.equal(globe.layers.length, 0);
  assert.equal(layer.getStats().error, 'Historical aerial photos unavailable');
});

test('zoomed out above the limit nothing is asked for and the row says to zoom in', async () => {
  const { layer, globe, camera } = harness({
    height: HISTORICAL_ORTHO_MAX_HEIGHT_M + 1,
  });
  layer.enable();
  await settle();
  assert.equal(globe.layers.length, 0);
  assert.equal(layer.getRowControls().info, 'Zoom in to see the aerial photos');
  assert.equal(layer.getStats().status, 'zoom-in');
  camera.setPose({ height: 40_000 });
  camera.emit('moveEnd');
  assert.equal(globe.layers.length, 1);
  camera.setPose({ height: 900_000 });
  camera.emit('moveEnd');
  assert.equal(globe.layers.length, 0, 'zooming out takes the layers off');
  layer.disable();
  assert.equal(camera.listenerCount('moveEnd'), 0);
});

test('year chips choose one year; colour and infrared only where the year has them', async () => {
  const { layer, chip, urls } = harness();
  layer.enable();
  await settle();
  const chips = layer.getRowControls().chips;
  assert.deepEqual(
    chips.filter((entry) => entry.id.startsWith('year-')).map((e) => e.label),
    [
      '1960', '1975', '1993', '1994', '1995', '1996', '1997', '1998', '1999',
      '2000', '2001', '2002', '2003', '2004', '2005',
    ],
  );
  assert.deepEqual(
    chips.filter((entry) => entry.active).map((entry) => entry.id),
    ['year-1960'],
  );
  assert.equal(chip('variant-color').disabled, true);
  assert.match(chip('variant-color').title, /2002–2005/);
  assert.equal(chip('variant-ir').disabled, true);
  assert.equal(chip('flight-years').disabled, false);
  chip('year-2002').onClick();
  assert.deepEqual(urls(), ['bw-2002']);
  assert.equal(chip('variant-color').disabled, false);
  assert.equal(chip('variant-ir').disabled, true, 'no infrared in 2002');
  assert.equal(chip('flight-years').disabled, true);
  assert.match(chip('flight-years').title, /1960 and 1975/);
  assert.match(
    layer.getRowControls().info,
    /^2002, black and white · Lantmäteriet \(CC0\) · partial coverage: where there is no photo this year, today’s map shows through$/,
  );
  chip('variant-color').onClick();
  assert.deepEqual(urls(), ['color-2002']);
  assert.equal(chip('variant-color').active, true);
  chip('year-2004').onClick();
  assert.deepEqual(urls(), ['color-2004'], 'the variant carries over');
  chip('variant-ir').onClick();
  assert.deepEqual(urls(), ['ir-2004']);
  chip('variant-ir').onClick();
  assert.deepEqual(urls(), ['bw-2004'], 'a second click goes back');
  chip('variant-color').onClick();
  chip('year-1998').onClick();
  assert.deepEqual(urls(), ['bw-1998'], 'a year without colour is b/w');
  assert.deepEqual(layer.getParams(), {
    year: 1998,
    variant: 'bw',
    flightYears: false,
    swipe: false,
    split: 0.5,
  });
});

test('flight years overlay the reference year with its seams and sheets', async () => {
  const { layer, chip, urls } = harness();
  layer.enable();
  await settle();
  chip('flight-years').onClick();
  assert.deepEqual(urls(), ['1960', 'seams-1960', 'meta-1960']);
  assert.equal(chip('flight-years').active, true);
  assert.match(layer.getRowControls().info, /orange sheet/);
  chip('year-1975').onClick();
  assert.deepEqual(urls(), ['1975', 'seams-1975', 'meta-1975']);
  chip('year-2000').onClick();
  assert.deepEqual(urls(), ['bw-2000']);
  assert.equal(chip('flight-years').active, false);
  chip('year-1960').onClick();
  assert.deepEqual(urls(), ['1960', 'seams-1960', 'meta-1960']);
  const [record] = layer.getAnalystRecords();
  assert.equal(record.id, 'historical-ortho:1960');
  assert.equal(record.year, 1960);
  assert.equal(record.referenceYear, true);
  assert.equal(record.flightYears, true);
  assert.equal(record.lat, null);
  assert.equal(layer.findByQuery('anything'), null);
});

test('the photos follow the map stack host and say when it has nowhere to drape', async () => {
  const { layer, globe, hostState } = harness();
  const listeners = new Set();
  layer.attachMapStackController({
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  layer.enable();
  await settle();
  assert.equal(globe.layers.length, 1);
  hostState.kind = 'none';
  for (const listener of listeners) listener();
  assert.equal(globe.layers.length, 0);
  assert.equal(layer.getStats().status, 'idle');
  assert.equal(
    layer.getRowControls().info,
    'Hidden by this map source · choose a globe map',
  );
  hostState.kind = 'tileset';
  layer.attachTileset({ isDestroyed: () => false });
  assert.equal(globe.layers.length, 1, 'drapes on the photoreal tileset');
  assert.equal(layer.diagnostics().host, 'tileset');
  layer.destroy();
  assert.equal(listeners.size, 0);
});

test('the row listener hears status, chips and zoom', async () => {
  const { layer, chip, camera } = harness();
  let calls = 0;
  layer.setRowControlsListener(() => (calls += 1));
  layer.enable();
  await settle();
  assert.ok(calls >= 2, 'on enable and when the status arrives');
  let before = calls;
  chip('year-1975').onClick();
  assert.equal(calls, before + 1);
  chip('year-1975').onClick();
  assert.equal(calls, before + 1, 'the same choice is no change');
  before = calls;
  camera.setPose({ height: 500_000 });
  camera.emit('moveEnd');
  assert.equal(calls, before + 1);
  layer.disable();
  assert.deepEqual(layer.getRowControls(), {});
});

test('the source asks the same-origin proxy and keeps no secrets', async () => {
  const calls = [];
  const source = createHistoricalOrthoSource({
    fetchImpl: async (url, init) => {
      calls.push([url, init]);
      return new Response(
        JSON.stringify({
          hasLogin: true,
          authFailed: false,
          dailyCount: 3,
          budget: 20000,
          date: '2026-11-21',
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    },
  });
  const controller = new AbortController();
  assert.deepEqual(await source.getStatus({ signal: controller.signal }), {
    hasLogin: true,
    authFailed: false,
    dailyCount: 3,
    budget: 20000,
    date: '2026-11-21',
  });
  assert.equal(calls[0][0], '/api/historiska-ortofoton/status');
  assert.equal(calls[0][1].signal, controller.signal);
  assert.equal(
    source.getTileTemplate('color-2004'),
    '/api/historiska-ortofoton/tile/color-2004/{z}/{x}/{y}.png',
  );
  const failing = createHistoricalOrthoSource({
    fetchImpl: async () => new Response('{}', { status: 503 }),
  });
  await assert.rejects(failing.getStatus(), { status: 503 });
  const malformed = createHistoricalOrthoSource({
    fetchImpl: async () => new Response('{"ok":1}'),
  });
  await assert.rejects(malformed.getStatus(), /Malformed/);
});

/**
 * A map controller with the real lease (`acquireImageryComparison`): an
 * asynchronous stack switch that notifies its subscribers once settled,
 * as MapSourceController does.
 */
function leasingController({ activeId = 'photoreal' } = {}) {
  const subscribers = new Set();
  const controller = {
    calls: [],
    _activeId: activeId,
    _generation: 0,
    _origin: 'manual',
    getActiveId() {
      return this._activeId;
    },
    getSwitchGeneration() {
      return this._generation;
    },
    getSwitchOrigin() {
      return this._origin;
    },
    async setStack(id) {
      this.calls.push(id);
      const generation = ++this._generation;
      this._origin = 'manual';
      await settle();
      if (generation !== this._generation) return { status: 'superseded' };
      this._activeId = id;
      for (const listener of [...subscribers]) listener();
      return { status: 'ready', activeId: this._activeId };
    },
    /** Switch as the operator (or the controller's own fallback) would. */
    switchTo(id, origin = 'manual') {
      this._generation += 1;
      this._activeId = id;
      this._origin = origin;
      for (const listener of [...subscribers]) listener();
    },
    acquireImageryComparison(options) {
      return acquireImageryComparison(this, options);
    },
    subscribe(listener) {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },
  };
  return controller;
}

/** The harness with its host following the controller's stack. */
function onMap(controller, options = {}) {
  const fixture = harness(options);
  const follow = () =>
    (fixture.hostState.kind =
      controller.getActiveId() === 'photoreal' ? 'tileset' : 'globe');
  follow();
  // Subscribed first, so the host has moved when the layer hears a switch.
  controller.subscribe(follow);
  fixture.layer.attachMapStackController(controller);
  return { ...fixture, controller };
}

const settleMany = async (count = 4) => {
  for (let i = 0; i < count; i += 1) await settle();
};

test('on Google 3D the photos take the comparison lease and drape on the globe over Esri', async () => {
  const controller = leasingController();
  const { layer, globe, urls } = onMap(controller, {
    height: 60_000,
    pose: { pitch: -0.3 },
  });
  layer.enable();
  await settle();
  assert.deepEqual(controller.calls, ['esri-imagery']);
  assert.equal(layer.diagnostics().lease, 'acquiring');
  assert.equal(globe.layers.length, 0, 'nothing on the 3D tiles meanwhile');
  assert.match(layer.getRowControls().info, /Switching to the Esri map/);
  assert.equal(layer.getStats().loading, true);
  await settleMany();
  assert.equal(controller.getActiveId(), 'esri-imagery');
  assert.equal(layer.diagnostics().host, 'globe');
  assert.equal(layer.diagnostics().lease, 'ready');
  assert.equal(layer.diagnostics().borrowedEsri, true);
  assert.deepEqual(urls(), ['1960'], 'on the globe, tilted and at 60 km');
  assert.doesNotMatch(layer.getRowControls().info, /3D buildings/);
  // A year switch keeps the lease.
  layer.setParams({ year: 1975 });
  assert.deepEqual(controller.calls, ['esri-imagery']);
  // Off: back to Google 3D.
  layer.disable();
  await settleMany();
  assert.deepEqual(controller.calls, ['esri-imagery', 'photoreal']);
  assert.equal(controller.getActiveId(), 'photoreal');
  assert.equal(globe.layers.length, 0);
});

test('a manual switch to Google 3D takes Esri back; an automatic one falls back to the 3D tiles', async () => {
  const controller = leasingController();
  const { layer, globe } = onMap(controller);
  layer.enable();
  await settleMany();
  assert.equal(controller.getActiveId(), 'esri-imagery');
  controller.switchTo('photoreal', 'manual');
  await settleMany();
  assert.equal(controller.getActiveId(), 'esri-imagery', 'Esri again');
  assert.match(layer.getRowControls().info, /keep the Esri map/);
  controller.switchTo('photoreal', 'automatic');
  await settleMany();
  assert.equal(controller.getActiveId(), 'photoreal', 'not retried');
  assert.equal(layer.diagnostics().lease, 'unavailable');
  // On the tiles, low and looking down: draped, with the notes.
  assert.equal(globe.layers.length, 1);
  const info = layer.getRowControls().info;
  assert.match(info, /lies over today’s 3D buildings/);
  assert.match(info, /Esri map unavailable/);
  layer.destroy();
});

test('without the lease the photos drape on the 3D tiles only from low and looking down', async () => {
  const controller = leasingController();
  // Another scene holds the lease.
  const rival = controller.acquireImageryComparison({ owner: 'rival' });
  const { layer, globe, camera } = onMap(controller, { height: 20_000 });
  layer.enable();
  await settle();
  assert.equal(layer.diagnostics().host, 'tileset');
  assert.equal(globe.layers.length, 1);
  const info = layer.getRowControls().info;
  assert.match(info, /3D buildings/);
  assert.match(info, /Comparison in use by another scene/);
  assert.deepEqual(controller.calls, [], 'the map is left alone');
  camera.setPose({ height: 40_000 });
  camera.emit('moveEnd');
  assert.equal(globe.layers.length, 0, 'too high for the tiles');
  assert.equal(layer.getStats().status, 'zoom-in');
  assert.match(layer.getRowControls().info, /below 25 km, looking down/);
  camera.setPose({ height: 15_000, pitch: (-20 * Math.PI) / 180 });
  camera.emit('moveEnd');
  assert.equal(globe.layers.length, 0, 'too tilted for the tiles');
  camera.setPose({ pitch: (-50 * Math.PI) / 180 });
  camera.emit('moveEnd');
  assert.equal(globe.layers.length, 1);
  void rival.release();
  layer.destroy();
});

test('a tileset host without imagery on tiles drapes nothing and says DRAPED nowhere', async () => {
  const { layer, globe } = harness({
    hostKind: 'tileset',
    capabilities: new Set(['imageHooks']),
  });
  layer.enable();
  await settle();
  assert.equal(globe.layers.length, 0);
  const stats = layer.getStats();
  assert.equal(stats.countLabel, undefined);
  assert.equal(
    stats.statusMessage,
    'Hidden by this map source · choose a globe map',
  );
});

test('a view outside Sweden drapes nothing and says so', async () => {
  const { layer, globe, camera } = harness({
    pose: { lon: 2.35, lat: 48.85 },
  });
  layer.enable();
  await settle();
  assert.equal(globe.layers.length, 0);
  assert.match(layer.getRowControls().info, /^Outside Sweden/);
  assert.equal(layer.getStats().countLabel, undefined);
  camera.setPose({ lon: 18, lat: 59.3 });
  camera.emit('moveEnd');
  assert.equal(globe.layers.length, 1);
});

test('without image hooks the layers split the budget and take no admit', async () => {
  const { layer, globe, chip } = harness({
    capabilities: new Set(['imageryOnTiles']),
  });
  layer.enable();
  await settle();
  chip('flight-years').onClick();
  assert.equal(globe.layers.length, 3);
  for (const imagery of globe.layers) {
    assert.equal(imagery.spec.admit, undefined);
    assert.equal(imagery.spec.maxConcurrentRequests, 2);
  }
});

test('params: an unknown year or variant, or a flightYears that is not a boolean, changes nothing', async () => {
  const { layer } = harness();
  layer.enable();
  await settle();
  layer.setParams({ year: 1975 });
  assert.equal(layer.setParams({ year: 1950 }), false);
  assert.equal(layer.setParams({ variant: 'sepia' }), false);
  assert.equal(layer.setParams({ flightYears: 'yes' }), false);
  assert.equal(layer.setParams({ flightYears: 1 }), false);
  assert.deepEqual(layer.getParams(), {
    year: 1975,
    variant: 'bw',
    flightYears: false,
    swipe: false,
    split: 0.5,
  });
  assert.equal(layer.setParams({ flightYears: true }), true);
  assert.equal(layer.getParams().flightYears, true);
});

/**
 * THEN | NOW's divider double: what `createImagerySplit` is given, its
 * value and visibility, and whether it was torn down; plus the split it
 * moves and the frames it asks for.
 */
function fakeSplits() {
  const made = [];
  const frames = [];
  const scene = { splitPosition: 0.5 };
  const createSplit = (options) => {
    const split = {
      options,
      value: options.initialValue,
      visible: true,
      destroyed: false,
      getValue: () => split.value,
      setValue(next) {
        if (next === split.value) return false;
        split.value = next;
        options.scene.splitPosition = next;
        options.requestRender?.();
        return true;
      },
      setVisible(visible) {
        split.visible = Boolean(visible);
      },
      destroy() {
        split.destroyed = true;
      },
      /** The operator drags it. */
      drag(next) {
        split.value = next;
        options.onChange?.(next);
      },
    };
    made.push(split);
    return split;
  };
  const live = () => made.filter((split) => !split.destroyed);
  return {
    made,
    live,
    frames,
    extra: {
      createSplit,
      splitTarget: (globe) => (globe ? scene : null),
      requestRender: (reason) => frames.push(reason),
    },
  };
}

test('THEN | NOW puts the photo left of a divider and today’s map right of it', async () => {
  const splits = fakeSplits();
  const { layer, globe, chip } = harness({ extra: splits.extra });
  layer.attachMapStackController({
    subscribe: () => () => {},
    getActiveStack: () => ({ id: 'esri-imagery', label: 'Esri Satellite', kind: 'esri-imagery' }),
  });
  layer.enable();
  await settle();
  assert.equal(chip('swipe').label, 'THEN | NOW');
  assert.equal(chip('swipe').active, false);
  assert.equal(chip('swipe').disabled, false);
  assert.equal(splits.made.length, 0, 'no divider until asked for');
  chip('swipe').onClick();
  assert.equal(chip('swipe').active, true);
  const [split] = splits.live();
  assert.equal(split.options.beforeLabel, '1960');
  assert.equal(split.options.afterLabel, 'Today · Esri Satellite');
  assert.equal(split.options.afterTitle(), 'Today: Esri Satellite, dates vary');
  assert.equal(split.options.initialValue, 0.5);
  assert.equal(split.visible, true);
  assert.ok(globe.layers.every((imagery) => imagery.split === 'left'));
  // The sheets added later draw left too.
  chip('flight-years').onClick();
  assert.equal(globe.layers.length, 3);
  assert.ok(globe.layers.every((imagery) => imagery.split === 'left'));
  // The operator drags it; a year switch keeps where it stands.
  split.drag(0.3);
  assert.equal(layer.getParams().split, 0.3);
  chip('year-2004').onClick();
  chip('variant-color').onClick();
  const [next] = splits.live();
  assert.notEqual(next, split, 'new labels, a new divider');
  assert.equal(split.destroyed, true);
  assert.equal(next.options.beforeLabel, '2004 colour');
  assert.equal(next.options.initialValue, 0.3);
  assert.equal(splits.live().length, 1);
  // Off: the layers draw everywhere again and the divider goes.
  chip('swipe').onClick();
  assert.equal(next.destroyed, true);
  assert.equal(splits.live().length, 0);
  assert.ok(globe.layers.every((imagery) => imagery.split === 'none'));
});

test('without a map name the right side is today’s map', async () => {
  const splits = fakeSplits();
  const { layer } = harness({ extra: splits.extra });
  layer.enable();
  await settle();
  layer.setParams({ swipe: true });
  const [split] = splits.live();
  assert.equal(split.options.afterLabel, 'Today’s map');
});

test('on the 3D tiles (no lease) THEN | NOW is disabled and says why', async () => {
  const splits = fakeSplits();
  const { layer, globe, chip } = harness({
    hostKind: 'tileset',
    extra: splits.extra,
  });
  layer.enable();
  await settle();
  assert.equal(globe.layers.length, 1, 'draped on the tiles');
  assert.equal(chip('swipe').disabled, true);
  assert.equal(chip('swipe').title, 'Swipe needs a globe map');
  layer.setParams({ swipe: true });
  assert.equal(splits.live().length, 0, 'no divider on the tiles');
  assert.ok(globe.layers.every((imagery) => imagery.split === 'none'));
});

test('a wanted swipe stays switchable off when the host falls back to the 3D tiles', async () => {
  const splits = fakeSplits();
  const { layer, globe, chip, hostState } = harness({ extra: splits.extra });
  const listeners = new Set();
  layer.attachMapStackController({
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
  layer.enable();
  await settle();
  chip('swipe').onClick();
  const [split] = splits.live();
  hostState.kind = 'tileset';
  for (const listener of listeners) listener();
  assert.equal(split.visible, false, 'hidden on the tiles');
  assert.ok(globe.layers.every((imagery) => imagery.split === 'none'));
  assert.equal(chip('swipe').active, true);
  assert.equal(chip('swipe').disabled, false, 'it can still be turned off');
  assert.equal(chip('swipe').title, 'Swipe needs a globe map');
  chip('swipe').onClick();
  assert.equal(layer.getParams().swipe, false);
  assert.equal(split.destroyed, true);
  assert.equal(chip('swipe').disabled, true, 'turning it on is not offered');
  assert.equal(chip('swipe').active, false);
});

test('the divider hides while the photos do and comes back with them', async () => {
  const splits = fakeSplits();
  const { layer, globe, camera } = harness({ extra: splits.extra });
  layer.enable();
  await settle();
  layer.setParams({ swipe: true, split: 0.7 });
  const [split] = splits.live();
  assert.equal(split.options.initialValue, 0.7);
  camera.setPose({ height: 500_000 });
  camera.emit('moveEnd');
  assert.equal(split.visible, false, 'hidden when zoomed out');
  assert.equal(split.destroyed, false, 'not torn down');
  camera.setPose({ height: 20_000, lon: 2.35, lat: 48.85 });
  camera.emit('moveEnd');
  assert.equal(split.visible, false, 'hidden outside Sweden');
  camera.setPose({ lon: 18, lat: 59.3 });
  camera.emit('moveEnd');
  assert.equal(split.visible, true);
  assert.equal(splits.live().length, 1, 'the same divider');
  assert.ok(globe.layers.every((imagery) => imagery.split === 'left'));
});

test('no divider before the status or without a login; disable and destroy tear it down', async () => {
  const splits = fakeSplits();
  const { layer, chip } = harness({
    status: { ...LOGIN, hasLogin: false },
    extra: splits.extra,
  });
  // Wanted before the layer is even on.
  layer.setParams({ swipe: true });
  layer.enable();
  assert.equal(splits.made.length, 0, 'none while the status loads');
  assert.equal(chip('swipe').title, 'Checking the Geotorget login…');
  await settle();
  assert.equal(splits.made.length, 0, 'none without a login');
  assert.equal(chip('swipe').title, 'Geotorget account needed');
  assert.equal(chip('swipe').disabled, false, 'a wanted swipe can go off');
  layer.disable();
  // With a login it is made; disable and destroy end it.
  const second = fakeSplits();
  const fresh = harness({ extra: second.extra });
  fresh.layer.enable();
  await settle();
  fresh.layer.setParams({ swipe: true });
  assert.equal(second.live().length, 1);
  fresh.layer.disable();
  assert.equal(second.made[0].destroyed, true);
  fresh.layer.enable();
  await settle();
  assert.equal(second.live().length, 1, 'back with the layer');
  fresh.layer.destroy();
  assert.equal(second.live().length, 0);
});

test('no divider while another scene holds the comparison lease', async () => {
  const controller = leasingController({ activeId: 'osm' });
  const rival = controller.acquireImageryComparison({ owner: 'rival' });
  const splits = fakeSplits();
  const { layer, globe, chip } = onMap(controller, { extra: splits.extra });
  layer.enable();
  await settleMany();
  assert.equal(globe.layers.length, 1, 'the photo shows on the globe');
  assert.equal(layer.diagnostics().lease, 'unavailable');
  assert.equal(chip('swipe').disabled, true);
  assert.equal(chip('swipe').title, 'Comparison in use by another scene');
  layer.setParams({ swipe: true });
  assert.equal(splits.made.length, 0, 'the split is the rival’s');
  assert.ok(globe.layers.every((imagery) => imagery.split === 'none'));
  void rival.release();
  layer.destroy();
});

test('on Google 3D the divider waits for the lease and comes once it is ready', async () => {
  const controller = leasingController();
  const splits = fakeSplits();
  const { layer, globe, chip } = onMap(controller, { extra: splits.extra });
  layer.setParams({ swipe: true, split: 0.4 });
  layer.enable();
  await settle();
  assert.equal(layer.diagnostics().lease, 'acquiring');
  assert.equal(splits.made.length, 0, 'not before the lease');
  assert.equal(chip('swipe').title, 'Switching to the Esri map for the photos…');
  await settleMany();
  assert.equal(layer.diagnostics().lease, 'ready');
  const [split] = splits.live();
  assert.equal(split.options.initialValue, 0.4);
  assert.equal(split.visible, true);
  assert.ok(globe.layers.every((imagery) => imagery.split === 'left'));
  assert.equal(typeof split.options.getViewportWidth, 'function');
  layer.disable();
  await settleMany();
  assert.equal(split.destroyed, true);
  assert.equal(controller.getActiveId(), 'photoreal');
});

test('a new globe port, or a new language, gets a new divider at the same place', async () => {
  const splits = fakeSplits();
  const { layer, camera, swapGlobe } = harness({ extra: splits.extra });
  layer.enable();
  await settle();
  layer.setParams({ swipe: true, split: 0.35 });
  const [first] = splits.live();
  // Nothing changed: the same divider.
  camera.emit('moveEnd');
  assert.equal(splits.live()[0], first);
  // A new port: rebuilt where it stood.
  swapGlobe(fakeGlobePort());
  camera.setPose({ height: 19_000 });
  camera.emit('moveEnd');
  const [second] = splits.live();
  assert.notEqual(second, first);
  assert.equal(first.destroyed, true);
  assert.equal(second.options.initialValue, 0.35);
  setLocale('sv');
  try {
    const [third] = splits.live();
    assert.notEqual(third, second, 'rebuilt for the new language');
    assert.equal(second.destroyed, true);
    assert.equal(third.options.initialValue, 0.35);
    assert.equal(third.options.afterLabel, 'Dagens karta');
  } finally {
    setLocale('en');
  }
  assert.equal(splits.live()[0].options.afterLabel, 'Today’s map');
  layer.destroy();
  setLocale('sv');
  setLocale('en');
  assert.equal(splits.live().length, 0, 'no listener after destroy');
});

test('THEN | NOW params round-trip and are validated; a move asks for one frame', async () => {
  const splits = fakeSplits();
  const { layer } = harness({ extra: splits.extra });
  layer.enable();
  await settle();
  assert.equal(layer.setParams({ swipe: 'yes' }), false);
  assert.equal(layer.setParams({ split: 1.5 }), false);
  assert.equal(layer.setParams({ split: -0.1 }), false);
  assert.equal(layer.setParams({ split: '0.4' }), false);
  assert.equal(layer.getParams().swipe, false);
  assert.equal(layer.setParams({ swipe: true, split: 0.25 }), true);
  assert.deepEqual(
    { swipe: layer.getParams().swipe, split: layer.getParams().split },
    { swipe: true, split: 0.25 },
  );
  const [split] = splits.live();
  assert.equal(split.value, 0.25);
  splits.frames.length = 0;
  layer.setParams({ split: 0.6 });
  assert.equal(split.value, 0.6);
  assert.deepEqual(splits.frames, ['historical-ortho-split']);
  layer.setParams({ split: 0.6 });
  assert.equal(splits.frames.length, 1, 'no frame for no change');
  // A layer restored from params keeps them.
  const again = harness({ extra: fakeSplits().extra });
  again.layer.setParams(layer.getParams());
  assert.deepEqual(again.layer.getParams(), layer.getParams());
});

test('without a divider factory the row offers no THEN | NOW', async () => {
  const { layer } = harness();
  layer.enable();
  await settle();
  assert.equal(
    layer.getRowControls().chips.some((entry) => entry.id === 'swipe'),
    false,
  );
});

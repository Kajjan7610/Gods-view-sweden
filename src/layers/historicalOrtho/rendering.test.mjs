// The historical aerial photos' renderer: proxy tiles through the globe
// port, bounded to Sweden and hidden below the minimum level, a shared
// semaphore of at most six requests, and rebinding with the map stack.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  HISTORICAL_ORTHO_Z,
  TILE_RENDER_REASON,
  createHistoricalOrthoRenderer,
} from './rendering.js';
import { SWEDEN_RECTANGLE, drapedLayers } from './model.js';
import { fakeGlobePort } from '../../testSupport/fakeGlobePort.mjs';

const template = (layerId) =>
  `/api/historiska-ortofoton/tile/${layerId}/{z}/{x}/{y}.png`;
const PHOTO_1960 = drapedLayers({ year: 1960, variant: 'bw' });
const SHEETS_1960 = drapedLayers({
  year: 1960,
  variant: 'bw',
  flightYears: true,
});

function fixture({ maxTileRequests, ...options } = {}) {
  const renders = [];
  const renderer = createHistoricalOrthoRenderer({
    tileTemplate: template,
    maxTileRequests,
    requestRender: (reason) => renders.push(reason),
    ...options,
  });
  const globe = fakeGlobePort();
  renderer.rebind({ collection: {}, kind: 'globe', globe });
  const tileFrames = () =>
    renders.filter((reason) => reason === TILE_RENDER_REASON).length;
  return { renderer, globe, renders, tileFrames };
}

function pendingFetches() {
  const pending = [];
  const fetch = () => new Promise((resolve) => pending.push(resolve));
  return { pending, fetch };
}

const tile = (x, level = 10) => ({ x, y: 0, level });

test('a photo drapes as 512 px web-mercator proxy tiles inside Sweden, hidden below level 9', () => {
  const { renderer, globe, renders } = fixture();
  assert.equal(renderer.show(PHOTO_1960), true);
  const [layer] = globe.layers;
  assert.equal(
    layer.spec.url,
    '/api/historiska-ortofoton/tile/1960/{z}/{x}/{y}.png',
  );
  assert.equal(layer.spec.kind, 'xyz');
  assert.equal(layer.spec.tiling, 'webMercator');
  assert.equal(layer.spec.tileSize, 512);
  assert.equal(layer.spec.minLevel, 9);
  assert.equal(layer.spec.hiddenBelowMinLevel, true);
  assert.equal(layer.spec.maxLevel, 16);
  assert.deepEqual(layer.spec.rectangle, SWEDEN_RECTANGLE);
  assert.deepEqual(layer.spec.credit, { text: '© Lantmäteriet (CC0)' });
  assert.equal(layer.spec.zOrder, HISTORICAL_ORTHO_Z.photo);
  assert.equal(typeof layer.spec.admit, 'function');
  assert.deepEqual(renders, ['historical-ortho-show']);
  // The same list keeps its layer.
  renderer.show(PHOTO_1960);
  assert.deepEqual(globe.layers, [layer]);
  assert.deepEqual(renders, ['historical-ortho-show']);
  // A 1 m year stops a level earlier.
  renderer.show(drapedLayers({ year: 1999, variant: 'bw' }));
  assert.equal(layer.removed, true);
  assert.equal(globe.layers.length, 1);
  assert.equal(globe.layers[0].spec.maxLevel, 15);
  assert.match(globe.layers[0].spec.url, /\/tile\/bw-1999\//);
});

test('flight years add the seams and sheets above the photo and leave the photo be', () => {
  const { renderer, globe } = fixture();
  renderer.show(PHOTO_1960);
  const [photo] = globe.layers;
  renderer.show(SHEETS_1960);
  assert.equal(photo.removed, false, 'the photo keeps its tiles');
  assert.deepEqual(
    globe.layers.map((layer) => layer.spec.url.split('/')[4]),
    ['1960', 'seams-1960', 'meta-1960'],
  );
  assert.deepEqual(renderer.getOwned(), {
    kind: 'globe',
    layerIds: ['1960', 'seams-1960', 'meta-1960'],
  });
  assert.ok(globe.layers.every((layer) => layer.spec.maxLevel <= 16));
  renderer.show(PHOTO_1960);
  assert.equal(globe.layers.length, 1);
  assert.equal(globe.layers[0], photo);
  renderer.hide();
  assert.equal(globe.layers.length, 0);
  assert.equal(renderer.ownedCount(), 0);
});

test('every layer shares one semaphore of at most six; a deferral asks for no frame', async () => {
  const { renderer, globe, tileFrames } = fixture({ maxTileRequests: 40 });
  renderer.show(SHEETS_1960);
  const [photo, seams, meta] = globe.layers;
  const { pending, fetch } = pendingFetches();
  const held = [];
  for (let i = 0; i < 6; i += 1)
    held.push([photo, seams, meta][i % 3].request(tile(i), fetch));
  assert.ok(held.every((promise) => promise instanceof Promise));
  for (let i = 0; i < 50; i += 1)
    assert.equal(meta.request(tile(100 + i), fetch), undefined);
  assert.equal(pending.length, 6, 'never more than six in flight');
  assert.equal(renderer.inFlight(), 6);
  assert.equal(tileFrames(), 0);
  pending[0]('tile');
  await held[0];
  assert.equal(tileFrames(), 1, 'the settlement asks for the retry frame');
  assert.ok(photo.request(tile(200), fetch) instanceof Promise);
  // A renderer deferral or throw frees its slot at once.
  for (let i = 1; i < 6; i += 1) pending[i]('tile');
  await Promise.all(held);
  assert.equal(
    photo.request(tile(300), () => undefined),
    undefined,
  );
  assert.throws(
    () =>
      photo.request(tile(301), () => {
        throw new Error('boom');
      }),
    /boom/,
  );
  pending.at(-1)('tile');
  await settleAll();
  assert.equal(renderer.inFlight(), 0);
});

const settleAll = () => new Promise((resolve) => setImmediate(resolve));

test('tile errors reach the listener with their layer id', () => {
  const heard = [];
  const { renderer, globe } = fixture();
  renderer.setTileErrorListener((error, layerId) =>
    heard.push([error.status, layerId]),
  );
  renderer.show(SHEETS_1960);
  globe.layers[0].fail({ status: 502 });
  globe.layers[2].fail({ status: 404 });
  assert.deepEqual(heard, [
    [502, '1960'],
    [404, 'meta-1960'],
  ]);
  const meta = globe.layers[2];
  renderer.hide();
  assert.equal(meta.listenerCount('tileError'), 0);
});

test('the layers follow the host: the tileset keeps them, no host removes them, a new port rebuilds them', () => {
  const { renderer, globe, renders } = fixture();
  renderer.show(SHEETS_1960);
  const layers = [...globe.layers];
  renders.length = 0;
  renderer.rebind({ collection: {}, kind: 'tileset', globe, tileset: {} });
  assert.deepEqual(globe.layers, layers, 'the port drapes them on the tiles');
  assert.equal(renderer.getOwned().kind, 'tileset');
  assert.deepEqual(renders, ['historical-ortho-rebind']);
  renderer.rebind({ collection: null, kind: 'none', globe });
  assert.equal(globe.layers.length, 0);
  assert.equal(renderer.show(PHOTO_1960), false, 'nowhere to drape');
  const other = fakeGlobePort();
  renderer.rebind({ collection: {}, kind: 'globe', globe: other });
  assert.equal(other.layers.length, 1, 'the wanted photo comes back');
  renderer.destroy();
  assert.equal(other.layers.length, 0);
  assert.equal(renderer.show(PHOTO_1960), false, 'destroyed');
});

test('a renderer needs a tile template', () => {
  assert.throws(() => createHistoricalOrthoRenderer({}), /tile template/);
});

test('a port that throws midway leaves no layer behind and throws nothing', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const { renderer, globe } = fixture();
    const add = globe.imagery.add;
    let calls = 0;
    globe.imagery.add = (spec) => {
      calls += 1;
      if (calls === 3) throw new Error('no more layers');
      return add(spec);
    };
    assert.doesNotThrow(() => renderer.show(SHEETS_1960));
    assert.equal(globe.layers.length, 0, 'the two added are removed');
    assert.equal(renderer.ownedCount(), 0);
    assert.match(String(renderer.failure()), /no more layers/);
    globe.imagery.add = add;
    renderer.show(SHEETS_1960);
    assert.equal(globe.layers.length, 3);
    assert.equal(renderer.failure(), null);
  } finally {
    console.warn = warn;
  }
});

test('without image hooks no admit is given; each layer takes a share of the budget', () => {
  const renderer = createHistoricalOrthoRenderer({ tileTemplate: template });
  const globe = fakeGlobePort();
  renderer.rebind({ collection: {}, kind: 'globe', globe, imageHooks: false });
  renderer.show(SHEETS_1960);
  assert.ok(globe.layers.every((layer) => layer.spec.admit === undefined));
  assert.ok(
    globe.layers.every((layer) => layer.spec.maxConcurrentRequests === 2),
  );
  // The same port with hooks rebuilds them with the semaphore.
  renderer.rebind({ collection: {}, kind: 'globe', globe, imageHooks: true });
  assert.ok(globe.layers.every((layer) => typeof layer.spec.admit === 'function'));
  assert.equal(globe.layers.length, 3);
});

test('a loaded tile is told to the load listener, a failed one is not', async () => {
  const { renderer, globe } = fixture();
  let loaded = 0;
  renderer.setTileLoadListener(() => (loaded += 1));
  renderer.show(PHOTO_1960);
  const [layer] = globe.layers;
  await layer.request(tile(0), () => Promise.resolve('tile'));
  await assert.rejects(
    layer.request(tile(1), () => Promise.reject(new Error('502'))),
  );
  await settleAll();
  assert.equal(loaded, 1);
});

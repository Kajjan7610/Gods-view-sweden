import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createBundledCableSource,
  createEmptyCableSource,
} from './bundledSource.js';

test('a failed bundled response releases its body', async () => {
  let released = 0;
  const source = createBundledCableSource({
    fetchImpl: async () => ({
      ok: false,
      status: 503,
      body: {
        cancel: async () => {
          released++;
        },
      },
    }),
  });
  await assert.rejects(source.fetch(), /HTTP 503/);
  assert.equal(released, 2);
});

test('cancellation during JSON parsing cannot return a late snapshot', async () => {
  const controller = new AbortController();
  const source = createBundledCableSource({
    fetchImpl: async () => ({
      ok: true,
      async json() {
        controller.abort();
        return { type: 'FeatureCollection', features: [] };
      },
    }),
  });
  await assert.rejects(source.fetch(controller.signal), { name: 'AbortError' });
});

test('the Swedish fork has no cables and asks nobody', async (t) => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('no request expected');
  });
  const { cables, landingPoints } = await createEmptyCableSource().fetch();
  assert.deepEqual(cables, { type: 'FeatureCollection', features: [] });
  assert.deepEqual(landingPoints, { type: 'FeatureCollection', features: [] });
  assert.equal(fetchMock.mock.callCount(), 0);
});

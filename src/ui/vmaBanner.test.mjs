// The VMA banner's controller: read when the page is looked at again, and
// an alert that can no longer be confirmed says when it last was.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../i18n/index.js';
import { bannerRows, createVmaBanner } from './vmaBanner.js';

const NOW = Date.parse('2026-11-05T14:00:00Z');
const POLL_MS = 2 * 60_000;
const VMA = {
  id: 'v1',
  headline: 'Brand i industribyggnad',
  areas: [{ type: 'Municipality', name: 'Arboga' }],
  web: 'https://www.krisinformation.se/v1',
};
const settle = async () => {
  for (let i = 0; i < 6; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

function harness(t, { hidden = false } = {}) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  t.mock.method(console, 'warn', () => {});
  const state = {
    now: NOW,
    hidden,
    down: false,
    stale: false,
    vmas: [VMA],
    calls: 0,
    rows: null,
    actions: null,
    listeners: new Map(),
  };
  const banner = createVmaBanner({
    publish: (rows) => {
      state.rows = rows;
    },
    connect: (actions) => {
      state.actions = actions;
      return () => {};
    },
    fetchImpl: async () => {
      state.calls += 1;
      if (state.down) return { ok: false, status: 503 };
      return {
        ok: true,
        json: async () => ({
          vmas: state.vmas,
          ...(state.stale ? { stale: true } : {}),
        }),
      };
    },
    documentRef: {
      get visibilityState() {
        return state.hidden ? 'hidden' : 'visible';
      },
      addEventListener: (type, listener) => state.listeners.set(type, listener),
      removeEventListener: (type) => state.listeners.delete(type),
    },
    now: () => state.now,
  });
  t.after(() => banner.destroy());
  const turn = async () => {
    state.now += POLL_MS;
    t.mock.timers.tick(POLL_MS);
    await settle();
  };
  return { state, turn };
}

test('rows name the alert, its area and its link', () => {
  assert.deepEqual(bannerRows({ vmas: [VMA] }), [
    {
      key: 'v1',
      headline: 'Brand i industribyggnad',
      area: 'Arboga',
      url: 'https://www.krisinformation.se/v1',
      note: '',
    },
  ]);
  assert.deepEqual(bannerRows({ vmas: [VMA] }, new Set(['v1'])), []);
  assert.deepEqual(bannerRows(null), []);
});

test('a page looked at again reads the alerts at once', async (t) => {
  const { state, turn } = harness(t, { hidden: true });
  await settle();
  // Hidden: nothing is read, at the start or at a turn.
  await turn();
  assert.equal(state.calls, 0);
  // Back: read now, not at the next turn two minutes away.
  state.hidden = false;
  state.listeners.get('visibilitychange')();
  await settle();
  assert.equal(state.calls, 1);
  assert.equal(state.rows[0].headline, 'Brand i industribyggnad');
});

test('an alert that can no longer be confirmed stays, and says when it last was', async (t) => {
  // In Swedish, as the banner is read: a 24-hour clock.
  setLocale('sv');
  t.after(() => setLocale('en'));
  const { state, turn } = harness(t);
  await settle();
  assert.equal(state.rows[0].note, '');
  // Krisinformation stops answering: the alert stays, and from five minutes
  // on it says when it was last confirmed (15:00 Swedish time).
  state.down = true;
  await turn();
  await turn();
  assert.equal(state.rows.length, 1);
  assert.equal(state.rows[0].note, '');
  await turn();
  assert.equal(state.rows[0].note, 'Uppdaterad 15:00');
  // The proxy's last known answer confirms nothing new either.
  state.down = false;
  state.stale = true;
  await turn();
  assert.equal(state.rows[0].note, 'Uppdaterad 15:00');
  // A fresh answer: confirmed again, and an ended alert goes.
  state.stale = false;
  await turn();
  assert.equal(state.rows[0].note, '');
  state.vmas = [];
  await turn();
  assert.deepEqual(state.rows, []);
});

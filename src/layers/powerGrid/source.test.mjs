import assert from 'node:assert/strict';
import test from 'node:test';
import { createPowerGridSource } from './source.js';

const AT = Date.UTC(2026, 10, 10, 9, 0);

/** A source whose proxy answers `body` for every route. */
const sourceAnswering = (body, status = 200) =>
  createPowerGridSource({
    fetchImpl: async () => new Response(JSON.stringify(body), { status }),
  });

test('the week says when the server answered from an older read', async () => {
  const days = [{ date: '2026-11-10', points: [{ at: AT }, { at: 'x' }] }];
  const stale = await sourceAnswering({ days, stale: true }).getWeek();
  assert.equal(stale.stale, true);
  assert.deepEqual(stale.days, [{ date: '2026-11-10', points: [{ at: AT }] }]);
  const fresh = await sourceAnswering({ days }).getWeek();
  assert.equal(fresh.stale, false);
});

test('the day keeps its stale mark and drops points without a time', async () => {
  const day = await sourceAnswering({
    date: '2026-11-10',
    points: [{ at: AT }, { at: null }],
    stale: true,
  }).getDay();
  assert.deepEqual(day, {
    date: '2026-11-10',
    points: [{ at: AT }],
    stale: true,
  });
});

test('a failed day or week read throws with the status', async () => {
  const source = sourceAnswering({ error: 'power_grid_day_unavailable' }, 502);
  await assert.rejects(source.getDay(), { status: 502 });
  await assert.rejects(source.getWeek(), { status: 502 });
});

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

test('the snapshot and the day say when they come from ENTSO-E without production', async () => {
  const entsoe = await sourceAnswering({
    links: [],
    areas: [],
    production: null,
    source: 'entsoe',
    productionOffered: false,
  }).getSnapshot();
  assert.equal(entsoe.source, 'entsoe');
  assert.equal(entsoe.productionOffered, false);
  const svk = await sourceAnswering({ links: [], areas: [] }).getSnapshot();
  assert.equal('source' in svk, false);
  assert.equal('productionOffered' in svk, false);
  const day = await sourceAnswering({
    date: '2026-11-11',
    points: [],
    source: 'entsoe',
    productionOffered: false,
  }).getDay();
  assert.equal(day.productionOffered, false);
  assert.equal(day.source, 'entsoe');
});

test('a missing or refused ENTSO-E key says what to do', async () => {
  const missing = sourceAnswering({ error: 'not_configured' }, 503);
  await assert.rejects(missing.getSnapshot(), {
    message: 'ENTSO-E key not configured (set ENTSOE_SECURITY_TOKEN)',
    notConfigured: true,
  });
  const refused = sourceAnswering(
    { error: 'power_grid_unavailable', keyRefused: true },
    502,
  );
  await assert.rejects(refused.getSnapshot(), {
    message: 'ENTSO-E refused the key (check ENTSOE_SECURITY_TOKEN)',
  });
  const down = sourceAnswering({ error: 'power_grid_unavailable' }, 502);
  await assert.rejects(down.getSnapshot(), {
    message: 'Power grid unavailable (HTTP 502)',
  });
});

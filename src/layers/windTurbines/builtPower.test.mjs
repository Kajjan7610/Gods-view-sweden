// The wind turbines row never says "0 MW" for built turbines: the power keeps
// the register's precision, the built turbines it gives no power for are
// counted rather than taken as 0, and a view without a built turbine of known
// power says nothing about megawatts at all.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { setLocale } from '../../i18n/index.js';
import {
  createWindTurbinesLayer,
  createWindTurbinesSource,
  turbinesInView,
} from './index.js';

const SNAPSHOT_AT = Date.parse('2026-11-20');
const BBOX = [17, 62, 18, 63];
const CENTER = [17.3, 62.4];
const turbine = (id, kind, powerMW) => ({
  id,
  point: [17.3, 62.4],
  status: 0,
  kind,
  powerMW,
});

/** The layer on a view low enough to read, answering with `answer`. */
async function rowInfo(answer) {
  const viewer = { canvas: { clientWidth: 800, clientHeight: 600 } };
  const camera = fakeCameraPort({
    pose: { lon: 17.3, lat: 62.4, height: 50_000 },
    viewRectangle: { west: 16, south: 61, east: 19, north: 63.5 },
  });
  bindFakeDraw(viewer, {
    camera: camera.port,
    query: { pickEllipsoid: () => fromDegrees(17.3, 62.4) },
  });
  const layer = createWindTurbinesLayer({
    source: {
      getSnapshot: async () => ({
        turbines: [],
        total: 2,
        builtMW: null,
        builtPowerUnknown: null,
        counts: { built: 2 },
        tooWide: false,
        capped: false,
        stale: false,
        fetchedAt: SNAPSHOT_AT,
        updated: null,
        ...answer,
      }),
    },
  });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  try {
    return layer.getRowControls().info;
  } finally {
    layer.destroy();
  }
}

test('a view sums the built power to a kilowatt and counts the unknown', () => {
  const view = turbinesInView(
    [
      turbine('a', 'built', 0.04),
      turbine('b', 'built', null),
      turbine('c', 'planned', 3),
    ],
    { bbox: BBOX, center: CENTER, kinds: ['built', 'planned'] },
  );
  assert.equal(view.builtMW, 0.04, 'not rounded to 0');
  assert.equal(view.builtPowerUnknown, 1, 'the built one without power');
  assert.equal(view.total, 3);
  // Sums of the register's kilowatts carry no floating-point dust.
  const sum = turbinesInView(
    [turbine('a', 'built', 0.1), turbine('b', 'built', 0.2)],
    { bbox: BBOX, center: CENTER },
  );
  assert.equal(sum.builtMW, 0.3);
  assert.equal(sum.builtPowerUnknown, 0);
});

test('the source passes the unknown count on, and none when the route has none', async () => {
  const answers = [
    { turbines: [], builtMW: 0.04, builtPowerUnknown: 1 },
    { turbines: [], builtMW: 0.04 },
  ];
  const source = createWindTurbinesSource({
    fetchImpl: async () => new Response(JSON.stringify(answers.shift())),
  });
  const query = { bbox: [16, 61, 19, 63.5], center: CENTER };
  const view = await source.getSnapshot(query);
  assert.equal(view.builtMW, 0.04);
  assert.equal(view.builtPowerUnknown, 1);
  assert.equal((await source.getSnapshot(query)).builtPowerUnknown, null);
});

test('built {0.04 MW, unknown} reads 0.04 MW and one without a stated power', async () => {
  const answer = { builtMW: 0.04, builtPowerUnknown: 1 };
  assert.equal(
    await rowInfo(answer),
    '2 wind turbines in view · built 0.04 MW · 1 built turbine without a stated power · Snapshot Nov 20, 2026',
  );
  setLocale('sv');
  try {
    assert.match(
      await rowInfo(answer),
      /^2 vindkraftverk i vyn · uppförda 0,04 MW · 1 uppfört verk utan angiven effekt · /,
    );
  } finally {
    setLocale('en');
  }
});

test('the power keeps two significant digits under 10 MW, whole MW above', async () => {
  for (const [builtMW, shown] of [
    [0.045, 'built 0.045 MW'],
    [5.64, 'built 5.6 MW'],
    [9.96, 'built 10 MW'],
    [12.4, 'built 12 MW'],
    [1234.6, 'built 1,235 MW'],
  ])
    assert.match(await rowInfo({ builtMW }), new RegExp(` · ${shown} · `));
});

test('no "0 MW" while built turbines are in view, nor for planned ones alone', async () => {
  const cases = [
    // Every built turbine without a stated power.
    [
      { builtMW: 0, builtPowerUnknown: 2 },
      '2 wind turbines in view · 2 built turbines without a stated power · Snapshot Nov 20, 2026',
    ],
    // A route from before the unknown count, all of its power unknown.
    [{ builtMW: 0 }, '2 wind turbines in view · Snapshot Nov 20, 2026'],
    // Planned turbines only: no built power to speak of.
    [
      { builtMW: 0, builtPowerUnknown: 0, total: 3, counts: { planned: 3 } },
      '3 wind turbines in view · Snapshot Nov 20, 2026',
    ],
  ];
  for (const [answer, info] of cases) {
    const shown = await rowInfo(answer);
    assert.equal(shown, info);
    assert.doesNotMatch(shown, /(^|[^\d.,])0 MW/);
  }
});

// The wind turbines layer: read for views low enough, built turbines by
// default and the chips for the rest, one card at a time (filled in once the
// turbine's full row is read), and what the analyst reads.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';
import { fromDegrees } from '../../geo/ellipsoid.js';
import * as picking from '../../data/pickRegistry.js';
import {
  TURBINE_KIND,
  WIND_TURBINES_LAYER_ID,
  WIND_TURBINES_OVERLAY_SOURCE_ID,
  buildTurbineCard,
  compactTurbine,
  expandTurbine,
  createWindTurbinesLayer,
  createWindTurbinesSource,
  statusCode,
  statusWords,
} from './index.js';

/** Full rows, as the detail route gives them. */
const FULL = [
  {
    id: '2262-V-004-012',
    point: [17.3, 62.4],
    status: statusCode('Uppfört'),
    kind: 'built',
    totalHeightM: 200,
    hubHeightM: 120,
    rotorM: 160,
    powerMW: 5.6,
    productionGWh: 17.25,
    make: 'Vestas',
    model: 'V162',
    built: '2019-11-01',
    project: 'Vindpark Exempelberget',
    municipality: 'Timrå',
    county: 'Västernorrlands län',
    zone: 'SE2',
    updated: '2026-04-02',
    operator: 'Exempel Vind AB',
  },
  {
    id: '2262-V-004-013',
    point: [17.32, 62.41],
    status: statusCode('Handläggs'),
    kind: 'planned',
    totalHeightM: null,
    hubHeightM: null,
    rotorM: null,
    powerMW: null,
    productionGWh: null,
    make: null,
    model: null,
    built: null,
    project: null,
    municipality: 'Timrå',
    county: 'Västernorrlands län',
    zone: null,
    updated: null,
    operator: null,
  },
];
/** The rows a view carries: what a dot and its name need. */
const VIEW = FULL.map((row) => ({
  id: row.id,
  point: row.point,
  status: row.status,
  kind: row.kind,
  totalHeightM: row.totalHeightM,
  powerMW: row.powerMW,
  project: row.project,
  municipality: row.municipality,
}));
const SNAPSHOT_AT = Date.parse('2026-11-20');
const settle = () => new Promise((resolve) => setImmediate(resolve));

function harness({ height = 50_000, answer = {}, details = true } = {}) {
  const reads = [];
  const detailReads = [];
  const state = { cards: [], cardHit: null, click: null, picked: null };
  const viewer = { canvas: { clientWidth: 800, clientHeight: 600 } };
  const camera = fakeCameraPort({
    pose: { lon: 17.3, lat: 62.4, height },
    viewRectangle: { west: 16, south: 61, east: 19, north: 63.5 },
  });
  const { draw } = bindFakeDraw(viewer, {
    camera: camera.port,
    query: { pickEllipsoid: () => fromDegrees(17.3, 62.4) },
  });
  const source = {
    getSnapshot: async (query) => {
      reads.push(query);
      const kinds = new Set(query.kinds);
      const turbines = FULL.filter((row) => kinds.has(row.kind)).map(
        compactTurbine,
      );
      return {
        turbines,
        total: turbines.length,
        builtMW: 5.6,
        counts: { built: 1, planned: 1, rejected: 3 },
        tooWide: false,
        capped: false,
        stale: false,
        fetchedAt: SNAPSHOT_AT,
        updated: '2026-11-02',
        ...answer,
      };
    },
  };
  if (details)
    source.getTurbine = async ({ id }) => {
      detailReads.push(id);
      return FULL.find((row) => row.id === id);
    };
  const layer = createWindTurbinesLayer({
    source,
    overlayHost: {
      setEntries(sourceId, entries) {
        assert.equal(sourceId, WIND_TURBINES_OVERLAY_SOURCE_ID);
        state.cards = entries;
      },
      clearSource: () => (state.cards = []),
      setVisible() {},
      hitTest: () => state.cardHit,
    },
    input: () => ({
      onClick(callback) {
        state.click = () =>
          callback({
            screenPosition: { x: 1, y: 1 },
            topHit: state.picked
              ? {
                  set: WIND_TURBINES_LAYER_ID,
                  id: state.picked,
                  surface: false,
                }
              : null,
          });
        return () => (state.click = null);
      },
    }),
    picking,
  });
  layer.init(viewer);
  const dots = () => draw.set(WIND_TURBINES_LAYER_ID);
  const items = () => [...(dots()?.items.values() ?? [])];
  return { layer, camera, state, reads, detailReads, dots, items };
}

test('built turbines are drawn by default, the view cut to its span', async () => {
  const { layer, reads, dots, items } = harness();
  assert.equal(dots().kind, 'points');
  assert.equal(dots().spec.horizonCull, true);
  assert.equal(dots().show, false);
  layer.enable();
  await layer.update();
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0].kinds, ['built']);
  assert.equal(reads[0].limit, 1500);
  const [w, s, e, n] = reads[0].bbox;
  assert.ok(e - w <= 4 + 1e-9 && n - s <= 4 + 1e-9);
  const drawn = items();
  assert.equal(drawn.length, 1);
  assert.equal(drawn[0].id, 'se-wind-turbine:2262-V-004-012');
  assert.equal(drawn[0].color, TURBINE_KIND.built.color);
  assert.equal(drawn[0].pixelSize, 10, 'a 200 m turbine reads large');
  assert.equal(drawn[0].height, 'clampGround');
  const controls = layer.getRowControls();
  assert.deepEqual(
    controls.chips.map(({ id, active }) => [id, active]),
    [
      ['planned', false],
      ['dismantled', false],
      ['rejected', false],
      ['notCurrent', false],
    ],
  );
  assert.deepEqual(
    controls.legend.map(({ label, count }) => `${label} ${count}`),
    ['Built turbines 1'],
  );
  assert.match(controls.legend[0].blurb, /Vindbrukskollen/);
  assert.equal(
    controls.info,
    '1 wind turbines in view · built 5.6 MW · Snapshot Nov 20, 2026',
  );
  assert.equal(layer.getStats().count, 1);
  assert.equal(layer.getStats().lastUpdate, SNAPSHOT_AT);
  layer.destroy();
});

test('the planned chip asks for the planned turbines too', async () => {
  const { layer, reads, items } = harness();
  layer.enable();
  await layer.update();
  layer.getRowControls().chips[0].onClick();
  await settle();
  assert.deepEqual(reads.at(-1).kinds, ['built', 'planned']);
  assert.equal(items().length, 2);
  const controls = layer.getRowControls();
  assert.equal(controls.chips[0].active, true);
  assert.deepEqual(
    controls.legend.map(({ label, count }) => `${label} ${count}`),
    ['Built turbines 1', 'Planned – not built 1'],
  );
  assert.match(controls.info, /built 5\.6 MW/, 'planned power is not summed');
  const dot = items().find((item) => item.id.endsWith('-013'));
  assert.equal(dot.color, TURBINE_KIND.planned.color);
  assert.equal(dot.pixelSize, 6, 'no height given');
  layer.destroy();
});

test('a high view reads nothing and asks to zoom in', async () => {
  const { layer, reads, items } = harness({ height: 400_000 });
  layer.enable();
  await layer.update();
  assert.equal(reads.length, 0);
  assert.equal(items().length, 0);
  const controls = layer.getRowControls();
  assert.equal(
    controls.info,
    'Zoom in to see the wind turbines: they show below 250 km',
  );
  assert.equal(controls.chips.length, 4, 'the chips stay');
  assert.equal(layer.getStats().count, null);
});

test('a capped view asks to zoom in for the rest', async () => {
  const { layer } = harness({ answer: { capped: true } });
  layer.enable();
  await layer.update();
  assert.match(layer.getRowControls().info, /^Zoom in to see every turbine/);
});

test('a camera move reads the view again once it settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { layer, camera, reads, items } = harness();
  layer.enable();
  await layer.update();
  camera.setPose({ height: 400_000 });
  camera.emit('moveEnd');
  t.mock.timers.tick(400);
  await settle();
  assert.equal(reads.length, 1);
  assert.equal(items().length, 0);
  camera.setPose({ height: 20_000 });
  camera.emit('moveEnd');
  t.mock.timers.tick(400);
  await settle();
  assert.equal(reads.length, 2);
  assert.equal(items().length, 1);
  layer.disable();
  assert.equal(camera.listenerCount('moveEnd'), 0);
  layer.destroy();
});

test('a click shows the card at once and fills it from the full row', async () => {
  const { layer, state, detailReads } = harness();
  layer.enable();
  await layer.update();
  state.picked = 'se-wind-turbine:2262-V-004-012';
  state.click();
  assert.equal(state.cards.length, 1);
  assert.equal(state.cards[0].title, 'WIND TURBINE · VINDPARK EXEMPELBERGET');
  assert.doesNotMatch(state.cards[0].details.join(' '), /Operator/);
  await settle();
  assert.deepEqual(detailReads, ['2262-V-004-012']);
  const card = state.cards[0];
  const text = card.details.join(' ');
  for (const line of [
    'Status: Erected',
    'Total height 200 m · Hub height 120 m',
    'Rotor diameter 160 m',
    '5.6 MW rated · Calculated production 17.3 GWh/yr',
    'Make: Vestas V162',
    'Built in 2019',
    'Timrå, Västernorrlands län',
    'Bidding zone SE2',
    'Operator: Exempel Vind AB',
    'Updated in Vindbrukskollen Apr 2, 2026',
    'Source: Länsstyrelserna, Vindbrukskollen (CC0)',
    'Snapshot Nov 20, 2026',
  ])
    assert.ok(text.includes(line), line);
  assert.equal(card.accent, TURBINE_KIND.built.color);
  assert.ok(card.position, 'the card sits on the turbine');

  // A second click uses the row already read.
  state.picked = null;
  state.click();
  assert.deepEqual(state.cards, []);
  state.picked = 'se-wind-turbine:2262-V-004-012';
  state.click();
  await settle();
  assert.equal(detailReads.length, 1);
  assert.match(state.cards[0].details.join(' '), /Operator: Exempel Vind AB/);

  // A click on a card is not the ground.
  state.cardHit = { sourceId: 'hospitals', entryId: 'x' };
  state.picked = null;
  state.click();
  assert.equal(state.cards.length, 1);
  state.cardHit = null;
  state.click();
  assert.deepEqual(state.cards, []);
  layer.destroy();
});

test('without a detail reader the card shows what the view carries', async () => {
  const { layer, state } = harness({ details: false });
  layer.enable();
  await layer.update();
  assert.equal(layer.setParams({ turbineId: '2262-V-004-012' }), true);
  await settle();
  const text = state.cards[0].details.join(' ');
  assert.match(text, /Status: Erected/);
  assert.match(text, /Total height 200 m/);
  layer.destroy();
});

test('a card states a status neutrally and leaves out what is not known', () => {
  const card = buildTurbineCard(FULL[1]);
  assert.equal(card.title, 'WIND TURBINE · TIMRÅ');
  const text = card.details.join(' ');
  assert.match(
    text,
    /Status: Planned – not built \(application being processed\)/,
  );
  assert.doesNotMatch(text, /Operator|Make|Built in|Snapshot|Bidding/);
  // A planned or withdrawn turbine has no build year, whatever its date.
  const withdrawn = {
    ...FULL[0],
    status: statusCode('Inte aktuellt eller återkallat'),
    kind: 'withdrawn',
  };
  assert.doesNotMatch(
    buildTurbineCard(withdrawn).details.join(' '),
    /Built in/,
  );
  assert.equal(
    statusWords({ status: statusCode('Avslag') }),
    'Application rejected (per Vindbrukskollen)',
  );
  assert.equal(
    statusWords({ status: statusCode('Inte aktuellt eller återkallat') }),
    'Not current or withdrawn (per Vindbrukskollen)',
  );
  assert.equal(
    statusWords({ status: statusCode('Nedmonterat') }),
    'Dismantled',
  );
  assert.equal(statusWords({ status: 99 }), 'Status not given');
});

test('an open card is rebuilt when the language changes', async () => {
  const { layer, state } = harness();
  layer.enable();
  await layer.update();
  assert.equal(layer.setParams({ turbineId: '2262-V-004-012' }), true);
  assert.equal(layer.setParams({ turbineId: 'nope' }), false);
  await settle();
  const first = state.cards[0];
  const { setLocale } = await import('../../i18n/index.js');
  try {
    await setLocale('sv');
    assert.notEqual(state.cards[0], first, 'a new card was published');
    assert.equal(
      state.cards[0].title,
      'VINDKRAFTVERK · VINDPARK EXEMPELBERGET',
    );
    const text = state.cards[0].details.join(' ');
    assert.ok(text.includes('Status: Uppfört'));
    assert.ok(text.includes('Verksamhetsutövare: Exempel Vind AB'));
  } finally {
    await setLocale('en');
  }
  layer.destroy();
});

test('findByQuery and the analyst name a turbine as its card does', async () => {
  const { layer, state } = harness();
  layer.enable();
  await layer.update();
  assert.deepEqual(layer.findByQuery('se-wind-turbine:2262-V-004-012'), {
    name: 'Wind turbine · Vindpark Exempelberget',
    latitude: 62.4,
    longitude: 17.3,
  });
  assert.equal(layer.findByQuery('se-wind-turbine:nope'), null);
  assert.equal(layer.findByQuery('se-hospital:1'), null);
  const [before] = layer.getAnalystRecords();
  assert.equal(before.turbineStatus, 'Erected');
  assert.equal(before.totalHeightM, 200);
  assert.equal(before.ratedPowerMW, 5.6);
  assert.equal(before.municipality, 'Timrå');
  assert.equal(before.turbineOperator, null, 'not in the view’s rows');
  // A clicked turbine gives the analyst every card field.
  state.picked = 'se-wind-turbine:2262-V-004-012';
  state.click();
  await settle();
  const [record] = layer.getAnalystRecords();
  assert.deepEqual(record, {
    id: '2262-V-004-012',
    name: 'Wind turbine · Vindpark Exempelberget',
    lat: 62.4,
    lon: 17.3,
    turbineStatus: 'Erected',
    totalHeightM: 200,
    hubHeightM: 120,
    rotorDiameterM: 160,
    ratedPowerMW: 5.6,
    productionGWhYear: 17.25,
    turbineModel: 'Vestas V162',
    builtYear: 2019,
    municipality: 'Timrå',
    county: 'Västernorrlands län',
    biddingZone: 'SE2',
    turbineOperator: 'Exempel Vind AB',
  });
  layer.disable();
  assert.deepEqual(layer.getAnalystRecords(), []);
  layer.destroy();
});

test('a failed read is an error in the layer’s status', async () => {
  const failing = createWindTurbinesLayer({
    source: {
      getSnapshot: async () => {
        throw new Error('Wind turbines unavailable (HTTP 502)');
      },
    },
  });
  const viewer = { canvas: { clientWidth: 800, clientHeight: 600 } };
  const camera = fakeCameraPort({
    pose: { lon: 17.3, lat: 62.4, height: 50_000 },
    viewRectangle: { west: 16, south: 61, east: 19, north: 63.5 },
  });
  bindFakeDraw(viewer, { camera: camera.port });
  failing.init(viewer);
  failing.enable();
  const warn = console.warn;
  console.warn = () => {};
  try {
    await failing.update();
  } finally {
    console.warn = warn;
  }
  assert.equal(
    failing.getStats().error,
    'Wind turbines unavailable (HTTP 502)',
  );
  failing.destroy();
});

test('the source asks the same-origin routes for a view and for one turbine', async () => {
  const urls = [];
  const answers = [
    {
      turbines: FULL.map(compactTurbine),
      total: 2,
      builtMW: 5.6,
      counts: { built: 1, planned: 1, bogus: 'x' },
      capped: false,
      tooWide: false,
      fetchedAt: SNAPSHOT_AT,
      updated: '2026-11-02',
    },
    null,
    { turbine: FULL[0], fetchedAt: SNAPSHOT_AT },
  ];
  const source = createWindTurbinesSource({
    fetchImpl: async (url) => {
      urls.push(url);
      const answer = answers[urls.length - 1];
      return answer
        ? new Response(JSON.stringify(answer))
        : { ok: false, status: 502, body: null };
    },
  });
  const view = await source.getSnapshot({
    bbox: [16.123456, 61, 19, 63.5],
    center: [17.3, 62.4],
    kinds: ['built', 'planned'],
    limit: 1500,
  });
  assert.match(urls[0], /^\/api\/wind-turbines\?/);
  const params = new URL(urls[0], 'http://x').searchParams;
  assert.equal(params.get('bbox'), '16.1235,61,19,63.5');
  assert.equal(params.get('kinds'), 'built,planned');
  assert.equal(params.get('limit'), '1500');
  assert.deepEqual(
    view.turbines,
    FULL.map(compactTurbine),
    'compact rows as sent',
  );
  assert.deepEqual(view.turbines.map(expandTurbine), VIEW);
  assert.deepEqual(view.counts, { built: 1, planned: 1 });
  assert.equal(view.builtMW, 5.6);
  assert.equal(view.fetchedAt, SNAPSHOT_AT);
  await assert.rejects(
    source.getSnapshot({ bbox: [16, 61, 19, 63.5], center: [17.3, 62.4] }),
    /Wind turbines unavailable \(HTTP 502\)/,
  );
  const row = await source.getTurbine({ id: '2262-V-004-012' });
  assert.equal(urls[2], '/api/wind-turbines/turbine?id=2262-V-004-012');
  assert.equal(row.operator, 'Exempel Vind AB');
  await assert.rejects(source.getSnapshot({}), /need a view/);
});

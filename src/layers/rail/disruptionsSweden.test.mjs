// Swedish fork: Trafikverket's railway disruptions in the Rail layer. One
// points set on the affected stations, a chip and a legend row, and a card
// on click with what Trafikverket publishes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { publicRailCatalog } from '../../data/railFeeds.js';
import {
  RAIL_DISRUPTIONS_OVERLAY_SOURCE_ID,
  RAIL_DISRUPTIONS_REFRESH_MS,
  RAIL_DISRUPTION_COLOR,
  buildRailDisruptionCopy,
  disruptionClock,
} from './disruptions.js';
import { railLayerHarness as harness } from '../../testSupport/railLayerHarness.mjs';

const STOCKHOLM = Object.freeze({ lat: 59.33, lon: 18.07 });
const T = (clock) => Date.parse(`2026-11-17T${clock}:00+01:00`);
const ELFEL = Object.freeze({
  id: 'O261117-001',
  reason: 'Kontaktledning',
  header: 'Elfel: Stockholm C-Uppsala C',
  description: 'Inga tåg kan köra mellan Stockholm C och Uppsala C.',
  stretch: 'Stockholm C – Uppsala C',
  stations: ['Stockholm C', 'Uppsala C'],
  moreStations: 0,
  start: T('09:12'),
  end: T('14:00'),
  endKind: 'impact',
  resumption: null,
  updated: T('11:45'),
});
const SPARFEL = Object.freeze({
  id: 'O261117-002',
  reason: 'Spårfel',
  header: null,
  description: null,
  stretch: 'Stockholm C – Södertälje C',
  stations: ['Stockholm C'],
  moreStations: 0,
  start: T('10:00'),
  end: T('12:30'),
  endKind: 'forecast',
  resumption: T('13:00'),
  updated: T('11:00'),
});
const SNAPSHOT = Object.freeze({
  fetchedAt: 0,
  stale: false,
  disruptions: [ELFEL, SPARFEL],
  places: [
    {
      id: 'Cst',
      name: 'Stockholm C',
      lat: 59.3303,
      lon: 18.0581,
      disruptions: [ELFEL.id, SPARFEL.id],
    },
    {
      id: 'U',
      name: 'Uppsala C',
      lat: 59.8586,
      lon: 17.6454,
      disruptions: [ELFEL.id],
    },
  ],
});

/** A Rail layer over Stockholm whose server offers Sweden's trains. */
async function sweden(t, options = {}) {
  // Polls of feeds the harness does not answer, and failed asks, warn.
  t.mock.method(console, 'warn', () => {});
  const app = harness(t, {
    at: STOCKHOLM,
    disruptions: () => SNAPSHOT,
    ...options,
  });
  app.feeds.set('trafikverket-trains', () => []);
  await app.enable();
  return app;
}

const dotsOf = (app) => app.draw.find('rail-disruptions-');
const chipOf = (app) =>
  app.layer
    .getRowControls()
    .chips.find((chip) => chip.id === 'rail-disruptions');
const legendOf = (app) =>
  app.layer
    .getRowControls()
    .legend.find((item) => item.color === RAIL_DISRUPTION_COLOR);

test('the disruptions are one set of dots on the affected stations', async (t) => {
  const app = await sweden(t);
  assert.equal(app.disruptionRequests.length, 1, 'asked once on arrival');
  const dots = dotsOf(app);
  assert.ok(dots, 'one points set');
  assert.equal(dots.kind, 'points');
  assert.equal(dots.show, true);
  assert.equal(dots.spec.clampTo, 'terrain', 'never clamped to the 3D tiles');
  assert.deepEqual(
    [...dots.items.keys()],
    ['se-rail-disruption:Cst', 'se-rail-disruption:U'],
  );
  const cst = dots.items.get('se-rail-disruption:Cst');
  assert.equal(cst.color, RAIL_DISRUPTION_COLOR);
  assert.deepEqual([cst.pos.lat, cst.pos.lon], [59.3303, 18.0581]);
  // The chip, on by default, and the legend row with the count.
  const chip = chipOf(app);
  assert.equal(chip.active, true);
  assert.equal(chip.label, 'DISRUPTIONS');
  assert.equal(legendOf(app).count, 2);
});

test('asked at most once every two minutes; an unchanged answer writes nothing', async (t) => {
  const app = await sweden(t);
  const dots = dotsOf(app);
  const writes = dots.writes;
  await app.poll();
  await app.poll();
  assert.equal(app.disruptionRequests.length, 1);
  t.mock.timers.tick(RAIL_DISRUPTIONS_REFRESH_MS);
  await app.poll();
  assert.equal(app.disruptionRequests.length, 2);
  assert.equal(dots.writes, writes, 'the same snapshot is not drawn again');
  // No per-frame work: frames leave the set alone.
  app.run(2000);
  assert.equal(dots.writes, writes);
});

test('a click on a dot opens its card; a click on the map closes it', async (t) => {
  const app = await sweden(t);
  const dots = dotsOf(app);
  app.click({
    set: dots.spec.id,
    id: 'se-rail-disruption:Cst',
    surface: false,
  });
  const [card] = app.overlayEntries.get(RAIL_DISRUPTIONS_OVERLAY_SOURCE_ID);
  assert.equal(card.title, '⚠ Rail disruption · Stockholm C');
  assert.equal(card.accent, RAIL_DISRUPTION_COLOR);
  assert.ok(card.details.includes('Elfel: Stockholm C-Uppsala C'));
  assert.ok(card.details.includes('Stretch: Stockholm C – Uppsala C'));
  assert.equal(card.details.at(-1), 'Source: Trafikverket');
  // Both of the station's disruptions, the newest first.
  assert.ok(card.details.includes('Spårfel'));
  assert.ok(
    card.details.indexOf('Elfel: Stockholm C-Uppsala C') <
      card.details.indexOf('Spårfel'),
  );
  // The Context panel and the assistant name the dot, not its id.
  const { layer } = app;
  assert.deepEqual(layer.findByQuery('se-rail-disruption:Cst'), {
    name: 'Rail disruption · Stockholm C',
    latitude: 59.3303,
    longitude: 18.0581,
  });
  assert.equal(layer.findByQuery('se-rail-disruption:nowhere'), null);
  assert.equal(layer.findByQuery('Stockholm'), null);
  app.click(null);
  assert.deepEqual(
    app.overlayEntries.get(RAIL_DISRUPTIONS_OVERLAY_SOURCE_ID),
    [],
  );
});

test('the chip hides the dots and stops asking; showing them asks again when due', async (t) => {
  const app = await sweden(t);
  const dots = dotsOf(app);
  app.click({ set: dots.spec.id, id: 'se-rail-disruption:U', surface: false });
  chipOf(app).onClick();
  assert.equal(dots.show, false);
  assert.equal(chipOf(app).active, false);
  assert.equal(legendOf(app), undefined);
  assert.deepEqual(
    app.overlayEntries.get(RAIL_DISRUPTIONS_OVERLAY_SOURCE_ID),
    [],
    'the open card closes',
  );
  t.mock.timers.tick(RAIL_DISRUPTIONS_REFRESH_MS);
  await app.poll();
  assert.equal(app.disruptionRequests.length, 1, 'nothing asked while hidden');
  chipOf(app).onClick();
  await app.settle();
  assert.equal(dots.show, true);
  assert.equal(app.disruptionRequests.length, 2);
});

test('without Sweden in the catalog (no key) there is no chip and nothing is asked', async (t) => {
  const app = await sweden(t, {
    catalog: publicRailCatalog({ keyConfigured: () => false }),
  });
  assert.equal(chipOf(app), undefined);
  assert.equal(legendOf(app), undefined);
  await app.poll();
  assert.equal(app.disruptionRequests.length, 0);
  assert.equal(dotsOf(app).show, false);
});

test('away from Sweden nothing is asked; switching the layer off clears it', async (t) => {
  const app = await sweden(t, { at: { lat: 42.3601, lon: -71.0589 } });
  await app.poll();
  assert.equal(app.disruptionRequests.length, 0);
  await app.moveCamera(STOCKHOLM);
  assert.equal(app.disruptionRequests.length, 1);
  assert.equal(dotsOf(app).items.size, 2);
  app.layer.disable(app.viewer);
  assert.equal(dotsOf(app).items.size, 0);
  assert.equal(dotsOf(app).show, false);
});

test('a failed ask is not repeated for two minutes', async (t) => {
  let fail = true;
  const app = await sweden(t, {
    disruptions: () => {
      if (fail) throw new Error('Rail disruptions HTTP 502');
      return SNAPSHOT;
    },
  });
  await app.poll();
  assert.equal(app.disruptionRequests.length, 1);
  fail = false;
  t.mock.timers.tick(RAIL_DISRUPTIONS_REFRESH_MS);
  await app.poll();
  assert.equal(app.disruptionRequests.length, 2);
  assert.equal(dotsOf(app).items.size, 2);
});

test('a long Trafikverket text is cut at a word, so the card fits the screen', () => {
  const long = buildRailDisruptionCopy(
    { id: 'Hb', name: 'Helsingborg C' },
    [{ ...ELFEL, description: 'Från 16/11 kl. 19:00 '.repeat(20) }],
    T('12:00'),
    (text, values) =>
      String(text).replace(/{(w+)}/g, (m, key) =>
        values && key in values ? String(values[key]) : m,
      ),
  );
  const line = long.details[1];
  assert.ok(line.length <= 72, `${line.length} characters`);
  assert.ok(line.endsWith(' …'));
  assert.ok(!line.slice(0, -2).endsWith(' '));
  // Every line of a real card stays within one row's width.
  assert.ok(long.details.every((text) => text.length <= 72));
});

test('the card says what Trafikverket publishes, on Swedish clocks', () => {
  const now = T('12:00');
  const tr = (text, values) =>
    `T(${String(text).replace(/\{(\w+)\}/g, (m, key) =>
      values && key in values ? String(values[key]) : m,
    )})`;
  const copy = buildRailDisruptionCopy(
    { id: 'Cst', name: 'Stockholm C' },
    [ELFEL, SPARFEL],
    now,
    tr,
  );
  assert.equal(copy.title, '⚠ T(Rail disruption · Stockholm C)');
  assert.deepEqual(copy.details, [
    'Elfel: Stockholm C-Uppsala C',
    'Inga tåg kan köra mellan Stockholm C och Uppsala C.',
    'T(Stretch: Stockholm C – Uppsala C)',
    'T(Expected to last until 14:00)',
    '—',
    'Spårfel',
    'T(Stretch: Stockholm C – Södertälje C)',
    'T(Next forecast expected 12:30)',
    'T(Source: Trafikverket)',
  ]);
  // Without an end, the card says since when.
  const open = buildRailDisruptionCopy(
    { id: 'Cst', name: 'Stockholm C' },
    [{ ...SPARFEL, end: null }],
    now,
    tr,
  );
  assert.ok(open.details.includes('T(Since 10:00)'));
  // Two disruptions at most; the rest are counted.
  const many = buildRailDisruptionCopy(
    { id: 'Cst', name: 'Stockholm C' },
    [ELFEL, SPARFEL, { ...SPARFEL, id: 'c' }, { ...SPARFEL, id: 'd' }],
    now,
    tr,
  );
  assert.ok(many.details.includes('T(More disruptions here: 2)'));
  // Another day carries its date.
  assert.equal(
    disruptionClock(T('09:12') + 24 * 3_600_000, now),
    '18/11 09:12',
  );
});

// The heritage remains layer: read for low views only, dots coloured by
// assessment, a card on a click and RAÄ's page from the card.
import assert from 'node:assert/strict';
import test from 'node:test';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';
import { fromDegrees } from '../../geo/ellipsoid.js';
import * as picking from '../../data/pickRegistry.js';
import {
  ASSESSMENT,
  HERITAGE_REMAINS_OVERLAY_SOURCE_ID,
  createHeritageRemainsLayer,
} from './index.js';

const remain = (n, lon, lat, assessment, distance) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  point: [lon, lat],
  type: 'Gravfält',
  number: `L1:${n}`,
  raa: null,
  name: null,
  municipality: 'Västerås',
  assessment,
  confirmed: true,
  page: `10000000-0000-4000-8000-00000000000${n}`,
  distance,
});
const ROWS = [
  remain(1, 16.545, 59.611, 'fl', 90),
  remain(2, 16.55, 59.615, 'okl', 600),
  remain(3, 16.56, 59.62, 'fl', 1500),
];

function harness({
  height = 3000,
  answer = {},
  centre = [16.5448, 59.6105],
  terrain = null,
  sourceExtra = {},
} = {}) {
  const reads = [];
  const opened = [];
  const state = { cards: [], cardHit: null, click: null, picked: null };
  const viewer = { canvas: { clientWidth: 800, clientHeight: 600 } };
  const camera = fakeCameraPort({
    pose: { lon: 16.54, lat: 59.6, height },
    viewRectangle: { west: 16.5, south: 59.59, east: 16.6, north: 59.63 },
  });
  const picks = [];
  const { draw } = bindFakeDraw(viewer, {
    camera: camera.port,
    query: {
      pickEllipsoid(x, y) {
        picks.push([x, y]);
        return centre ? fromDegrees(centre[0], centre[1]) : null;
      },
    },
  });
  const layer = createHeritageRemainsLayer({
    source: {
      getSnapshot: async (query) => {
        reads.push(query);
        return {
          remains: ROWS,
          total: ROWS.length,
          tooWide: false,
          capped: false,
          stale: false,
          fetchedAt: Date.parse('2026-11-12T20:00:00Z'),
          ...answer,
        };
      },
      ...sourceExtra,
    },
    overlayHost: {
      setEntries(sourceId, entries) {
        assert.equal(sourceId, HERITAGE_REMAINS_OVERLAY_SOURCE_ID);
        state.cards = entries;
      },
      clearSource: () => (state.cards = []),
      setVisible() {},
      hitTest: () => state.cardHit,
    },
    // The globe's clicks: what is under them comes as `topHit`.
    input: () => ({
      onClick(callback) {
        state.click = () =>
          callback({
            screenPosition: { x: 1, y: 1 },
            topHit: state.picked
              ? { set: 'heritage-remains', id: state.picked, surface: false }
              : null,
          });
        return () => (state.click = null);
      },
    }),
    picking,
    terrain,
    openExternal: (url) => opened.push(url),
  });
  layer.init(viewer);
  const set = () => draw.find('heritage-remains');
  const drawn = () => [...(set()?.items.values() ?? [])];
  return { layer, camera, state, reads, opened, drawn, set, picks, draw };
}

const labels = (layer) =>
  layer.getRowControls().legend.map(({ label, count }) => `${label} ${count}`);

test('the remains are one set of dots, shown only while the layer is on', async () => {
  const { layer, set, state } = harness();
  assert.equal(set().kind, 'points');
  assert.equal(set().show, false);
  assert.equal(set().spec.horizonCull, true);
  layer.enable();
  assert.equal(set().show, true);
  await layer.update();
  layer.disable();
  assert.equal(set().show, false);
  assert.equal(state.click, null, 'the click handler goes with it');
  layer.destroy();
  assert.equal(set(), undefined, 'the set is disposed');
});

test('without ground heights the dots clamp to every surface; with them to terrain only', () => {
  assert.equal(harness().set().spec.clampTo, 'both');
  const terrain = { resolveEllipsoidalGround: async () => [] };
  assert.equal(harness({ terrain }).set().spec.clampTo, 'terrain');
});

test('a low view reads its box and draws a dot per remain', async () => {
  const { layer, reads, drawn, picks } = harness();
  layer.enable();
  await layer.update();
  assert.equal(reads.length, 1);
  const [w, s, e, n] = reads[0].bbox;
  assert.ok(e - w <= 0.15 + 1e-9 && n - s <= 0.15 + 1e-9);
  assert.deepEqual(
    reads[0].center.map((v) => Math.round(v * 1e4) / 1e4),
    [16.5448, 59.6105],
  );
  assert.deepEqual(picks.at(-1), [400, 300], 'the centre of the canvas');
  assert.equal(drawn().length, 3);
  assert.deepEqual(labels(layer), [
    'Ancient monument (protected) 2',
    'Other cultural-historical remain 1',
  ]);
  assert.equal(layer.getRowControls().info, '3 remains in view');
  assert.equal(layer.getStats().count, 3);
  layer.disable();
  assert.equal(drawn().length, 0);
});

test('a dot is coloured and sized by assessment, the nearest drawn last', async () => {
  const { layer, drawn } = harness();
  layer.enable();
  await layer.update();
  const items = drawn();
  assert.deepEqual(
    items.map((item) => item.id),
    [...ROWS].reverse().map((row) => `se-remain:${row.id}`),
  );
  const nearest = items.at(-1);
  assert.equal(nearest.color, ASSESSMENT.fl.color);
  assert.equal(nearest.pixelSize, 8);
  assert.equal(items[1].pixelSize, 6);
  assert.equal(nearest.outlineColor, '#1a120b');
  assert.equal(nearest.outlineWidth, 1.5);
  assert.equal(nearest.height, 'clampGround');
  assert.deepEqual(nearest.pos, { lon: 16.545, lat: 59.611, height: 0 });
  assert.equal(nearest.disableDepthTest, Number.POSITIVE_INFINITY);
  assert.deepEqual(nearest.scaleByDistance, {
    near: 300,
    nearValue: 1.3,
    far: 12000,
    farValue: 0.7,
  });
  layer.destroy();
});

test('a centre off the globe falls back to the point under the eye', async () => {
  const { layer, reads } = harness({ centre: null });
  layer.enable();
  await layer.update();
  assert.deepEqual(reads[0].center, [16.54, 59.6]);
  layer.destroy();
});

test('a high view reads nothing and asks to zoom in', async () => {
  const { layer, reads, drawn } = harness({ height: 50_000 });
  layer.enable();
  await layer.update();
  assert.equal(reads.length, 0);
  assert.equal(drawn().length, 0);
  assert.equal(
    layer.getRowControls().info,
    'Zoom in to see the remains and protected buildings: they show below 12 km',
  );
});

test('a camera move reads the view again once it settles', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { layer, camera, reads, drawn } = harness();
  layer.enable();
  assert.equal(camera.listenerCount('moveEnd'), 1);
  await layer.update();
  assert.equal(reads.length, 1);

  // Up out of reach: nothing is asked, and the dots go.
  camera.setPose({ height: 50_000 });
  camera.emit('moveEnd');
  t.mock.timers.tick(399);
  assert.equal(drawn().length, 3, 'not before the move settles');
  t.mock.timers.tick(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads.length, 1);
  assert.equal(drawn().length, 0);

  // Down again: the view is read once more.
  camera.setPose({ height: 3000 });
  camera.emit('moveEnd');
  t.mock.timers.tick(400);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads.length, 2);
  assert.equal(drawn().length, 3);

  layer.disable();
  assert.equal(camera.listenerCount('moveEnd'), 0);
  layer.destroy();
});

test('a capped box asks to zoom in for the rest', async () => {
  const { layer } = harness({ answer: { capped: true } });
  layer.enable();
  await layer.update();
  assert.equal(
    layer.getRowControls().info,
    'Zoom in to see every remain here.',
  );
});

test('a click on a dot shows its card; a click on the card opens RAÄ', async () => {
  const { layer, state, opened } = harness();
  layer.enable();
  await layer.update();
  state.picked = `se-remain:${ROWS[1].id}`;
  state.click();
  assert.equal(state.cards.length, 1);
  assert.equal(state.cards[0].title, 'REMAIN · Gravfält');
  assert.ok(state.cards[0].position, 'the card sits on the remain');
  state.cardHit = {
    sourceId: HERITAGE_REMAINS_OVERLAY_SOURCE_ID,
    entryId: state.cards[0].id,
  };
  state.click();
  assert.deepEqual(opened, [
    `https://pub.raa.se/visa/objekt/lamning/${ROWS[1].page}`,
  ]);
  assert.equal(
    state.cards.length,
    1,
    'a click on the card is not one on the map',
  );
  assert.equal(state.cards[0].activate(), true);
  assert.equal(opened.length, 2);
  state.cardHit = null;
  state.picked = null;
  state.click();
  assert.deepEqual(state.cards, []);
  assert.equal(layer.remainAt([16.5451, 59.6112])?.number, 'L1:1');
});

test("a click on another layer's card or dot leaves the open card alone", async () => {
  const { layer, state } = harness();
  layer.enable();
  await layer.update();
  state.picked = `se-remain:${ROWS[0].id}`;
  state.click();
  const open = state.cards[0].id;
  state.cardHit = { sourceId: 'hospitals', entryId: 'hospitals-card:x' };
  state.picked = null;
  state.click();
  assert.equal(state.cards[0]?.id, open, 'a card is not the ground');
  state.cardHit = null;
  picking.registerPickOwner('hospitals', (id) => id.startsWith('se-hospital:'));
  try {
    state.picked = 'se-hospital:1';
    state.click();
    assert.equal(
      state.cards[0]?.id,
      open,
      "another layer's dot is not the ground",
    );
  } finally {
    picking.unregisterPickOwner('hospitals');
  }
  layer.destroy();
});

test('the analyst reads the shown remains, named as on the card, and nothing while off', async () => {
  const { layer } = harness({
    answer: {
      remains: [
        { ...ROWS[0], name: 'Anundshög' },
        ROWS[1],
        { ...ROWS[2], type: null },
      ],
    },
  });
  layer.enable();
  await layer.update();
  const records = layer.getAnalystRecords();
  assert.deepEqual(
    records.map((r) => [r.name, r.lat, r.lon]),
    [
      ['Anundshög', 59.611, 16.545],
      ['Gravfält', 59.615, 16.55],
      ['Remain', 59.62, 16.56],
    ],
  );
  assert.equal(records[0].number, 'L1:1');
  assert.equal(records[0].municipality, 'Västerås');
  assert.equal(records[0].confirmed, true);
  assert.equal(records[0].assessment, 'Ancient monument (protected)');
  assert.equal(layer.getAnalystRecords(1).length, 1);
  layer.disable();
  assert.deepEqual(layer.getAnalystRecords(), []);
  layer.destroy();
});

// World Heritage sites and protected buildings: kinds of their own, each
// with a chip, read only while shown.
const SITE = {
  id: 'se-1',
  point: [16.55, 59.6],
  rings: [
    [
      [16.5, 59.55],
      [16.6, 59.55],
      [16.6, 59.65],
    ],
  ],
  nameSv: 'Engelsbergs bruk',
  nameEn: 'Engelsberg Ironworks',
  inscribed: 1993,
  unesco: 'https://whc.unesco.org/en/list/556',
  schematic: false,
};
const BUILDING = {
  id: 'b0000000-0000-4000-8000-000000000001',
  point: [16.546, 59.612],
  name: 'Västerås domkyrka',
  protection: 'kk',
  decided: 1999,
  built: { from: 1271, to: 1517 },
  purpose: 'Kyrka',
  municipality: 'Västerås',
  page: 'https://pub.raa.se/visa/objekt/bebyggelse/b0000000-0000-4000-8000-000000000001',
  distance: 120,
};
const AREA = {
  id: 'a1',
  point: [16.54, 59.61],
  rings: [
    [
      [16.539, 59.609],
      [16.541, 59.609],
      [16.541, 59.611],
    ],
  ],
  name: 'Slottet',
  protection: 'sbm',
  decided: 1935,
  built: null,
  purpose: null,
  municipality: 'Västerås',
  page: null,
};

function kindsHarness(options = {}) {
  const calls = { world: 0, buildings: [] };
  const h = harness({
    ...options,
    sourceExtra: {
      getWorldHeritage: async () => {
        calls.world += 1;
        return { sites: [SITE], stale: false, fetchedAt: 1 };
      },
      getBuildings: async (query) => {
        calls.buildings.push(query);
        return {
          buildings: [BUILDING],
          areas: [AREA],
          total: 1,
          tooWide: false,
          capped: false,
          stale: false,
          fetchedAt: 1,
        };
      },
    },
  });
  return { ...h, calls };
}

test('each kind has a chip, all on at first', () => {
  const { layer } = kindsHarness();
  const chips = layer.getRowControls().chips;
  assert.deepEqual(
    chips.map(({ id, label, active }) => [id, label, active]),
    [
      ['kind-remains', 'Remains', true],
      ['kind-world', 'World Heritage', true],
      ['kind-buildings', 'Protected buildings', true],
    ],
  );
  layer.destroy();
});

test('a low view reads remains and buildings once each, and the sites once', async () => {
  const { layer, calls, reads, drawn, draw } = kindsHarness();
  layer.enable();
  await layer.update();
  await layer.update();
  assert.equal(reads.length, 2);
  assert.equal(calls.buildings.length, 2);
  assert.deepEqual(calls.buildings[0].bbox, reads[0].bbox, 'the same view');
  assert.equal(calls.world, 1, 'the World Heritage list is read once');
  const ids = drawn().map((item) => item.id);
  assert.ok(ids.includes(`se-heritage-building:${BUILDING.id}`));
  assert.equal(ids.at(-1), 'se-world-heritage:se-1', 'the sites draw on top');
  assert.deepEqual(
    [...draw.set('heritage-remains:protection-areas').items.keys()],
    ['se-protection-area:a1:0'],
  );
  const outline = draw
    .set('heritage-remains:world-heritage')
    .items.get('se-world-heritage:se-1:0');
  assert.equal(outline.positions.length, 4, 'the ring is closed');
  assert.equal(outline.mode, 'draped');
  const labels = layer.getRowControls().legend.map((item) => item.label);
  assert.deepEqual(labels, [
    'Ancient monument (protected)',
    'Other cultural-historical remain',
    'State listed building',
    'Protected church heritage',
    'World Heritage',
  ]);
  assert.equal(
    layer.getRowControls().info,
    '3 remains in view · 1 protected building in view',
  );
  assert.equal(layer.getStats().count, 3 + 1 + 1);
  layer.destroy();
});

test('a high view reads no buildings but still shows the World Heritage sites', async () => {
  const { layer, calls, reads, drawn } = kindsHarness({ height: 900_000 });
  layer.enable();
  await layer.update();
  assert.equal(reads.length, 0);
  assert.equal(calls.buildings.length, 0);
  assert.equal(calls.world, 1);
  assert.deepEqual(
    drawn().map((item) => item.id),
    ['se-world-heritage:se-1'],
  );
  assert.deepEqual(
    layer.getRowControls().legend.map((item) => item.label),
    ['World Heritage'],
  );
  layer.destroy();
});

test('a kind turned off is neither read nor drawn; on again, it is read at once', async () => {
  const { layer, calls, reads, drawn, draw } = kindsHarness();
  layer.enable();
  await layer.update();
  const chip = (id) =>
    layer.getRowControls().chips.find((entry) => entry.id === id);
  chip('kind-buildings').onClick();
  chip('kind-remains').onClick();
  assert.equal(chip('kind-buildings').active, false);
  assert.deepEqual(
    drawn().map((item) => item.id),
    ['se-world-heritage:se-1'],
  );
  assert.equal(draw.set('heritage-remains:protection-areas').items.size, 0);
  await layer.update();
  assert.equal(calls.buildings.length, 1, 'no buildings read while off');
  assert.equal(reads.length, 1, 'no remains read while off');
  chip('kind-world').onClick();
  assert.deepEqual(drawn(), []);
  assert.equal(draw.set('heritage-remains:world-heritage').items.size, 0);
  chip('kind-buildings').onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.buildings.length, 2);
  assert.equal(reads.length, 1);
  assert.equal(calls.world, 1);
  layer.destroy();
});

test('a building card shows the protection only, and opens Bebyggelseregistret', async () => {
  const { layer, state, opened } = kindsHarness();
  layer.enable();
  await layer.update();
  state.picked = `se-heritage-building:${BUILDING.id}`;
  state.click();
  const card = state.cards[0];
  assert.equal(card.title, 'PROTECTED BUILDING · Västerås domkyrka');
  assert.deepEqual(card.details, [
    'Protected church heritage',
    'Protected since 1999',
    'Built 1271–1517',
    'Kyrka',
    'Västerås',
    '120 m from the map centre',
    'RAÄ ↗ · click card to open',
    'Source: Riksantikvarieämbetet',
  ]);
  assert.equal(card.activate(), true);
  assert.deepEqual(opened, [BUILDING.page]);
  // A protection area's outline picks its area; it has no page to open.
  state.picked = 'se-protection-area:a1:0';
  state.click();
  assert.equal(state.cards[0].title, 'PROTECTION AREA · Slottet');
  assert.equal(state.cards[0].activate, undefined);
  layer.destroy();
});

test('a World Heritage card names the site and opens UNESCO', async () => {
  const { layer, state, opened } = kindsHarness({ height: 900_000 });
  layer.enable();
  await layer.update();
  state.picked = 'se-world-heritage:se-1:0';
  state.click();
  const card = state.cards[0];
  assert.equal(card.title, 'WORLD HERITAGE · Engelsberg Ironworks');
  assert.deepEqual(card.details, [
    'Engelsbergs bruk',
    'Inscribed 1993',
    'UNESCO ↗ · click card to open',
    'Source: Riksantikvarieämbetet',
  ]);
  card.activate();
  assert.deepEqual(opened, ['https://whc.unesco.org/en/list/556']);
  assert.deepEqual(
    layer.getAnalystRecords().map((r) => [r.name, r.inscribed]),
    [['Engelsberg Ironworks', '1993']],
  );
  layer.destroy();
});

test('a failed World Heritage read is not asked again at once', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let asked = 0;
  const { layer } = harness({
    height: 900_000,
    sourceExtra: {
      getWorldHeritage: async () => {
        asked += 1;
        throw new Error('World Heritage unavailable (HTTP 502)');
      },
    },
  });
  layer.enable();
  await layer.update();
  await layer.update();
  assert.equal(asked, 1);
  assert.equal(layer.getStats().error, 'World Heritage unavailable (HTTP 502)');
  layer.destroy();
});

test('a chip turned on reads its own kind only', async () => {
  const { layer, calls, reads } = kindsHarness();
  layer.enable();
  await layer.update();
  const chip = (id) =>
    layer.getRowControls().chips.find((entry) => entry.id === id);
  chip('kind-buildings').onClick();
  chip('kind-buildings').onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.buildings.length, 2);
  assert.equal(reads.length, 1, 'the remains are not read again');
  chip('kind-world').onClick();
  chip('kind-world').onClick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.world, 1, 'the list read before is kept');
  layer.destroy();
});

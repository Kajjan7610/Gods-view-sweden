import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LINKS,
  flowWidth,
  normalizeFlows,
  normalizeProduction,
} from './records.js';
import { buildAreaCard } from './cards.js';
import { createPowerGridLayer } from './index.js';

// Shaped like svk.se/services/controlroom/v2/map/flow.
const FLOW = {
  Data: [
    {
      id: '1',
      data: [
        { id: 'SE2_SE3', value: 5698.9531 },
        { id: 'SE3_SE4', value: 1033.7026 },
        { id: 'DE_SE4', value: 188.4222 },
        { id: 'FI_SE3', value: -387.17 },
        { id: 'NO1_NO2', value: 2219.74 },
        { id: 'SE4_PL', value: 'n/a' },
      ],
    },
    {
      id: '2',
      data: [
        {
          id: 'SE',
          value: 2404,
          ElectricalAreas: [
            { AreaName: 'SE3', Import: 5698.9531, Export: 3544.7132 },
            { AreaName: 'SE4', Import: 1394.871, Export: 178.31 },
          ],
        },
        {
          id: 'NO',
          value: 1802,
          ElectricalAreas: [{ AreaName: 'NO1', Import: 4176, Export: 2219 }],
        },
      ],
    },
  ],
  LastUpdated: 1793828700000,
};

test('every link touches Sweden and lands its foreign end somewhere', () => {
  for (const link of LINKS) {
    assert.ok(/SE\d/.test(link.id), link.id);
    assert.equal(link.aPoint.length, 2);
    assert.equal(link.bPoint.length, 2);
  }
  assert.equal(new Set(LINKS.map((link) => link.id)).size, LINKS.length);
});

test('flows run from sender to receiver and say how they meet Sweden', () => {
  const { links, areas, updated } = normalizeFlows(FLOW);
  assert.equal(updated, 1793828700000);
  assert.deepEqual(
    links.map((link) => [link.id, link.from, link.to, link.mw, link.kind]),
    [
      ['DE_SE4', 'DE', 'SE4', 188, 'import'],
      ['FI_SE3', 'SE3', 'FI', 387, 'export'],
      ['SE2_SE3', 'SE2', 'SE3', 5699, 'internal'],
      ['SE3_SE4', 'SE3', 'SE4', 1034, 'internal'],
    ],
  );
  const fi = links.find((link) => link.id === 'FI_SE3');
  assert.deepEqual(fi.toPoint, [21.51, 61.13], 'drawn towards Rauma');
  assert.equal(fi.place, 'Rauma');
  assert.deepEqual(areas, [
    { id: 'SE3', import: 5699, export: 3545 },
    { id: 'SE4', import: 1395, export: 178 },
  ]);
  assert.deepEqual(normalizeFlows(null), {
    links: [],
    areas: [],
    updated: null,
  });
});

test('production keeps the latest quarter-hour of each type', () => {
  const series = (id, ...ys) => ({
    id,
    data: ys.map((y, i) => ({ x: 1000 + i * 900, y })),
  });
  assert.deepEqual(
    normalizeProduction({
      Data: [
        series('1', 17000, 17468.4),
        series('2', 3646, 3646),
        series('5', 9000, 9637, null),
        series('7', 17888),
        series('99', 5),
      ],
    }),
    {
      at: 1900,
      total: 17468,
      nuclear: 3646,
      wind: 9637,
      consumption: 17888,
    },
  );
});

test('lines widen with the flow, within bounds', () => {
  assert.equal(flowWidth(0), 3);
  assert.ok(flowWidth(1000) > flowWidth(100));
  assert.equal(flowWidth(100_000), 14);
});

test('a zone card lists its flows and Sweden’s production', () => {
  const card = buildAreaCard(
    { id: 'SE4', name: 'Malmö' },
    {
      ...normalizeFlows(FLOW),
      production: {
        total: 17468,
        consumption: 17888,
        nuclear: 3646,
        hydro: 2956,
        wind: 9637,
        thermal: 1229,
        unspecified: 0,
      },
    },
  );
  assert.equal(card.title, 'POWER GRID · SE4 MALMÖ');
  assert.equal(card.details[0], 'Import 1,395 MW · export 178 MW');
  assert.equal(card.details[1], 'from SE3 1,034 · from DE 188 MW');
  assert.equal(
    card.details[2],
    'Sweden: production 17,468 MW, consumption 17,888 MW',
  );
  assert.equal(
    card.details[3],
    'nuclear 3,646 · hydro 2,956 · wind 9,637 · thermal 1,229 MW',
  );
  assert.match(card.details[4], /^Svenska kraftnät · \d\d:\d\d$/);
});

test('the layer draws its links and reports them by kind', async () => {
  const layer = createPowerGridLayer({
    source: {
      getSnapshot: async () => ({
        ...normalizeFlows(FLOW),
        production: {},
        stale: false,
        fetchedAt: null,
      }),
    },
  });
  const added = [];
  const viewer = {
    dataSources: {
      add(source) {
        source.entities.add = (entity) => added.push(entity);
        source.entities.removeAll = () => (added.length = 0);
      },
      remove() {},
    },
  };
  layer.init(viewer);
  layer.enable();
  assert.equal(await layer.update(), true);
  assert.equal(
    added.filter((entity) => entity.polyline).length,
    4,
    'one arrow per link',
  );
  assert.deepEqual(
    layer.getRowControls().legend.map((item) => item.count),
    [2, 1, 1],
  );
  assert.equal(layer.getStats().count, 4);
  layer.destroy(viewer);
});

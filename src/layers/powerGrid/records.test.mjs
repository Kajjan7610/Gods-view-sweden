import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LINKS,
  countryOf,
  exchangeByCountry,
  exchangeTotals,
  flowWidth,
  latestProduction,
  linkTouches,
  normalizeFlows,
  normalizeProduction,
  normalizeProductionDay,
} from './records.js';
import { buildDayChart, dayStartOf, pointAt } from './dayChart.js';
import { buildAreaCard, netText, zoneName } from './cards.js';
import { flowRepeat, flowSpeed } from './flowMaterial.js';
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

test('a link without a value is no flow, and a link named twice counts once', () => {
  const flows = (...groups) =>
    normalizeFlows({ Data: groups.map((data, i) => ({ id: String(i), data })) })
      .links;
  // Number(null) and Number('') are 0: neither is a link standing still.
  assert.deepEqual(
    flows([
      { id: 'SE1_SE2', value: null },
      { id: 'SE2_SE3' },
      { id: 'SE3_SE4', value: '' },
      { id: 'FI_SE1', value: '  ' },
      { id: 'FI_SE3', value: NaN },
      { id: 'NO4_SE1', value: Infinity },
      { id: 'NO4_SE2', value: 'n/a' },
      { id: 'NO3_SE2', value: false },
      { id: 'NO1_SE3', value: [] },
    ]),
    [],
  );
  assert.deepEqual(
    flows([
      { id: 'SE1_SE2', value: 0 },
      { id: 'SE2_SE3', value: '412.6' },
      { id: 'SE3_SE4', value: -0.2 },
    ]).map((link) => [link.id, link.from, link.to, link.mw]),
    [
      ['SE1_SE2', 'SE1', 'SE2', 0],
      ['SE2_SE3', 'SE2', 'SE3', 413],
      ['SE3_SE4', 'SE4', 'SE3', 0],
    ],
    'a real 0 MW stays',
  );
  assert.deepEqual(
    flows(
      [
        { id: 'SE2_SE3', value: 5000 },
        { id: 'SE3_SE4', value: null },
      ],
      [
        { id: 'SE2_SE3', value: -70 },
        { id: 'SE3_SE4', value: 900 },
      ],
    ).map((link) => [link.id, link.from, link.mw]),
    [
      ['SE2_SE3', 'SE2', 5000],
      ['SE3_SE4', 'SE3', 900],
    ],
    'the first value wins; a missing one does not claim the link',
  );
});

test('production is every type at the newest quarter-hour with a total', () => {
  const series = (id, ...ys) => ({
    id,
    data: ys.map((y, i) => ({ x: 1000 + i * 900, y })),
  });
  // Wind and consumption run a quarter ahead of the total; hydro lags.
  assert.deepEqual(
    normalizeProduction({
      Data: [
        series('1', 17000, 17468.4, null),
        series('2', 3646, 3650),
        series('3', 2956),
        series('5', 9000, 9637, 9800),
        series('7', 17888, 17900, 18000),
        series('99', 5, 5, 5),
      ],
    }),
    {
      at: 1900,
      total: 17468,
      nuclear: 3650,
      wind: 9637,
      consumption: 17900,
    },
    'no hydro from the older quarter, nothing from the newer one',
  );
  assert.deepEqual(
    normalizeProduction({ Data: [series('7', 17888), series('5', 9000)] }),
    { at: null },
    'no total, no values',
  );
  assert.deepEqual(normalizeProduction(null), { at: null });
  assert.deepEqual(normalizeProduction({ Data: [] }), { at: null });
});

test('the latest values of a kept day are its last quarter-hour with a total', () => {
  const points = [
    { at: 1000, total: 15000, nuclear: 3000 },
    { at: 1900, total: 15100, wind: 9000 },
    { at: 2800, consumption: 16000 },
  ];
  const latest = latestProduction(points);
  assert.deepEqual(latest, { at: 1900, total: 15100, wind: 9000 });
  assert.notEqual(latest, points[1], 'a copy, not the point itself');
  assert.deepEqual(latestProduction([]), { at: null });
  assert.deepEqual(latestProduction([null, { total: 5 }, { at: 1 }]), {
    at: null,
  });
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

test('the layer draws its links and sums the exchange per country', async () => {
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
  const controls = layer.getRowControls();
  assert.deepEqual(
    controls.legend.map((item) => item.label),
    [
      'Finland: export 387 MW',
      'Germany: import 188 MW',
      'Between Swedish zones',
    ],
  );
  assert.deepEqual(
    controls.chips.map((chip) => chip.id),
    ['country-FI', 'country-DE'],
  );
  assert.equal(layer.getStats().count, 4);

  // Exports alone: the one link out of Sweden.
  controls.segmented.options.find((o) => o.id === 'show-export').onClick();
  assert.equal(added.filter((entity) => entity.polyline).length, 1);
  assert.equal(
    layer.getRowControls().segmented.options.find((o) => o.active).id,
    'show-export',
  );

  // All again, Germany highlighted: every link stays, the rest go faint.
  layer
    .getRowControls()
    .segmented.options.find((o) => o.id === 'show-all')
    .onClick();
  layer
    .getRowControls()
    .chips.find((chip) => chip.id === 'country-DE')
    .onClick();
  const lines = added.filter((entity) => entity.polyline);
  assert.equal(lines.length, 4);
  const alpha = (id) =>
    lines.find((entity) => entity.id.startsWith(`power-grid-line:${id}:`))
      .polyline.material.color.alpha;
  assert.ok(alpha('DE_SE4') > 0.5);
  assert.ok(alpha('FI_SE3') < 0.5);
  assert.equal(
    layer.getRowControls().chips.find((chip) => chip.active).id,
    'country-DE',
  );
  layer.destroy(viewer);
});

test('the exchange sums in, out and net per neighbouring country', () => {
  const links = [
    { from: 'DE', to: 'SE4', kind: 'import', mw: 339 },
    { from: 'SE3', to: 'DK1', kind: 'export', mw: 180 },
    { from: 'SE1', to: 'FI', kind: 'export', mw: 1083 },
    { from: 'SE3', to: 'FI', kind: 'export', mw: 201 },
    { from: 'SE3', to: 'NO1', kind: 'export', mw: 300 },
    { from: 'NO3', to: 'SE2', kind: 'import', mw: 193 },
    { from: 'NO4', to: 'SE1', kind: 'import', mw: 41 },
    { from: 'SE2', to: 'NO4', kind: 'export', mw: 32 },
    { from: 'DK2', to: 'SE4', kind: 'import', mw: 138 },
    { from: 'SE2', to: 'SE3', kind: 'internal', mw: 6367 },
  ];
  assert.deepEqual(exchangeTotals(links), {
    import: 711,
    export: 1796,
    net: 1085,
  });
  assert.deepEqual(exchangeByCountry(links), [
    { country: 'FI', import: 0, export: 1284, net: 1284 },
    { country: 'DE', import: 339, export: 0, net: -339 },
    { country: 'NO', import: 234, export: 332, net: 98 },
    { country: 'DK', import: 138, export: 180, net: 42 },
  ]);
  assert.equal(countryOf('NO3'), 'NO');
  assert.equal(linkTouches(links[0], 'DE'), true);
  assert.equal(linkTouches(links[9], 'DE'), false);
});

test('zones and nets read as a reader knows them', () => {
  assert.equal(zoneName('SE4'), 'SE4');
  assert.equal(zoneName('FI'), 'Finland');
  assert.equal(zoneName('NO3'), 'Norway NO3');
  assert.equal(netText(1284), 'export 1,284 MW');
  assert.equal(netText(-475), 'import 475 MW');
  assert.equal(netText(0), 'balanced');
});

test('faster chevrons for larger flows, more of them on longer links', () => {
  assert.ok(flowSpeed(6000) > flowSpeed(100));
  assert.equal(flowSpeed(1e6), 2.5);
  assert.equal(flowRepeat(100), 3);
  assert.equal(flowRepeat(1200), 10);
});

test('the day reads as quarter-hours and as a chart', () => {
  const at = Date.parse('2026-11-08T23:00:00Z'); // 00:00 in Stockholm
  const points = normalizeProductionDay({
    Data: [
      {
        id: '2',
        data: [
          { x: at, y: 3600 },
          { x: at + 900_000, y: 3650 },
        ],
      },
      {
        id: '3',
        data: [
          { x: at, y: 5000 },
          { x: at + 900_000, y: 5100 },
        ],
      },
      {
        id: '1',
        data: [
          { x: at, y: 8600 },
          { x: at + 900_000, y: 8750 },
        ],
      },
      {
        id: '7',
        data: [
          { x: at, y: 8000 },
          { x: at + 900_000, y: 9000 },
        ],
      },
      {
        id: '8',
        data: [
          { x: at, y: 600 },
          { x: at + 900_000, y: -250 },
        ],
      },
    ],
  });
  assert.deepEqual(points[1], {
    at: at + 900_000,
    nuclear: 3650,
    hydro: 5100,
    total: 8750,
    consumption: 9000,
    net: -250,
  });
  const chart = buildDayChart(points);
  assert.equal(dayStartOf(points), at);
  assert.deepEqual(
    chart.areas.map((area) => area.id),
    ['nuclear', 'hydro'],
  );
  assert.ok(chart.consumption.startsWith('M34,'));
  assert.ok(chart.net.exported.length > 0 && chart.net.imported.length > 0);
  assert.deepEqual(chart.totals, {
    production: 4338,
    consumption: 4250,
    exported: 150,
    imported: 63,
  });
  assert.equal(pointAt(chart, 1000).at, at + 900_000);
  assert.equal(buildDayChart([]), null);
});

test('a week chart spans seven midnights and leaves gaps open', () => {
  const start = Date.parse('2026-11-02T23:00:00Z'); // Tue 3 Nov, 00:00 Stockholm
  const quarter = 900_000;
  const day = 86_400_000;
  const point = (at) => ({
    at,
    nuclear: 3600,
    total: 3600,
    consumption: 4000,
    net: -400,
  });
  // Two quarter-hours on the first day, two on the last; nothing between.
  const points = [
    point(start),
    point(start + quarter),
    point(start + 6 * day),
    point(start + 6 * day + quarter),
  ];
  const chart = buildDayChart(points, { start, days: 7 });
  assert.equal(chart.days, 7);
  assert.equal(chart.xTicks.length, 8, 'one tick per midnight');
  assert.equal(chart.areas[0].d.split('Z').length - 1, 2, 'two runs, a gap');
  assert.equal(chart.consumption.split('M').length - 1, 2);
  assert.ok(chart.points[2].x > 250, 'the last day sits at the right');
});

test('a zone or a stamp that is missing is left out, never read as 0', () => {
  const answer = (areas, LastUpdated) =>
    normalizeFlows({
      Data: [
        {
          id: '2',
          data: [{ id: 'SE', value: 2404, ElectricalAreas: areas }],
        },
      ],
      LastUpdated,
    });
  const { areas, updated } = answer(
    [
      { AreaName: 'SE1', Import: 150, Export: 3110 },
      { AreaName: 'SE2', Import: null, Export: 2000 },
      { AreaName: 'SE3', Import: 5699, Export: '' },
      { AreaName: 'SE4', Import: 0, Export: 178.31 },
    ],
    1794372300000,
  );
  assert.deepEqual(areas, [
    { id: 'SE1', import: 150, export: 3110 },
    // A real zero is still a zero.
    { id: 'SE4', import: 0, export: 178 },
  ]);
  assert.equal(updated, 1794372300000);
  // No stamp is no time, not one o'clock on 1 January 1970.
  for (const missing of [null, undefined, '', 0])
    assert.equal(answer([], missing).updated, null);
});

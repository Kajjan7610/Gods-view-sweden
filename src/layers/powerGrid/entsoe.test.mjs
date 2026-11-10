// Reading ENTSO-E's answers into the shapes the control-room proxy gives.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ENTSOE_AREAS,
  ENTSOE_LINKS,
  entsoeTime,
  flowsFromEntsoe,
  isNoDataAnswer,
  parseEntsoeSeries,
  productionFromEntsoe,
} from './entsoe.js';
import { LINKS } from './records.js';
import {
  entsoeAcknowledgement,
  entsoeDocument,
  entsoeSeries,
} from './entsoeFixture.mjs';

const T0 = Date.parse('2026-11-10T10:00:00Z');
const Q = 15 * 60_000;

test('every link end has an Energy Identification Code', () => {
  assert.equal(ENTSOE_LINKS.length, LINKS.length);
  for (const link of ENTSOE_LINKS) {
    assert.match(link.aCode, /^[0-9]{2}[A-Z0-9-]{14}$/, link.a);
    assert.match(link.bCode, /^[0-9]{2}[A-Z0-9-]{14}$/, link.b);
  }
  assert.equal(ENTSOE_AREAS.SE3, '10Y1001A1001A46L');
  assert.equal(
    ENTSOE_AREAS.DE,
    '10Y1001A1001A82H',
    'Baltic Cable lands in DE-LU',
  );
  assert.equal(entsoeTime(T0 + 5 * Q), '202611101115');
});

test('series become quarter-hours whatever their resolution or curve type', () => {
  const [quarters, hours, blocks] = parseEntsoeSeries(
    entsoeDocument([
      entsoeSeries({
        start: '2026-11-10T10:00Z',
        end: '2026-11-10T11:00Z',
        points: [
          [1, 100],
          [2, 110],
          [4, 130],
        ],
      }),
      entsoeSeries({
        start: '2026-11-10T10:00Z',
        end: '2026-11-10T12:00Z',
        resolution: 'PT60M',
        psrType: 'B14',
        inArea: ENTSOE_AREAS.SE3,
        points: [
          [1, 6000],
          [2, 6100],
        ],
      }),
      // Variable-sized blocks: a value holds until the next position.
      entsoeSeries({
        start: '2026-11-10T10:00Z',
        end: '2026-11-10T11:00Z',
        curve: 'A03',
        points: [
          [1, 5],
          [3, 7],
        ],
      }),
    ]),
  );
  assert.deepEqual(
    [...quarters.points],
    [
      [T0, 100],
      [T0 + Q, 110],
      [T0 + 3 * Q, 130],
    ],
    'an A01 gap stays a gap',
  );
  assert.equal(hours.points.size, 8);
  assert.equal(hours.points.get(T0 + 3 * Q), 6000);
  assert.equal(hours.points.get(T0 + 4 * Q), 6100);
  assert.equal(hours.psrType, 'B14');
  assert.equal(hours.inArea, ENTSOE_AREAS.SE3);
  assert.deepEqual([...blocks.points.values()], [5, 5, 7, 7]);
});

test('"no matching data" is an empty answer; another refusal throws', () => {
  assert.equal(isNoDataAnswer(entsoeAcknowledgement()), true);
  assert.deepEqual(parseEntsoeSeries(entsoeAcknowledgement()), []);
  assert.equal(isNoDataAnswer(entsoeDocument([])), false);
  assert.throws(
    () => parseEntsoeSeries(entsoeAcknowledgement('999b', 'Invalid query')),
    /ENTSO-E refused the query: Invalid query/,
  );
});

const flowSeries = (points) => [
  {
    points: new Map(points),
  },
];

test('flows net the two directions at the newest quarter both publish', () => {
  const byLink = new Map([
    // SE3 → SE4 1200 MW, 10 MW back: 1190 MW south, internal.
    [
      'SE3_SE4',
      {
        aToB: flowSeries([
          [T0, 1000],
          [T0 + Q, 1200],
        ]),
        bToA: flowSeries([
          [T0, 0],
          [T0 + Q, 10],
        ]),
      },
    ],
    // Germany → SE4, the newest quarter only on one side: the older is read.
    [
      'DE_SE4',
      {
        aToB: flowSeries([
          [T0, 400],
          [T0 + Q, 500],
        ]),
        bToA: flowSeries([[T0, 0]]),
      },
    ],
    // SE1 → Finland, published one way only.
    ['FI_SE1', { aToB: [], bToA: flowSeries([[T0 + Q, 300]]) }],
    // Nothing at all: left out.
    ['NO1_SE3', { aToB: [], bToA: [] }],
  ]);
  const { links, areas, updated } = flowsFromEntsoe(byLink);
  assert.deepEqual(
    links.map(({ id, from, to, mw, kind }) => [id, from, to, mw, kind]),
    [
      ['DE_SE4', 'DE', 'SE4', 400, 'import'],
      ['FI_SE1', 'SE1', 'FI', 300, 'export'],
      ['SE3_SE4', 'SE3', 'SE4', 1190, 'internal'],
    ],
  );
  const de = links.find((link) => link.id === 'DE_SE4');
  assert.equal(de.place, 'Lübeck');
  assert.deepEqual(de.toPoint, [13.6, 56.1]);
  assert.deepEqual(areas, [
    { id: 'SE1', import: 0, export: 300 },
    { id: 'SE3', import: 0, export: 1190 },
    { id: 'SE4', import: 1590, export: 0 },
  ]);
  assert.equal(updated, T0 + Q);
});

const zoneSeries = (psrType, points, extra = {}) => ({
  psrType,
  inArea: 'zone',
  outArea: null,
  points: new Map(points),
  ...extra,
});

test('production sums the four zones per type, only where all four report', () => {
  const generation = new Map();
  const load = new Map();
  for (const zone of ['SE1', 'SE2', 'SE3', 'SE4']) {
    generation.set(zone, [
      zoneSeries('B12', [
        [T0, 1000],
        [T0 + Q, 1000],
      ]),
      zoneSeries('B19', [
        [T0, 200],
        [T0 + Q, 300],
      ]),
      zoneSeries('B16', [[T0, 10]]),
      // Pumped storage pumping is consumption, not production.
      zoneSeries('B10', [[T0, 999]], { inArea: null, outArea: 'zone' }),
    ]);
    // SE4's load is published for the first quarter only.
    load.set(
      zone,
      zoneSeries(
        null,
        zone === 'SE4'
          ? [[T0, 800]]
          : [
              [T0, 800],
              [T0 + Q, 800],
            ],
      ),
    );
  }
  generation.get('SE3').push(
    zoneSeries('B14', [
      [T0, 6000],
      [T0 + Q, 6000],
    ]),
  );
  for (const [zone, series] of load) load.set(zone, [series]);
  const points = productionFromEntsoe(generation, load);
  assert.deepEqual(points, [
    {
      at: T0,
      nuclear: 6000,
      hydro: 4000,
      wind: 800,
      unspecified: 40,
      total: 10840,
      consumption: 3200,
      net: 7640,
    },
  ]);
  assert.deepEqual(productionFromEntsoe(new Map(), new Map()), []);
});

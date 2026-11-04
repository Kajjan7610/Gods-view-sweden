import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyAlert,
  decodeServiceAlerts,
  isActive,
  placeAlerts,
  worseKind,
} from './records.js';
import { buildStopCard } from './cards.js';
import { encodeAlerts } from './alertFeedFixture.mjs';
import { createTransitAlertsLayer } from './index.js';

const NOW = 1_793_830_000;
const STOPS = new Map([
  ['area-1', [16.19, 58.59, 'Djäkneparksskolan', '']],
  ['quay-1a', [16.1901, 58.5901, 'Djäkneparksskolan', 'area-1']],
  ['quay-1b', [16.1902, 58.5902, 'Djäkneparksskolan', 'area-1']],
  ['lone', [15.6, 58.4, 'Resecentrum', '']],
]);

test('ServiceAlerts decode to text, effect, periods and stops', () => {
  const [alert] = decodeServiceAlerts(
    encodeAlerts([
      {
        id: 'a1',
        header: 'Hållplats   flyttad',
        description: 'Läge A flyttas 50 meter.',
        effect: 9,
        periods: [[NOW - 10, NOW + 10]],
        stops: ['quay-1a', 'quay-1a', 'quay-1b'],
      },
    ]),
  );
  assert.deepEqual(alert, {
    id: 'a1',
    header: 'Hållplats flyttad',
    description: 'Läge A flyttas 50 meter.',
    effect: 9,
    periods: [{ start: NOW - 10, end: NOW + 10 }],
    stopIds: ['quay-1a', 'quay-1b'],
  });
});

test('alerts are classed by effect, else by their Swedish text', () => {
  assert.equal(classifyAlert({ effect: 1 }), 'closed');
  assert.equal(classifyAlert({ effect: 9 }), 'moved');
  assert.equal(
    classifyAlert({ header: 'Hållplats Bommedal är avstängd' }),
    'closed',
  );
  assert.equal(
    classifyAlert({ header: 'Spårvagn 2 är delinställd' }),
    'closed',
  );
  assert.equal(classifyAlert({ header: 'Hållplats flyttad 65 m' }), 'moved');
  assert.equal(classifyAlert({ header: 'Ny tidtabell' }), 'other');
  assert.equal(worseKind('other', 'closed'), 'closed');
  assert.equal(worseKind('moved', 'other'), 'moved');
});

test('only alerts in effect now count', () => {
  assert.equal(isActive([], NOW), true);
  assert.equal(isActive([{ start: NOW - 1 }], NOW), true);
  assert.equal(isActive([{ start: NOW + 60, end: NOW + 120 }], NOW), false);
  assert.equal(isActive([{ end: NOW - 1 }], NOW), false);
});

test('platform alerts gather at their stop area; unknown stops drop', () => {
  const alerts = decodeServiceAlerts(
    encodeAlerts([
      { id: 'moved', header: 'Läge A flyttad', stops: ['quay-1a'] },
      {
        id: 'closed',
        header: 'Läge B avstängd',
        stops: ['quay-1b'],
        periods: [[NOW - 60, NOW + 86_400]],
      },
      {
        id: 'later',
        header: 'Avstängd',
        stops: ['lone'],
        periods: [[NOW + 60, 0]],
      },
      { id: 'nowhere', header: 'Avstängd', stops: ['missing'] },
    ]),
  );
  const rows = placeAlerts(alerts, STOPS, {
    operator: 'otraf',
    operatorName: 'Östgötatrafiken',
    nowSec: NOW,
  });
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.id, 'otraf:area-1');
  assert.deepEqual(row.point, [16.19, 58.59]);
  assert.equal(row.kind, 'closed');
  assert.deepEqual(
    row.alerts.map((alert) => [alert.id, alert.kind]),
    [
      ['closed', 'closed'],
      ['moved', 'moved'],
    ],
  );
  assert.equal(row.alerts[0].endsAt, (NOW + 86_400) * 1000);
});

test('the card shows the heading, new text and the end date', () => {
  const card = buildStopCard({
    id: 'otraf:area-1',
    name: 'Djäkneparksskolan',
    operatorName: 'Östgötatrafiken',
    kind: 'closed',
    alerts: [
      {
        kind: 'closed',
        header: 'Läge C avstängd',
        description: 'Läge C avstängd: buss 12 trafikerar inte hållplatsen.',
        endsAt: Date.parse('2026-12-20T12:00:00Z'),
      },
      {
        kind: 'moved',
        header: 'Läge A flyttad',
        description: 'Gäller vägarbete.',
        endsAt: null,
      },
    ],
  });
  assert.equal(card.title, 'DISRUPTION · DJÄKNEPARKSSKOLAN');
  assert.deepEqual(card.details, [
    'Läge C avstängd (until 2026-12-20)',
    'Läge A flyttad (until further notice)',
    'Gäller vägarbete.',
    'Östgötatrafiken · Trafiklab',
  ]);
});

test('the layer draws one point per stop and counts them by kind', async () => {
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
  const row = (id, kind) => ({
    id,
    name: id,
    point: [16, 58],
    operator: 'otraf',
    operatorName: 'Östgötatrafiken',
    kind,
    alerts: [],
  });
  const layer = createTransitAlertsLayer({
    source: {
      getSnapshot: async () => ({
        stops: [row('a', 'closed'), row('b', 'closed'), row('c', 'other')],
        pending: ['sl'],
        stale: false,
        fetchedAt: null,
      }),
    },
  });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  assert.equal(added.length, 3);
  const { legend } = layer.getRowControls();
  assert.deepEqual(
    legend.map((item) => item.count),
    [2, 0, 1],
  );
  assert.match(legend[0].blurb, /still loading for 1 operators/);
  layer.destroy(viewer);
});

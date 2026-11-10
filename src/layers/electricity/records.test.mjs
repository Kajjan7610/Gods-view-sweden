import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ELECTRICITY_ZONES,
  PRICE_CLASSES,
  dayAfter,
  normalizePriceDay,
  priceAt,
  priceClass,
  priceUrl,
  stockholmDay,
  summarizeDay,
} from './records.js';
import { buildZoneCard } from './cards.js';

// Shaped like a live day file from elprisetjustnu.se (quarter-hours).
const quarter = (hhmm, sek) => ({
  SEK_per_kWh: sek,
  EUR_per_kWh: sek / 11,
  EXR: 11,
  time_start: `2026-11-04T${hhmm}:00+01:00`,
  time_end: new Date(
    Date.parse(`2026-11-04T${hhmm}:00+01:00`) + 15 * 60_000,
  ).toISOString(),
});
const DAY = [
  quarter('17:45', 2.4),
  quarter('03:15', 0.85),
  quarter('12:00', 1.95),
  { SEK_per_kWh: 'n/a', time_start: 'never' },
];

test('the four zones sit inside Sweden; price classes cover every price', () => {
  assert.deepEqual(
    ELECTRICITY_ZONES.map((zone) => zone.id),
    ['SE1', 'SE2', 'SE3', 'SE4'],
  );
  for (const { point } of ELECTRICITY_ZONES)
    assert.ok(point[0] > 10 && point[0] < 25 && point[1] > 55 && point[1] < 69);
  assert.equal(priceClass(-0.2).id, 'very-low');
  assert.equal(priceClass(0.5).id, 'very-low');
  assert.equal(priceClass(1.95).id, 'medium');
  assert.equal(priceClass(12).id, 'very-high');
  assert.equal(priceClass(null), null);
  assert.equal(new Set(PRICE_CLASSES.map((c) => c.color)).size, 5);
});

test('day file URLs follow the Stockholm calendar date', () => {
  assert.equal(
    priceUrl('SE3', Date.parse('2026-11-04T23:30:00Z')),
    'https://www.elprisetjustnu.se/api/v1/prices/2026/11-05_SE3.json',
  );
  assert.equal(
    priceUrl('SE1', Date.parse('2026-11-04T12:00:00Z')),
    'https://www.elprisetjustnu.se/api/v1/prices/2026/11-04_SE1.json',
  );
});

test('a day normalizes sorted; its summary and the current quarter follow', () => {
  const rows = normalizePriceDay(DAY);
  assert.deepEqual(
    rows.map((row) => row.sek),
    [0.85, 1.95, 2.4],
  );
  assert.deepEqual(summarizeDay(rows), {
    min: 0.85,
    minAt: Date.parse('2026-11-04T03:15:00+01:00'),
    max: 2.4,
    maxAt: Date.parse('2026-11-04T17:45:00+01:00'),
    mean: 1.7333,
  });
  assert.equal(
    priceAt(rows, Date.parse('2026-11-04T12:07:00+01:00')).sek,
    1.95,
  );
  assert.equal(priceAt(rows, Date.parse('2026-11-04T12:20:00+01:00')), null);
  assert.equal(summarizeDay([]), null);
});

test('the zone card gives now, today and tomorrow, or when tomorrow comes', () => {
  const zone = {
    id: 'SE3',
    name: 'Stockholm',
    today: normalizePriceDay(DAY),
    tomorrow: [],
  };
  const card = buildZoneCard(zone, Date.parse('2026-11-04T12:07:00+01:00'));
  assert.equal(card.title, 'ELECTRICITY PRICE · SE3 STOCKHOLM');
  assert.deepEqual(card.details, [
    'Now 1.95 kr/kWh (12:00–12:15)',
    'Today: low 0.85 at 03:15, high 2.40 at 17:45, mean 1.73',
    'Tomorrow’s prices come after the day-ahead auction, early afternoon',
    'Spot price in kr/kWh, excluding VAT, grid fee and energy tax · elprisetjustnu.se',
  ]);
  const later = buildZoneCard(
    { ...zone, tomorrow: normalizePriceDay([quarter('08:00', 1.1)]) },
    Date.parse('2026-11-04T12:07:00+01:00'),
  );
  assert.equal(later.details[2], 'Tomorrow: low 1.10, high 1.10, mean 1.10');
});

test('the day after is the next calendar day in Stockholm, whatever its length', () => {
  const next = (iso) => stockholmDay(dayAfter(Date.parse(iso)));
  assert.equal(stockholmDay(Date.parse('2026-11-04T22:30:00Z')), '2026-11-04');
  assert.equal(stockholmDay(Date.parse('2026-11-04T23:10:00Z')), '2026-11-05');
  assert.equal(next('2026-11-04T10:00:00Z'), '2026-11-05');
  // 00:30 on the 25-hour day, and 23:30 on the 23-hour day.
  assert.equal(next('2026-10-24T22:30:00Z'), '2026-10-26');
  assert.equal(next('2026-03-29T21:30:00Z'), '2026-03-30');
  assert.equal(next('2026-12-31T12:00:00Z'), '2027-01-01');
  assert.match(
    priceUrl('SE3', Date.parse('2026-11-04T23:10:00Z')),
    /\/2026\/11-05_SE3\.json$/,
  );
});

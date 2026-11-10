import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildPoliceStationCard,
  deskLabel,
  formatStationDistance,
} from './cards.js';

const station = (id, lon, lat, services, extra = {}) => ({
  id,
  point: [lon, lat],
  name: `Station ${id}`,
  address: 'Storgatan 1',
  url: `https://polisen.se/om-polisen/kontakt/polisstationer/x/${id}/`,
  services,
  ...extra,
});

test('a distance below a kilometre reads in metres, rounded before its unit', () => {
  assert.equal(formatStationDistance(0.02), '20 m');
  assert.equal(formatStationDistance(0.994), '990 m');
  assert.equal(formatStationDistance(0.996), '1 km');
  assert.equal(formatStationDistance(1.4), '1 km');
  assert.equal(formatStationDistance(87.4), '87 km');
  assert.equal(formatStationDistance(undefined), '');
});

test('a desk that only hands passports out is not said to have none', () => {
  assert.equal(deskLabel('desk'), 'Public desk, no passport applications');
  // Some 190 m apart, as Stockholm Kungsholmen and the passport office are.
  const collect = station('1', 18.04, 59.33, ['passport-collect']);
  const apply = station('2', 18.04, 59.3317, ['passport-apply']);
  const card = buildPoliceStationCard(collect, {
    stations: [collect, apply],
    linkable: true,
  });
  assert.ok(card.details.includes('Collect a passport or ID card'));
  assert.ok(
    card.details.includes('Nearest passport application: Station 2, 190 m'),
  );
  // A station taking applications names no other.
  const own = buildPoliceStationCard(apply, { stations: [collect, apply] });
  assert.equal(
    own.details.some((line) => line.startsWith('Nearest passport')),
    false,
  );
});

test('the card can always be hit; it is a link only with a page to open', () => {
  const row = station('1', 18.04, 59.33, []);
  const linked = buildPoliceStationCard(row, { linkable: true });
  assert.equal(linked.id, 'police-stations-card:1');
  assert.equal(linked.interactive, true);
  assert.ok(linked.accessibilityLabel);
  for (const card of [
    buildPoliceStationCard(row),
    buildPoliceStationCard({ ...row, url: null }, { linkable: true }),
  ]) {
    assert.equal(card.interactive, true);
    assert.equal(card.accessibilityLabel, undefined);
  }
});

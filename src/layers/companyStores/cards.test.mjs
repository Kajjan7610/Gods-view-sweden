import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStoreCard, formatDistance } from './cards.js';

const store = (extra = {}) => ({
  id: 'n1',
  company: 'ica',
  brand: 'ICA Nära',
  name: 'ICA Nära Lundmans',
  point: [18.06, 59.33],
  address: 'Storgatan 1',
  hours: null,
  ...extra,
});

test('a distance is tens of metres, then kilometres with one decimal', () => {
  assert.equal(formatDistance(0), '10 m');
  assert.equal(formatDistance(4), '10 m');
  assert.equal(formatDistance(14), '10 m');
  assert.equal(formatDistance(15), '20 m');
  assert.equal(formatDistance(354), '350 m');
  assert.equal(formatDistance(994), '990 m');
  // Never "1,000 m": what rounds to a kilometre is a kilometre.
  assert.equal(formatDistance(995), '1.0 km');
  assert.equal(formatDistance(999), '1.0 km');
  assert.equal(formatDistance(1000), '1.0 km');
  assert.equal(formatDistance(1049), '1.0 km');
  assert.equal(formatDistance(1234), '1.2 km');
  assert.equal(formatDistance(12_345), '12.3 km');
});

test('the date hours were checked is told only with the hours', () => {
  const checked = (row) =>
    buildStoreCard(row).details.filter((line) => line.includes('2026-05-01'));
  assert.deepEqual(
    checked(store({ hours: 'Mo-Su 08:00-21:00', checked: '2026-05-01' })),
    ['Hours checked on site 2026-05-01'],
  );
  assert.deepEqual(checked(store({ checked: '2026-05-01' })), []);
  assert.deepEqual(checked(store({ hours: 'Mo-Su 08:00-21:00' })), []);
});

test('the card always takes its own clicks, and names a link only when it has one', () => {
  const website = 'https://www.ica.se/butiker/1/';
  const linked = buildStoreCard(store({ website }), {}, { linkable: true });
  assert.equal(linked.interactive, true);
  assert.equal(
    linked.accessibilityLabel,
    'Open the web page of ICA NÄRA LUNDMANS',
  );
  assert.ok(linked.details.includes('Store web page ↗ · click card to open'));
  for (const card of [
    buildStoreCard(store(), {}, { linkable: true }),
    buildStoreCard(store({ website }), {}, { linkable: false }),
    buildStoreCard(store({ website })),
  ]) {
    assert.equal(card.interactive, true);
    assert.equal('accessibilityLabel' in card, false);
    assert.ok(!card.details.some((line) => line.includes('click card')));
  }
});

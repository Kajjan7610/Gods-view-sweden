import assert from 'node:assert/strict';
import test from 'node:test';
import {
  normalizeRemain,
  normalizeRemains,
  remainUrl,
  remainsInView,
  snapToGrid,
} from './records.js';
import { buildRemainCard } from './cards.js';

const feature = (overrides = {}, geometry = { type: 'Point', coordinates: [16.54104, 59.60766] }) => ({
  type: 'Feature',
  id: 'kulturhistoriska_fornlamningar.107c5002-a593-440f-b131-69fca287b448',
  geometry,
  properties: {
    url: 'https://pub.raa.se/visa/objekt/lamning/89bc33cb-def0-413a-b04c-183702e1894a',
    raa_nummer: 'Västerås 380:1',
    pk_id: '107c5002-a593-440f-b131-69fca287b448',
    lan: 'Västmanland',
    lamningstyp: 'Husgrund, historisk tid',
    lamningsnummer: 'L2003:9362',
    lamningsnamn: null,
    kommun: 'Västerås',
    antikvariskbedomning: 'Övrig kulturhistorisk lämning',
    aktualitetstatus: 'Bekräftad i fält',
    ...overrides,
  },
});

test('a remain keeps what identifies it, and its page at RAÄ', () => {
  assert.deepEqual(normalizeRemain(feature()), {
    id: '107c5002-a593-440f-b131-69fca287b448',
    point: [16.54104, 59.60766],
    type: 'Husgrund, historisk tid',
    number: 'L2003:9362',
    raa: 'Västerås 380:1',
    name: null,
    municipality: 'Västerås',
    assessment: 'okl',
    confirmed: true,
    page: '89bc33cb-def0-413a-b04c-183702e1894a',
  });
  assert.equal(
    remainUrl('89bc33cb-def0-413a-b04c-183702e1894a'),
    'https://pub.raa.se/visa/objekt/lamning/89bc33cb-def0-413a-b04c-183702e1894a',
  );
});

test('lines and areas are drawn at a point of their own', () => {
  const area = normalizeRemain(
    feature({}, {
      type: 'Polygon',
      coordinates: [[[16.5, 59.6], [16.52, 59.6], [16.52, 59.62], [16.5, 59.62], [16.5, 59.6]]],
    }),
  );
  assert.deepEqual(area.point, [16.51, 59.61]);
  const line = normalizeRemain(
    feature({}, { type: 'LineString', coordinates: [[16.5, 59.6], [16.51, 59.61], [16.52, 59.62]] }),
  );
  assert.deepEqual(line.point, [16.51, 59.61]);
});

test('the assessment is read, and a stranger one counts as none', () => {
  const assessment = (value) =>
    normalizeRemain(feature({ antikvariskbedomning: value })).assessment;
  assert.equal(assessment('Fornlämning'), 'fl');
  assert.equal(assessment('Möjlig fornlämning'), 'mfl');
  assert.equal(assessment('Ingen antikvarisk bedömning'), 'none');
  assert.equal(assessment('Ej kulturhistorisk lämning'), 'ej');
  assert.equal(assessment('något annat'), 'none');
});

test('a remain without an id, a place in Sweden or a safe page is cut', () => {
  assert.equal(normalizeRemain(feature({ pk_id: 'x' })), null);
  assert.equal(
    normalizeRemain(feature({}, { type: 'Point', coordinates: [2.35, 48.85] })),
    null,
  );
  // A link elsewhere is dropped; the remain stays.
  assert.equal(
    normalizeRemain(feature({ url: 'https://example.com/lamning/89bc33cb-def0-413a-b04c-183702e1894a' })).page,
    null,
  );
  assert.equal(normalizeRemains([feature(), feature(), null]).length, 1);
});

test('a view box is widened to the shared grid', () => {
  assert.deepEqual(snapToGrid([16.481, 59.581, 16.619, 59.639]), [16.48, 59.58, 16.62, 59.64]);
  assert.deepEqual(snapToGrid([16.48, 59.58, 16.62, 59.64]), [16.48, 59.58, 16.62, 59.64]);
});

test('the view gets its remains nearest the centre first', () => {
  const rows = [
    { id: 'far', point: [16.6, 59.62] },
    { id: 'near', point: [16.545, 59.611] },
    { id: 'out', point: [17.5, 59.9] },
  ];
  const view = remainsInView(rows, {
    bbox: [16.48, 59.58, 16.62, 59.64],
    center: [16.5448, 59.6105],
    limit: 10,
  });
  assert.equal(view.total, 2);
  assert.deepEqual(view.remains.map(({ id }) => id), ['near', 'far']);
  assert.ok(view.remains[0].distance < 100);
});

test('a card names the remain, its assessment and number, and its source', () => {
  const row = { ...normalizeRemain(feature()), distance: 99 };
  const card = buildRemainCard(row, { linkable: true });
  assert.equal(card.title, 'REMAIN · Husgrund, historisk tid');
  assert.deepEqual(card.details, [
    'Other cultural-historical remain',
    'L2003:9362 · Västerås 380:1',
    'Västerås',
    '100 m from the map centre',
    'RAÄ ↗ · click card to open',
    'Source: Riksantikvarieämbetet',
  ]);
  assert.equal(card.accessibilityLabel, 'Open Husgrund, historisk tid at Riksantikvarieämbetet');
  const named = buildRemainCard({
    ...row,
    name: 'Anundshög',
    assessment: 'fl',
    confirmed: false,
    distance: undefined,
  });
  assert.equal(named.title, 'REMAIN · Anundshög');
  assert.deepEqual(named.details.slice(0, 2), [
    'Husgrund, historisk tid',
    'Ancient monument (protected)',
  ]);
  assert.ok(named.details.includes('Not confirmed in the field'));
  assert.equal(named.accessibilityLabel, undefined);
});

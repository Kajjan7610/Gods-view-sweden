import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EVENT_CATEGORIES,
  categoryColor,
  createPlaceLookup,
  eventCategory,
  normalizePoliceEvent,
  normalizePoliceEvents,
  parseEventTime,
  parseGps,
  placeOf,
  spreadAroundPlaces,
} from './records.js';
import { buildPoliceCard } from './cards.js';

const GAZETTEER = [
  ['0180', 'Stockholms', 'Stockholm', 18.0686, 59.3294],
  ['1480', 'Göteborgs', 'Göteborg', 11.9675, 57.7075],
  ['1980', 'Västerås', '', 16.5422, 59.6173],
  ['2080', 'Falu', 'Falun', 15.6561, 60.6027],
  ['0980', 'Gotland', 'Visby', 18.3071, 57.629],
];
const lookup = createPlaceLookup(GAZETTEER);

// Shaped like a live notice from polisen.se/api/events.
const EVENT = {
  id: 658452,
  datetime: '2026-11-04 17:12:33 +01:00',
  name: '4 november 17.02, Trafikolycka, Göteborg',
  summary: 'Elspark och personbil i trafikolycka.',
  url: '/aktuellt/handelser/2026/november/4/4-november-17.02-trafikolycka-goteborg/',
  type: 'Trafikolycka',
  location: { name: 'Västra Götalands län', gps: '58.252793,13.059643' },
};

test('event types sort into legend categories; summaries stand apart', () => {
  assert.equal(eventCategory('Trafikolycka, vilt'), 'traffic');
  assert.equal(eventCategory('Rattfylleri'), 'traffic');
  assert.equal(eventCategory('Misshandel, grov'), 'violence');
  assert.equal(eventCategory('Mord/dråp, försök'), 'violence');
  assert.equal(eventCategory('Brand'), 'fire');
  assert.equal(eventCategory('Arbetsplatsolycka'), 'fire');
  assert.equal(eventCategory('Stöld/inbrott'), 'property');
  assert.equal(eventCategory('Narkotikabrott'), 'drugs');
  assert.equal(eventCategory('Försvunnen person'), 'missing');
  assert.equal(eventCategory('Sammanfattning natt'), 'summary');
  assert.equal(eventCategory('Övrigt'), 'other');
  const colors = EVENT_CATEGORIES.map(({ color }) => color);
  assert.equal(new Set(colors).size, colors.length);
  assert.equal(categoryColor('nonsense'), categoryColor('other'));
});

test('times, coordinates and the titled place parse', () => {
  assert.equal(
    parseEventTime('2026-11-04 17:12:33 +01:00'),
    Date.parse('2026-11-04T16:12:33Z'),
  );
  assert.equal(
    parseEventTime('2026-07-01 9:05:00 +02:00'),
    Date.parse('2026-07-01T07:05:00Z'),
  );
  assert.equal(parseEventTime('yesterday'), null);
  assert.deepEqual(parseGps('58.252793,13.059643'), [13.059643, 58.252793]);
  assert.equal(parseGps('north'), null);
  assert.equal(placeOf('4 november 17.02, Trafikolycka, Göteborg'), 'Göteborg');
  assert.equal(placeOf('no commas'), null);
});

test('the lookup answers plain, genitive and seat names, exact names first', () => {
  assert.deepEqual(lookup('Stockholm'), [18.0686, 59.3294]);
  assert.deepEqual(lookup('stockholms'), [18.0686, 59.3294]);
  assert.deepEqual(lookup('Falun'), [15.6561, 60.6027]);
  assert.deepEqual(lookup('Västerås'), [16.5422, 59.6173]);
  assert.deepEqual(lookup('Gotland'), [18.3071, 57.629]);
  assert.equal(lookup('Atlantis'), null);
});

test('a notice lands on its municipality, or on the county centre when it is county-wide', () => {
  const row = normalizePoliceEvent(EVENT, lookup);
  assert.deepEqual(
    { ...row },
    {
      id: '658452',
      time: Date.parse('2026-11-04T16:12:33Z'),
      type: 'Trafikolycka',
      category: 'traffic',
      title: '4 november 17.02, Trafikolycka, Göteborg',
      summary: 'Elspark och personbil i trafikolycka.',
      place: 'Göteborg',
      county: 'Västra Götalands län',
      precision: 'municipality',
      point: [11.9675, 57.7075],
      link: 'https://polisen.se/aktuellt/handelser/2026/november/4/4-november-17.02-trafikolycka-goteborg/',
    },
  );
  const summary = normalizePoliceEvent(
    {
      ...EVENT,
      id: 658400,
      name: '4 november 06.40, Sammanfattning natt, Västra Götalands län',
      type: 'Sammanfattning natt',
    },
    lookup,
  );
  assert.equal(summary.precision, 'county');
  assert.equal(summary.place, 'Västra Götalands län');
  assert.deepEqual(summary.point, [13.059643, 58.252793]);
  assert.equal(
    normalizePoliceEvent({ ...EVENT, url: '//evil.example/x' }, lookup).link,
    null,
  );
  assert.equal(normalizePoliceEvent({ ...EVENT, datetime: '' }, lookup), null);
});

test('the answer is newest first without duplicates; malformed answers throw', () => {
  const { events } = normalizePoliceEvents(
    [{ ...EVENT, id: 1, datetime: '2026-11-04 10:00:00 +01:00' }, EVENT, EVENT],
    lookup,
  );
  assert.deepEqual(
    events.map((row) => row.id),
    ['658452', '1'],
  );
  assert.throws(() => normalizePoliceEvents({}, lookup), /Malformed/);
});

test('notices sharing a place spread around it, the newest at the centre', () => {
  const rows = [0, 1, 2, 3].map((index) => ({
    id: String(index),
    point: [11.9675, 57.7075],
  }));
  const spread = spreadAroundPlaces(rows, 900);
  assert.deepEqual(spread.get('0'), [11.9675, 57.7075]);
  const points = [...spread.values()].map((point) => point.join(','));
  assert.equal(new Set(points).size, 4, 'every notice gets its own spot');
  const [lon, lat] = spread.get('1');
  const metres = Math.hypot(
    (lon - 11.9675) * 111_320 * Math.cos((57.7075 * Math.PI) / 180),
    (lat - 57.7075) * 111_320,
  );
  assert.ok(Math.abs(metres - 900) < 5, `${metres} m`);
});

test('the card reads the notice, its time and how exact its place is', () => {
  const row = normalizePoliceEvent(EVENT, lookup);
  const card = buildPoliceCard(row, { linkable: true });
  assert.equal(card.title, 'TRAFIKOLYCKA · GÖTEBORG');
  assert.equal(card.interactive, true);
  assert.equal(card.accent, categoryColor('traffic'));
  assert.deepEqual(card.details, [
    'Elspark och personbil i trafikolycka.',
    '2026-11-04 17:12',
    'Drawn near the centre of Göteborg; Polisen gives no exact place',
    'polisen.se ↗ · click card to open',
  ]);
  assert.equal(buildPoliceCard(row).interactive, false);
});

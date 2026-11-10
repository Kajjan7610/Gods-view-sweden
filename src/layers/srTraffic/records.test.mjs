import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SR_PRIORITIES,
  normalizeSrMessage,
  normalizeSrMessages,
  parseSrDate,
  priorityColor,
} from './records.js';
import { SR_TRAFFIC_PAGE, buildSrCard } from './cards.js';

// Shaped like a live message from api.sr.se/api/v2/traffic/messages.
const MESSAGE = {
  id: 10153471,
  priority: 2,
  createddate: '/Date(1793772842313+0100)/',
  title: 'Rv 62 Deje-Forshaga',
  exactlocation: 'Tjärnheden-Återvinningscentral Orretorp',
  description: ' Vägen avstängd. Omledning via Rissätter och Deje\n',
  latitude: 59.59186553955078,
  longitude: 13.45508098602295,
  category: 0,
  subcategory: 'Vägarbete',
};

test('SR dates and priorities read as published', () => {
  assert.equal(parseSrDate('/Date(1793772842313+0100)/'), 1793772842313);
  assert.equal(
    parseSrDate('2026-11-04T10:00:00Z'),
    Date.parse('2026-11-04T10:00:00Z'),
  );
  assert.equal(parseSrDate('soon'), null);
  assert.equal(new Set(SR_PRIORITIES.map((p) => p.color)).size, 5);
  assert.equal(priorityColor(9), '#b0bec5');
});

test('a message normalizes; ones without a Swedish place drop', () => {
  assert.deepEqual(normalizeSrMessage(MESSAGE), {
    id: '10153471',
    point: [13.45508, 59.59187],
    priority: 2,
    category: 'road',
    kind: 'Vägarbete',
    title: 'Rv 62 Deje-Forshaga',
    location: 'Tjärnheden-Återvinningscentral Orretorp',
    description: 'Vägen avstängd. Omledning via Rissätter och Deje',
    created: 1793772842313,
  });
  assert.equal(
    normalizeSrMessage({ ...MESSAGE, latitude: 0, longitude: 0 }),
    null,
  );
  assert.equal(normalizeSrMessage({ ...MESSAGE, priority: 9 }).priority, 5);
  assert.equal(
    normalizeSrMessage({ ...MESSAGE, category: 1 }).category,
    'transit',
  );
});

test('the answer sorts most serious first and drops duplicates', () => {
  const { messages } = normalizeSrMessages({
    messages: [
      { ...MESSAGE, id: 1, priority: 4 },
      MESSAGE,
      MESSAGE,
      { ...MESSAGE, id: 2, priority: 1 },
    ],
  });
  assert.deepEqual(
    messages.map((row) => row.id),
    ['2', '10153471', '1'],
  );
  assert.throws(() => normalizeSrMessages({}), /Malformed/);
});

test('the card reads kind, road, place, report and priority', () => {
  const card = buildSrCard(normalizeSrMessage(MESSAGE));
  assert.equal(card.title, 'VÄGARBETE · RV 62 DEJE-FORSHAGA');
  assert.deepEqual(card.details, [
    'Tjärnheden-Återvinningscentral Orretorp',
    'Vägen avstängd. Omledning via Rissätter och Deje',
    'Major incident · 2026-11-04 07:14',
    'Sveriges Radio traffic report',
  ]);
  assert.equal(card.accent, priorityColor(2));
});

test('the whole report is shown as SR published it, and a linked card says so', () => {
  // A long report: SR's terms forbid modifying the material, so nothing is cut.
  const description = Array.from(
    { length: 40 },
    (_, index) => `Mening ${index + 1} om omledningen.`,
  ).join(' ');
  const row = normalizeSrMessage({ ...MESSAGE, description });
  assert.equal(row.description, description);
  const card = buildSrCard(row, { linkable: true });
  const shown = card.details.slice(1, -3).join(' ');
  assert.equal(shown, description);
  assert.ok(!shown.includes('…'));
  assert.equal(card.details.at(-2), 'Sveriges Radio traffic report');
  assert.equal(card.details.at(-1), 'sverigesradio.se ↗ · click card to open');
  assert.equal(
    card.accessibilityLabel,
    'Open VÄGARBETE · RV 62 DEJE-FORSHAGA at Sveriges Radio',
  );
  // Without a way to open pages the card offers none.
  const plain = buildSrCard(row);
  assert.equal(plain.accessibilityLabel, undefined);
  assert.ok(!plain.details.some((line) => line.includes('↗')));
  assert.match(SR_TRAFFIC_PAGE, /^https:\/\/www\.sverigesradio\.se\/trafik$/);
});

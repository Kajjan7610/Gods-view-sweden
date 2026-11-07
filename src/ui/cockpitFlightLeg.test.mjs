// The cockpit's Swedavia card: how a leg reads, and that the cockpit asks
// for the flown aircraft at its route's Swedavia ends and the board's hint.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createCockpitFlightLeg, legView } from './cockpitFlightLeg.js';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const at = (hhmm) => Date.parse(`2026-11-07T${hhmm}:00Z`);
const flight = (extra = {}) => ({
  flight: 'SK1427',
  airline: 'SAS',
  codeshares: [],
  planned: at('11:20'),
  expected: at('11:20'),
  actual: null,
  delayMinutes: 0,
  remark: null,
  status: { sv: 'Planerad', en: 'Scheduled' },
  canceled: false,
  terminal: 'T5',
  gate: 'F39',
  baggage: null,
  ...extra,
});
const ARN = { iata: 'ARN', name: 'Stockholm Arlanda' };
const GOT = { iata: 'GOT', name: 'Göteborg Landvetter' };

test('a departure that has left, an arrival still to come', () => {
  const left = legView(
    {
      airport: ARN,
      kind: 'departures',
      flight: flight({
        actual: at('11:29'),
        delayMinutes: 9,
        expected: at('11:29'),
      }),
    },
    NOW,
  );
  assert.match(left.label, /Stockholm Arlanda/);
  assert.match(left.time, /:29/, "Stockholm time, in the locale's own clock");
  assert.equal(left.delay, '+9 min');
  assert.equal(left.detail, 'T5 · gate F39');
  assert.equal(left.tone, 'neutral');

  const coming = legView(
    {
      airport: GOT,
      kind: 'arrivals',
      flight: flight({
        planned: at('12:05'),
        expected: at('12:23'),
        delayMinutes: 18,
        gate: '14',
        baggage: { belt: '3' },
        remark: { sv: 'Försenad', en: 'Delayed', tone: 'negative' },
      }),
    },
    NOW,
  );
  assert.match(coming.time, /:23/);
  assert.match(
    coming.time,
    /23 min/,
    'a countdown while it is under three hours',
  );
  assert.equal(coming.detail, 'T5 · gate 14 · belt 3');
  assert.equal(coming.tone, 'negative');
  assert.match(coming.status, /Delayed|Försenad/);
});

test('the cockpit asks at the route ends and the board hint, and clears on exit', async () => {
  const windowRef = new EventTarget();
  const urls = [];
  const published = [];
  const dataManager = {
    layers: new Map([
      [
        'flights',
        {
          module: {
            getTrackedInfo: () => ({
              icao24: 'abc123',
              callsign: 'SAS1427',
              registration: 'SE-ROH',
              origin: 'ARN',
              destination: 'CPH',
            }),
          },
        },
      ],
    ]),
  };
  const card = createCockpitFlightLeg({
    dataManager,
    publish: (view) => published.push(view),
    fetchImpl: async (url) => {
      urls.push(url);
      return new Response(
        JSON.stringify({
          legs: [{ airport: ARN, kind: 'departures', flight: flight() }],
        }),
      );
    },
    now: () => NOW,
    windowRef,
  });
  card.hint('abc123', 'GOT');
  windowRef.dispatchEvent(
    new CustomEvent('gev:cockpit-mode-changed', {
      detail: { active: true, subjectId: 'abc123', layerId: 'flights' },
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  const query = new URL(urls[0], 'http://local').searchParams;
  assert.equal(query.get('callsign'), 'SAS1427');
  assert.equal(query.get('registration'), 'SE-ROH');
  assert.equal(query.get('airports'), 'ARN,GOT', 'CPH is not Swedavia');
  const view = published.at(-1);
  assert.equal(view.flight, 'SK1427 · SAS');
  assert.equal(view.legs.length, 1);
  windowRef.dispatchEvent(
    new CustomEvent('gev:cockpit-mode-changed', { detail: { active: false } }),
  );
  assert.equal(published.at(-1), null);
  card.destroy();
});

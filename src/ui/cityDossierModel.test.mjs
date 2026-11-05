// The city dossier's pure parts: sun, election year, population trend,
// the town's police notices and the nearest air quality reading.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  electionYear,
  nearestReading,
  policeEventsFor,
  populationChange,
  sparklinePoints,
  sunTimes,
} from './cityDossierModel.js';

const stockholmClock = (ms) =>
  new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms);

test('sunrise and sunset match the almanac within a few minutes', () => {
  // Gävle, 5 November 2026: about 07:27 and 15:42 local time.
  const gavle = sunTimes(60.675, 17.14, Date.parse('2026-11-05T12:00:00Z'));
  assert.equal(gavle.polar, null);
  const minutes = (ms) => {
    const [h, m] = stockholmClock(ms).split(':').map(Number);
    return h * 60 + m;
  };
  assert.ok(Math.abs(minutes(gavle.rise) - (7 * 60 + 27)) <= 4);
  assert.ok(Math.abs(minutes(gavle.set) - (15 * 60 + 42)) <= 4);
  // Kiruna has the midnight sun at midsummer and the polar night at Yule.
  assert.equal(
    sunTimes(67.86, 20.23, Date.parse('2026-06-21T12:00:00Z')).polar,
    'day',
  );
  assert.equal(
    sunTimes(67.86, 20.23, Date.parse('2026-12-21T12:00:00Z')).polar,
    'night',
  );
});

test("Kolada's election figures belong to the latest September election", () => {
  assert.equal(electionYear(2022), 2022);
  assert.equal(electionYear(2025), 2022);
  assert.equal(electionYear(2026), 2026);
  assert.equal(electionYear(2021), 2018);
  assert.equal(electionYear(NaN), null);
});

test('population change and its curve', () => {
  const history = [
    { year: 2016, value: 99788 },
    { year: 2020, value: 102904 },
    { year: 2025, value: 104108 },
  ];
  const change = populationChange(history);
  assert.deepEqual(
    { ...change, percent: Math.round(change.percent * 10) / 10 },
    { fromYear: 2016, toYear: 2025, change: 4320, percent: 4.3 },
  );
  assert.equal(populationChange(history.slice(0, 1)), null);
  const points = sparklinePoints(history, 220, 44).split(' ');
  assert.equal(points.length, 3);
  assert.equal(points[0].split(',')[0], '0');
  assert.equal(points[2].split(',')[0], '220');
  assert.ok(Number(points[2].split(',')[1]) < Number(points[0].split(',')[1]));
});

test("a town's police notices are its municipality's, from the last day", () => {
  const now = Date.parse('2026-11-05T18:00:00Z');
  const event = (id, place, hoursAgo, precision = 'municipality') => ({
    id,
    place,
    precision,
    time: now - hoursAgo * 36e5,
  });
  const events = [
    event('a', 'Stockholm', 2),
    event('b', 'Stockholm', 30),
    event('c', 'Stockholms län', 1, 'county'),
    event('d', 'Solna', 1),
    event('e', 'Stockholm', 0.5),
  ];
  assert.deepEqual(
    policeEventsFor(
      events,
      { name: 'Stockholm', municipality: 'Stockholms' },
      now,
    ).map((row) => row.id),
    ['e', 'a'],
  );
});

test('the nearest air quality reading within reach', () => {
  const readings = [
    { name: 'Far', lat: 59.0, lon: 18.0 },
    { name: 'Gävle Staketgatan', lat: 60.676, lon: 17.146 },
  ];
  assert.equal(
    nearestReading(readings, [17.14, 60.675]).name,
    'Gävle Staketgatan',
  );
  assert.equal(nearestReading(readings, [20.2, 67.85]), null);
});

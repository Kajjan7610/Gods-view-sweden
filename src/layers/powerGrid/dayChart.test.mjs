import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDayChart,
  dayStartOf,
  midnightBefore,
  midnightOf,
} from './dayChart.js';

const QUARTER = 900_000;
const HOUR = 3_600_000;
const utc = (text) => Date.parse(text);

// The Swedish clock read independently of the module under test.
const STOCKHOLM = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const stockholm = (ms) => STOCKHOLM.format(ms);

/** `count` quarter-hours from `start`, each with a net that changes sign. */
const quarters = (start, count) =>
  Array.from({ length: count }, (_, i) => ({
    at: start + i * QUARTER,
    nuclear: 6000,
    hydro: 9000,
    total: 15_000,
    consumption: 14_000,
    net: i % 2 ? 800 : -400,
  }));

const insidePlot = (chart) =>
  chart.points.every(
    (point) => point.x >= chart.plotLeft && point.x <= chart.plotRight,
  );

test('an ordinary day is 96 quarter-hours between two Swedish midnights', () => {
  const start = utc('2026-11-09T23:00:00Z'); // 10 Nov, 00:00 in Stockholm
  const chart = buildDayChart(quarters(start, 96));
  assert.equal(chart.start, start);
  assert.equal(chart.end - chart.start, 24 * HOUR);
  assert.ok(insidePlot(chart));
  assert.equal(chart.points[0].x, chart.plotLeft);
  assert.equal(chart.points.at(-1).x, 291.3);
  assert.deepEqual(
    chart.xTicks.map((tick) => tick.hour),
    [0, 6, 12, 18, 0],
  );
  assert.deepEqual(
    chart.xTicks.map((tick) => tick.x),
    [34, 99, 164, 229, 294],
  );
});

test('the 25-hour day keeps all 100 quarter-hours inside the plot', () => {
  const start = utc('2026-10-24T22:00:00Z'); // 25 Oct, 00:00 summer time
  const chart = buildDayChart(quarters(start, 100));
  assert.equal(chart.start, start);
  assert.equal(chart.end - chart.start, 25 * HOUR);
  assert.ok(insidePlot(chart), 'no point right of the plot');
  assert.ok(chart.points.at(-1).x < chart.plotRight);
  assert.equal(chart.points.at(-1).x, 291.4);
  // Each tick stands where the Swedish clock shows its hour.
  assert.deepEqual(
    chart.xTicks.map((tick) => stockholm(tick.at)),
    [
      '2026-10-25 00:00',
      '2026-10-25 06:00',
      '2026-10-25 12:00',
      '2026-10-25 18:00',
      '2026-10-26 00:00',
    ],
  );
  assert.deepEqual(
    chart.xTicks.map((tick) => tick.hour),
    [0, 6, 12, 18, 0],
  );
  // 06:00 is seven hours into this day, not six.
  assert.equal(chart.xTicks[1].at - start, 7 * HOUR);
  assert.equal(chart.xTicks[1].x, 106.8);
  assert.equal(chart.xTicks.at(-1).x, chart.plotRight);
});

test('the 23-hour day fills the plot with its 92 quarter-hours', () => {
  const start = utc('2026-03-28T23:00:00Z'); // 29 Mar, 00:00 winter time
  const chart = buildDayChart(quarters(start, 92));
  assert.equal(chart.end - chart.start, 23 * HOUR);
  assert.ok(insidePlot(chart));
  // The last quarter-hour ends at the right edge: a 24 h axis left a gap.
  assert.equal(chart.points.at(-1).x, 291.2);
  assert.deepEqual(
    chart.xTicks.map((tick) => stockholm(tick.at)),
    [
      '2026-03-29 00:00',
      '2026-03-29 06:00',
      '2026-03-29 12:00',
      '2026-03-29 18:00',
      '2026-03-30 00:00',
    ],
  );
  assert.equal(chart.xTicks[1].at - start, 5 * HOUR);
});

test('a hole in a change day stays a gap, and import draws below zero', () => {
  const start = utc('2026-10-24T22:00:00Z');
  const all = quarters(start, 100);
  // The repeated hour (02:00–03:00 winter time) is missing.
  const points = all.filter((_, i) => i < 12 || i >= 16);
  const chart = buildDayChart(points, { start });
  assert.equal(chart.areas[0].d.split('Z').length - 1, 2, 'two runs');
  assert.equal(chart.consumption.split('M').length - 1, 2);
  // Quarter-hours on both sides of the clock change are neighbours.
  const whole = buildDayChart(all, { start });
  assert.equal(whole.areas[0].d.split('Z').length - 1, 1, 'one run');

  const importing = buildDayChart(
    all.map((point) => ({ ...point, net: -1200 })),
    { start },
  );
  const ys = (d) =>
    [...d.matchAll(/[ML][\d.]+,([\d.]+)/g)].map((match) => Number(match[1]));
  assert.ok(
    ys(importing.net.imported).every((y) => y >= importing.net.zeroY),
    'import on or below the zero line',
  );
  assert.ok(
    ys(importing.net.exported).every((y) => y === importing.net.zeroY),
    'nothing above it',
  );
  assert.equal(importing.totals.exported, 0);
  assert.equal(importing.totals.imported, 30_000); // 1 200 MW for 25 h
});

test('the Swedish midnight is found on and after a clock change', () => {
  // Autumn: the day starts in summer time and ends in winter time.
  const autumn = utc('2026-10-24T22:00:00Z');
  assert.equal(midnightBefore(utc('2026-10-24T22:00:00Z')), autumn);
  assert.equal(midnightBefore(utc('2026-10-25T00:30:00Z')), autumn);
  assert.equal(midnightBefore(utc('2026-10-25T12:00:00Z')), autumn);
  assert.equal(midnightBefore(utc('2026-10-25T22:59:59Z')), autumn);
  assert.equal(
    midnightBefore(utc('2026-10-25T23:00:00Z')),
    utc('2026-10-25T23:00:00Z'),
  );
  assert.equal(
    midnightBefore(utc('2026-10-26T12:00:00Z')),
    utc('2026-10-25T23:00:00Z'),
  );
  // Spring: the other way.
  const spring = utc('2026-03-28T23:00:00Z');
  assert.equal(midnightBefore(utc('2026-03-29T00:59:00Z')), spring);
  assert.equal(midnightBefore(utc('2026-03-29T12:00:00Z')), spring);
  assert.equal(midnightBefore(utc('2026-03-29T21:59:00Z')), spring);
  assert.equal(
    midnightBefore(utc('2026-03-29T22:00:00Z')),
    utc('2026-03-29T22:00:00Z'),
  );
  // Seconds and milliseconds into a minute do not move it.
  assert.equal(midnightBefore(utc('2026-10-25T12:34:56.789Z')), autumn);

  assert.equal(midnightOf('2026-10-25'), autumn);
  assert.equal(midnightOf('2026-10-26'), utc('2026-10-25T23:00:00Z'));
  assert.equal(midnightOf('2026-03-29'), spring);
  assert.equal(midnightOf('2026-03-30'), utc('2026-03-29T22:00:00Z'));
  assert.equal(midnightOf(''), null);
  assert.equal(midnightOf(undefined), null);

  assert.equal(
    dayStartOf([{ at: utc('2026-10-25T09:15:00Z') }]),
    autumn,
    'a first point after the change still belongs to its own midnight',
  );
  assert.equal(dayStartOf([]), null);
});

test('a week across the autumn change has a tick on every Swedish midnight', () => {
  const start = midnightOf('2026-10-20');
  const points = [
    ...quarters(start, 4),
    ...quarters(midnightOf('2026-10-25'), 100),
    ...quarters(midnightOf('2026-10-26'), 96),
  ];
  const chart = buildDayChart(points, { start, days: 7 });
  assert.equal(chart.start, utc('2026-10-19T22:00:00Z'));
  assert.equal(chart.end - chart.start, (7 * 24 + 1) * HOUR);
  assert.deepEqual(
    chart.xTicks.map((tick) => stockholm(tick.at)),
    [
      '2026-10-20 00:00',
      '2026-10-21 00:00',
      '2026-10-22 00:00',
      '2026-10-23 00:00',
      '2026-10-24 00:00',
      '2026-10-25 00:00',
      '2026-10-26 00:00',
      '2026-10-27 00:00',
    ],
  );
  assert.equal(chart.xTicks[0].x, chart.plotLeft);
  assert.equal(chart.xTicks.at(-1).x, chart.plotRight);
  assert.ok(insidePlot(chart));
  // The long day is one hour wider than the day before it.
  const width = (i) => chart.xTicks[i + 1].at - chart.xTicks[i].at;
  assert.equal(width(4), 24 * HOUR);
  assert.equal(width(5), 25 * HOUR);
  assert.equal(width(6), 24 * HOUR);
});

test('a week that starts the day after a change starts on its midnight', () => {
  // With a fixed 24 h day these started an hour off.
  const autumn = buildDayChart(quarters(midnightOf('2026-10-26'), 8), {
    start: midnightOf('2026-10-26'),
    days: 7,
  });
  assert.equal(stockholm(autumn.start), '2026-10-26 00:00');
  assert.equal(autumn.end - autumn.start, 7 * 24 * HOUR);

  const spring = buildDayChart(quarters(midnightOf('2026-03-25'), 8), {
    start: midnightOf('2026-03-25'),
    days: 7,
  });
  assert.deepEqual(
    spring.xTicks.map((tick) => stockholm(tick.at).slice(5)),
    [
      '03-25 00:00',
      '03-26 00:00',
      '03-27 00:00',
      '03-28 00:00',
      '03-29 00:00',
      '03-30 00:00',
      '03-31 00:00',
      '04-01 00:00',
    ],
  );
  assert.equal(spring.end - spring.start, (7 * 24 - 1) * HOUR);
});

test('the time zone is read once a build, not once a quarter-hour', (t) => {
  const formatToParts = Intl.DateTimeFormat.prototype.formatToParts;
  let calls = 0;
  t.mock.method(
    Intl.DateTimeFormat.prototype,
    'formatToParts',
    function count(...args) {
      calls += 1;
      return formatToParts.apply(this, args);
    },
  );
  const start = utc('2026-10-24T22:00:00Z');
  buildDayChart(quarters(start, 4), { start });
  const few = calls;
  calls = 0;
  buildDayChart(quarters(start, 100), { start });
  assert.equal(calls, few, 'the same work for 4 points as for 100');
  assert.ok(few <= 16, `${few} clock reads for a day`);
  calls = 0;
  buildDayChart(quarters(start, 100), { start, days: 7 });
  assert.ok(calls <= 16, `${calls} clock reads for a week`);
});

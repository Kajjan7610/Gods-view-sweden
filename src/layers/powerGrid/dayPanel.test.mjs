import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../../i18n/index.js';
import { midnightOf } from './dayChart.js';
import { createPowerDay, powerText } from './dayPanel.js';

const QUARTER = 900_000;

/** `count` quarter-hours of a date, the net alternating out and in. */
function quarters(date, count, net = [230, -120]) {
  const start = midnightOf(date);
  return Array.from({ length: count }, (_, i) => ({
    at: start + i * QUARTER,
    nuclear: 7000,
    hydro: 15_000,
    total: 22_000,
    consumption: 21_000,
    net: net[i % net.length],
  }));
}

const day = (date, count, extra = {}) => ({
  date,
  points: quarters(date, count),
  stale: false,
  ...extra,
});

/** A promise settled from outside, as a slow answer is. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

/**
 * The day behind a fake source and panel. `answers.day` and `answers.week`
 * are queues: a value answers, an Error fails, a deferred answers later.
 */
function harness(answers = {}) {
  const calls = { day: [], week: [] };
  const next = (kind, signal) => {
    calls[kind].push(signal);
    const answer = answers[kind]?.shift();
    if (answer instanceof Error) return Promise.reject(answer);
    return answer?.promise ?? Promise.resolve(answer);
  };
  const source = {
    getDay: (date, { signal } = {}) => next('day', signal),
    getWeek: ({ signal } = {}) => next('week', signal),
  };
  const views = [];
  let actions = null;
  let disconnected = 0;
  const panel = {
    publish: (view) => views.push(view),
    connect: (given) => {
      actions = given;
      return () => (disconnected += 1);
    },
  };
  const power = createPowerDay({ source });
  return {
    power,
    panel,
    calls,
    views,
    view: () => views.at(-1),
    show: (id) => actions.show(id),
    disconnected: () => disconnected,
  };
}

/** An attached, active day whose first load has finished. */
async function loaded(answers) {
  const h = harness(answers);
  h.power.attach(h.panel);
  h.power.setActive(true);
  await settle();
  return h;
}

test('a label never rounds its value away', () => {
  assert.equal(powerText(25), '25 MW');
  assert.equal(powerText(250), '250 MW');
  assert.equal(powerText(999), '999 MW');
  assert.equal(powerText(1000), '1 GW');
  assert.equal(powerText(1250), '1.25 GW');
  assert.equal(powerText(3000), '3 GW');
  assert.equal(powerText(12_500), '12.5 GW');
  assert.equal(powerText(0), '0 MW');
  setLocale('sv');
  try {
    assert.equal(powerText(250), '250 MW');
    assert.equal(powerText(1250), '1,25 GW');
    assert.equal(powerText(12_500), '12,5 GW');
  } finally {
    setLocale('en');
  }
});

test('a load shows Loading until the day arrives, then the chart', async () => {
  const h = harness({ day: [day('2026-11-10', 45)] });
  h.power.attach(h.panel);
  assert.equal(h.view(), null, 'nothing while the layer is off');
  h.power.setActive(true);
  assert.equal(h.view().loading, true);
  assert.equal(h.view().chart, null);
  assert.equal(h.view().failed, false);
  assert.equal(h.view().empty, '', 'not empty before an answer');
  await settle();

  const view = h.view();
  assert.equal(view.loading, false);
  assert.equal(view.failed, false);
  assert.equal(view.stale, false);
  assert.equal(view.empty, '');
  assert.equal(view.status, '');
  assert.equal(view.chart.points.length, 45);
  assert.equal(view.chart.start, midnightOf('2026-11-10'));
  // The unit once beside the axis; the ticks are bare numbers that fit.
  assert.equal(view.yUnit, 'GW');
  assert.deepEqual(
    view.yLabels.map((label) => label.text),
    ['0', '12.5', '25'],
  );
  assert.equal(view.netLabel, '±250 MW');
  assert.deepEqual(
    view.xLabels.map((label) => label.text),
    ['00', '06', '12', '18', '00'],
  );
  assert.equal(
    view.summary,
    'So far today: produced 247.5 GWh, used 236.3 GWh',
  );
  assert.equal(view.exchange, 'Net export 1.3 GWh · net import 0.7 GWh');
  assert.equal(view.latest.time, '11:00');
});

test('a small system reads in megawatts on the axis', async () => {
  const points = quarters('2026-11-10', 8).map((point) => ({
    at: point.at,
    hydro: 230,
    total: 230,
    consumption: 180,
    net: 2300,
  }));
  const h = await loaded({ day: [{ date: '2026-11-10', points }] });
  assert.equal(h.view().yUnit, 'MW');
  assert.deepEqual(
    h.view().yLabels.map((label) => label.text),
    ['0', '125', '250'],
  );
  assert.equal(h.view().netLabel, '±2.5 GW');
});

test('the day chart follows the Swedish clock on a 25-hour day', async () => {
  const h = await loaded({ day: [day('2026-10-25', 100)] });
  const { chart } = h.view();
  assert.equal(chart.points.length, 100);
  assert.ok(chart.points.every((point) => point.x <= chart.plotRight));
  assert.deepEqual(
    h.view().xLabels.map((label) => label.text),
    ['00', '06', '12', '18', '00'],
  );
  assert.equal(h.view().latest.time, '23:45');
});

test('a finished load without quarter-hours is an empty day, not a load', async () => {
  const h = await loaded({
    day: [day('2026-11-10', 0), day('2026-11-10', 0), day('2026-11-10', 3)],
    week: [{ days: [day('2026-11-09', 0), day('2026-11-10', 0)] }],
  });
  assert.equal(h.view().loading, false);
  assert.equal(h.view().failed, false);
  assert.equal(h.view().chart, null);
  assert.equal(h.view().empty, 'No quarter-hours yet today');
  assert.equal(h.view().status, '');

  // The next refresh keeps saying so while it is on its way.
  h.power.refresh();
  assert.equal(h.view().loading, true);
  assert.equal(h.view().empty, 'No quarter-hours yet today');
  await settle();
  assert.equal(h.view().empty, 'No quarter-hours yet today');

  h.show('week');
  await settle();
  assert.equal(h.view().chart, null);
  assert.equal(h.view().empty, 'No quarter-hours kept yet');

  h.show('today');
  await settle();
  assert.equal(h.view().empty, '');
  assert.equal(h.view().chart.points.length, 3);
});

test('a failed first load is unavailable; the next good one clears it', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const h = await loaded({
    day: [new Error('Power day unavailable (HTTP 502)'), day('2026-11-10', 4)],
  });
  assert.equal(warn.mock.callCount(), 1);
  assert.equal(h.view().failed, true);
  assert.equal(h.view().loading, false);
  assert.equal(h.view().chart, null);
  assert.equal(h.view().empty, '');
  assert.equal(h.view().status, '', 'the note beside a chart needs a chart');

  h.power.refresh();
  assert.equal(h.view().loading, true);
  assert.equal(h.view().failed, true, 'still unavailable while it retries');
  await settle();
  assert.equal(h.view().failed, false);
  assert.equal(h.view().chart.points.length, 4);
  assert.equal(h.view().status, '');
});

test('a failed refresh is said beside the chart it could not replace', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const h = await loaded({
    day: [day('2026-11-10', 40), new Error('HTTP 502'), day('2026-11-10', 42)],
  });
  const before = h.view().chart;
  assert.equal(before.points.length, 40);

  h.power.refresh();
  await settle();
  assert.equal(h.view().failed, true);
  assert.equal(h.view().loading, false);
  assert.equal(h.view().chart.points.length, 40, 'the earlier chart stays');
  assert.equal(h.view().status, 'Update failed');
  assert.equal(h.view().empty, '');

  h.power.refresh();
  await settle();
  assert.equal(h.view().failed, false);
  assert.equal(h.view().status, '');
  assert.equal(h.view().chart.points.length, 42);
});

test('a stale answer is shown as older data with its last quarter-hour', async () => {
  const h = await loaded({
    day: [day('2026-11-10', 46, { stale: true }), day('2026-11-10', 50)],
    week: [
      {
        days: [day('2026-11-09', 96), day('2026-11-10', 46)],
        stale: true,
      },
    ],
  });
  assert.equal(h.view().stale, true);
  assert.equal(h.view().failed, false);
  assert.equal(h.view().chart.points.length, 46);
  assert.equal(h.view().status, 'Older data from 11:15');

  setLocale('sv');
  try {
    h.power.publish();
    assert.equal(h.view().status, 'Äldre data från 11:15');
    assert.equal(
      h.view().exchange,
      'Nettoexport 1,3 GWh · nettoimport 0,7 GWh',
    );
  } finally {
    setLocale('en');
  }

  h.show('week');
  await settle();
  assert.equal(h.view().stale, true);
  assert.equal(h.view().status, 'Older data from Tue 11:15');

  h.show('today');
  await settle();
  assert.equal(h.view().stale, false);
  assert.equal(h.view().status, '');
});

test('the span switch loads the week and drops the day meanwhile', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const week = deferred();
  const dates = [
    '2026-11-04',
    '2026-11-05',
    '2026-11-06',
    '2026-11-07',
    '2026-11-08',
    '2026-11-09',
    '2026-11-10',
  ];
  const h = await loaded({
    day: [day('2026-11-10', 40), new Error('HTTP 502')],
    week: [week],
  });
  h.power.refresh();
  await settle();
  assert.equal(h.view().failed, true);

  h.show('week');
  assert.equal(h.view().span, 'week');
  assert.equal(h.view().loading, true);
  assert.equal(h.view().chart, null, 'the day is not drawn as a week');
  assert.equal(h.view().failed, false, 'the day’s failure is not the week’s');
  h.show('week');
  assert.equal(
    h.calls.week.length,
    1,
    'the span already shown is not reloaded',
  );
  h.show('month');
  assert.equal(h.view().span, 'week');

  week.resolve({
    // A day the server did not keep, and today so far.
    days: dates.map((date, i) => day(date, i === 2 ? 0 : i === 6 ? 40 : 96)),
  });
  await settle();
  const view = h.view();
  assert.equal(view.loading, false);
  assert.equal(view.chart.days, 7);
  assert.equal(view.chart.start, midnightOf('2026-11-04'));
  assert.deepEqual(
    view.xLabels.map((label) => label.text),
    ['Wed', 'Thu', 'Fri', 'Sat', 'Sun', 'Mon', 'Tue'],
  );
  assert.equal(view.dayLines.length, 6);
  assert.ok(view.note.length > 0, 'the hole is explained');
  assert.ok(view.summary.startsWith('Last 7 days: '));
  assert.equal(view.latest.time, 'Tue 09:45');
});

test('a week across the clock change starts on its own midnight', async () => {
  const dates = [
    '2026-10-20',
    '2026-10-21',
    '2026-10-22',
    '2026-10-23',
    '2026-10-24',
    '2026-10-25',
    '2026-10-26',
  ];
  const h = await loaded({
    day: [day('2026-10-26', 4)],
    week: [
      {
        days: dates.map((date) => day(date, date === '2026-10-25' ? 100 : 96)),
      },
    ],
  });
  h.show('week');
  await settle();
  const { chart } = h.view();
  assert.equal(chart.start, Date.parse('2026-10-19T22:00:00Z'));
  assert.equal(chart.end, Date.parse('2026-10-26T23:00:00Z'));
  assert.equal(chart.points.length, 676);
  assert.ok(chart.points.every((point) => point.x <= chart.plotRight));
  assert.equal(h.view().note, '', '100 quarter-hours are a whole day');
});

test('an aborted load that finishes late does not replace a newer one', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const slow = deferred();
  const slower = deferred();
  const h = harness({
    day: [slow, day('2026-11-10', 44), slower, day('2026-11-10', 48)],
  });
  h.power.attach(h.panel);
  h.power.setActive(true);
  // A refresh while the first answer is still on its way.
  h.power.refresh();
  assert.equal(h.calls.day.length, 2);
  assert.equal(h.calls.day[0].aborted, true, 'the first request is let go');
  assert.equal(h.calls.day[1].aborted, false);
  await settle();
  assert.equal(h.view().chart.points.length, 44);
  assert.equal(h.view().loading, false);

  // The first answers after all, with fewer quarter-hours.
  const published = h.views.length;
  slow.resolve(day('2026-11-10', 30));
  await settle();
  assert.equal(h.view().chart.points.length, 44);
  assert.equal(h.views.length, published, 'and publishes nothing');

  // The same for one that fails late.
  h.power.refresh();
  h.power.refresh();
  await settle();
  assert.equal(h.view().chart.points.length, 48);
  slower.reject(new Error('late failure'));
  await settle();
  assert.equal(h.view().failed, false);
  assert.equal(h.view().status, '');
  assert.equal(h.view().chart.points.length, 48);
  assert.equal(warn.mock.callCount(), 0);
});

test('turning the layer off lets the request go and clears the panel', async () => {
  const slow = deferred();
  const h = harness({ day: [slow, day('2026-11-10', 12)] });
  h.power.attach(h.panel);
  h.power.setActive(true);
  h.power.setActive(false);
  assert.equal(h.calls.day[0].aborted, true);
  assert.equal(h.view(), null);
  slow.resolve(day('2026-11-10', 30));
  await settle();
  assert.equal(h.view(), null, 'a late answer does not bring it back');

  h.power.setActive(true);
  await settle();
  assert.equal(h.view().chart.points.length, 12);
  h.power.refresh();
  h.power.destroy();
  assert.equal(h.view(), null);
  assert.equal(h.disconnected(), 1);
  h.power.refresh();
  assert.equal(h.calls.day.length, 3, 'nothing is fetched after destroy');
});

test('without production on offer the panel hides and asks nothing', async () => {
  const h = await loaded({
    day: [
      {
        date: '2026-11-11',
        points: [],
        stale: false,
        productionOffered: false,
      },
    ],
  });
  assert.equal(h.view(), null);
  const asked = h.calls.day.length;
  h.power.refresh();
  await settle();
  assert.equal(h.calls.day.length, asked);
  // The layer says production is offered again: the panel loads and shows.
  h.power.setOffered(true);
  await settle();
  assert.equal(h.calls.day.length, asked + 1);
  assert.notEqual(h.view(), null);
});

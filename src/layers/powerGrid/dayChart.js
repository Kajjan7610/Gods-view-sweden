/**
 * The power day (or week) as a chart: Sweden's production stacked by type
 * with the consumption on top of it, and below it the exchange with the
 * neighbours, export up and import down, per quarter-hour on the Swedish
 * clock. A stretch without quarter-hours (a day the server did not keep)
 * stays a gap, and a day runs between two Swedish midnights: 23 or 25 hours
 * when the clocks change. Pure — SVG path strings and numbers for the panel
 * to draw, no Cesium, no DOM.
 */

/** Production types bottom to top, with their colours. */
export const DAY_TYPES = Object.freeze([
  Object.freeze({ id: 'nuclear', color: '#ce93d8' }),
  Object.freeze({ id: 'hydro', color: '#4fc3f7' }),
  Object.freeze({ id: 'wind', color: '#81c784' }),
  Object.freeze({ id: 'thermal', color: '#ef5350' }),
  Object.freeze({ id: 'unspecified', color: '#b0bec5' }),
]);
export const CONSUMPTION_COLOR = '#ffffff';
export const EXPORT_COLOR = '#ffab40';
export const IMPORT_COLOR = '#69f0ae';

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
const QUARTER_HOURS = 0.25;
/** Two quarter-hours apart or more is a gap in the curve. */
const GAP_MS = 30 * 60_000;
const PAD = Object.freeze({ left: 34, right: 6, top: 6, bottom: 4 });

const WALL_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** The Stockholm wall clock at `ms`, as the UTC time that reads the same. */
function wallClock(ms) {
  const part = {};
  for (const { type, value } of WALL_PARTS.formatToParts(ms))
    part[type] = Number(value);
  return Date.UTC(
    part.year,
    part.month - 1,
    part.day,
    part.hour,
    part.minute,
    part.second,
  );
}

/** The instant the Stockholm wall clock reads `wall` (see wallClock). */
function instantOf(wall) {
  // The offset around `wall`, then the one at the instant that gives: they
  // differ only when a clock change lies between the two.
  const near = wall - (wallClock(wall) - wall);
  return wall - (wallClock(near) - near);
}

/** Stockholm midnight before `ms`, also on a day the clocks change. */
export function midnightBefore(ms) {
  const wall = wallClock(ms);
  return instantOf(wall - (((wall % DAY_MS) + DAY_MS) % DAY_MS));
}

/** The Stockholm midnight that starts a date ("2026-10-25"), or null. */
export function midnightOf(date) {
  const wall = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(wall) ? instantOf(wall) : null;
}

/** Stockholm midnight before the first quarter-hour. */
export function dayStartOf(points) {
  const first = points[0]?.at;
  return Number.isFinite(first) ? midnightBefore(first) : null;
}

/** A round top for an axis: 4 000, 5 000, 10 000, 20 000 … */
function niceMax(value) {
  if (!(value > 0)) return 1000;
  const step = 10 ** Math.floor(Math.log10(value));
  for (const factor of [1, 2, 2.5, 4, 5, 10])
    if (value <= factor * step) return factor * step;
  return 10 * step;
}

const round = (value) => Math.round(value * 10) / 10;
const line = (xy) =>
  xy.length
    ? `M${xy.map(([x, y]) => `${round(x)},${round(y)}`).join('L')}`
    : '';

/** Runs of quarter-hours without a gap between them. */
function runs(points) {
  const out = [];
  for (const point of points) {
    const last = out.at(-1)?.at(-1);
    if (last && point.at - last.at < GAP_MS) out.at(-1).push(point);
    else out.push([point]);
  }
  return out;
}

/**
 * Energy over the quarter-hours, in MWh: production, consumption, and the
 * exchange split into what went out and what came in.
 */
export function dayTotals(points) {
  const totals = { production: 0, consumption: 0, exported: 0, imported: 0 };
  for (const point of points) {
    if (Number.isFinite(point.total))
      totals.production += point.total * QUARTER_HOURS;
    if (Number.isFinite(point.consumption))
      totals.consumption += point.consumption * QUARTER_HOURS;
    if (Number.isFinite(point.net)) {
      if (point.net > 0) totals.exported += point.net * QUARTER_HOURS;
      else totals.imported -= point.net * QUARTER_HOURS;
    }
  }
  for (const key of Object.keys(totals)) totals[key] = Math.round(totals[key]);
  return totals;
}

/**
 * The chart for quarter-hours over whole Stockholm days.
 * @param {Array<{at: number} & Record<string, number>>} points Oldest first.
 * @param {{start?: number, days?: number, width?: number, height?: number,
 *   netHeight?: number}} [options] `start` is the first Stockholm midnight
 *   (by default the one before the first point); `days` how many days the
 *   axis spans.
 */
export function buildDayChart(
  points,
  { start = null, days = 1, width = 300, height = 120, netHeight = 48 } = {},
) {
  const from = start ?? dayStartOf(points);
  if (from === null || !points.length) return null;
  // Each midnight of the span, read off the Swedish clock once a build.
  const wallStart = wallClock(from);
  const midnights = [from];
  for (let day = 1; day <= days; day += 1)
    midnights.push(instantOf(wallStart + day * DAY_MS));
  const span = midnights[days] - from;
  const plotWidth = width - PAD.left - PAD.right;
  const x = (at) => PAD.left + ((at - from) / span) * plotWidth;
  const stretches = runs(points);

  // Production stacked by type, consumption as a line over it.
  const top = Math.max(
    ...points.map((point) =>
      Math.max(
        point.consumption ?? 0,
        DAY_TYPES.reduce((sum, type) => sum + (point[type.id] ?? 0), 0),
        point.total ?? 0,
      ),
    ),
  );
  const yMax = niceMax(top * 1.05);
  const plotHeight = height - PAD.top - PAD.bottom;
  const y = (mw) => PAD.top + plotHeight * (1 - mw / yMax);
  const base = new Map(points.map((point) => [point, 0]));
  const areas = DAY_TYPES.map((type) => {
    if (!points.some((point) => (point[type.id] ?? 0) > 0)) return null;
    const lower = new Map(base);
    for (const point of points)
      base.set(point, base.get(point) + Math.max(0, point[type.id] ?? 0));
    const d = stretches
      .map((run) => {
        const upper = run.map((point) => [x(point.at), y(base.get(point))]);
        const below = run
          .map((point) => [x(point.at), y(lower.get(point))])
          .reverse();
        return `${line(upper)}L${line(below).slice(1)}Z`;
      })
      .join('');
    return { id: type.id, color: type.color, d };
  }).filter(Boolean);
  const consumption = stretches
    .map((run) =>
      line(
        run
          .filter((point) => Number.isFinite(point.consumption))
          .map((point) => [x(point.at), y(point.consumption)]),
      ),
    )
    .join('');

  // The exchange: export above the zero line, import below it.
  const withNet = points.filter((point) => Number.isFinite(point.net));
  const netMax = niceMax(
    Math.max(1, ...withNet.map((point) => Math.abs(point.net))) * 1.05,
  );
  const netMid = netHeight / 2;
  const netY = (mw) => netMid - (mw / netMax) * (netHeight / 2 - 2);
  const band = (sign) =>
    runs(withNet)
      .map((run) => {
        const edge = run.map((point) => [
          x(point.at),
          netY(sign * Math.max(0, sign * point.net)),
        ]);
        const first = round(edge[0][0]);
        const last = round(edge.at(-1)[0]);
        return `M${first},${netMid}L${line(edge).slice(1)}L${last},${netMid}Z`;
      })
      .join('');

  // One tick every sixth hour of the Swedish clock, or one a midnight over
  // several days.
  const xTicks =
    days === 1
      ? [0, 6, 12, 18, 24].map((hour) => {
          const at =
            hour === 24 ? midnights[1] : instantOf(wallStart + hour * HOUR_MS);
          return { at, x: round(x(at)), hour: hour % 24 };
        })
      : midnights.map((at) => ({ at, x: round(x(at)), hour: 0 }));

  return {
    width,
    height,
    netHeight,
    days,
    start: from,
    end: midnights[days],
    plotLeft: PAD.left,
    plotRight: width - PAD.right,
    areas,
    consumption,
    yTicks: [0, yMax / 2, yMax].map((mw) => ({ mw, y: round(y(mw)) })),
    xTicks,
    net: {
      zeroY: netMid,
      max: netMax,
      exported: band(1),
      imported: band(-1),
    },
    points: points.map((point) => ({ ...point, x: round(x(point.at)) })),
    totals: dayTotals(points),
  };
}

/** The quarter-hour nearest an x position of the chart, or null. */
export function pointAt(chart, chartX) {
  if (!chart?.points?.length) return null;
  let best = chart.points[0];
  for (const point of chart.points)
    if (Math.abs(point.x - chartX) < Math.abs(best.x - chartX)) best = point;
  return best;
}

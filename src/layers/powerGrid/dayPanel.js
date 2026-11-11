/**
 * The power day on the right rail while the power grid layer is on: today's
 * quarter-hours of Sweden's production by type, consumption and exchange, or
 * the last seven days. Svenska kraftnät's control room serves the current day
 * only, so the week is the days the server kept (gaps where it did not run).
 * Fetches through the layer's source and publishes a view the panel draws;
 * the panel answers with `show`. No Cesium.
 */
import { formatNumber, getLocale, t } from '../../i18n/index.js';
import { ENTSOE_CREDIT, formatClock, formatMw, netText } from './cards.js';
import {
  CONSUMPTION_COLOR,
  DAY_TYPES,
  EXPORT_COLOR,
  IMPORT_COLOR,
  buildDayChart,
  midnightOf,
} from './dayChart.js';

const WEEK_DAYS = 7;
/** A kept day with fewer quarter-hours than this has a hole in it. */
const WHOLE_DAY = 92;
const TYPE_LABEL = Object.freeze({
  nuclear: () => t('nuclear'),
  hydro: () => t('hydro'),
  wind: () => t('wind'),
  thermal: () => t('thermal'),
  unspecified: () => t('other'),
});

const gwh = (mwh) =>
  formatNumber(mwh / 1000, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });
const mwText = (mw) => t('{mw} MW', { mw: formatMw(mw) });

/**
 * "250 MW" below a gigawatt, from there "1,25 GW": as many decimals as the
 * value needs (two at most), so a label never rounds its value away.
 */
export function powerText(mw) {
  if (Math.abs(mw) < 1000) return mwText(mw);
  return t('{gw} GW', {
    gw: formatNumber(mw / 1000, { maximumFractionDigits: 2 }),
  });
}

/**
 * The y axis in one unit, named once beside the chart: "12,5" under "GW"
 * fits left of the plot in every language, "12,5 GW" does not.
 */
function yAxis(chart) {
  const inGw = chart.yTicks.at(-1).mw >= 1000;
  // The unit alone, from the message that carries it in each language.
  const unit = inGw ? t('{gw} GW', { gw: '' }) : t('{mw} MW', { mw: '' });
  return {
    unit: unit.trim(),
    labels: chart.yTicks.map((tick) => ({
      y: tick.y,
      text: formatNumber(inGw ? tick.mw / 1000 : tick.mw, {
        maximumFractionDigits: inGw ? 2 : 1,
      }),
    })),
  };
}

/** "mån" or "Mon": a weekday in the reader's language, Swedish clock. */
function weekday(ms) {
  try {
    return new Intl.DateTimeFormat(getLocale(), {
      timeZone: 'Europe/Stockholm',
      weekday: 'short',
    }).format(ms);
  } catch {
    return '';
  }
}

/**
 * @param {{source: {getDay: Function, getWeek: Function}}} options
 */
export function createPowerDay({ source }) {
  let panel = null;
  let offConnect = null;
  let active = false;
  /** 'today' or 'week'. */
  let span = 'today';
  /** The fetched quarter-hours: {points, start, days, missing, stale}. */
  let data = null;
  /** The last load failed; what `data` holds is from the one before. */
  let failed = false;
  let request = null;
  /** Whether production may be shown at all (not from ENTSO-E without
   * Svenska kraftnät's consent); the panel hides when not. */
  let offered = true;

  /** "11:15", with its weekday over a week. */
  const clock = (at) =>
    span === 'week' ? `${weekday(at)} ${formatClock(at)}` : formatClock(at);

  /** One quarter-hour as the panel's readout lines. */
  function readout(point) {
    if (!point) return null;
    const lines = [];
    if (Number.isFinite(point.total))
      lines.push({ label: t('production'), value: mwText(point.total) });
    for (const type of DAY_TYPES)
      if ((point[type.id] ?? 0) > 0)
        lines.push({
          label: TYPE_LABEL[type.id](),
          value: mwText(point[type.id]),
          color: type.color,
        });
    if (Number.isFinite(point.consumption))
      lines.push({
        label: t('consumption'),
        value: mwText(point.consumption),
        color: CONSUMPTION_COLOR,
      });
    if (Number.isFinite(point.net))
      lines.push({
        label: t('exchange'),
        value: netText(point.net),
        color: point.net >= 0 ? EXPORT_COLOR : IMPORT_COLOR,
      });
    return { time: clock(point.at), lines };
  }

  /** Hours under a day, weekdays under a week (between their midnights). */
  function xLabels(chart) {
    if (chart.days === 1)
      return chart.xTicks.map((tick) => ({
        x: tick.x,
        text: String(tick.hour).padStart(2, '0'),
      }));
    return chart.xTicks.slice(0, -1).map((tick, i) => ({
      x: Math.round(((tick.x + chart.xTicks[i + 1].x) / 2) * 10) / 10,
      text: weekday(tick.at + 12 * 3_600_000),
    }));
  }

  function view() {
    if (!active || !offered) return null;
    const chart = data?.points.length
      ? buildDayChart(data.points, { start: data.start, days: data.days })
      : null;
    const totals = chart?.totals;
    const axis = chart ? yAxis(chart) : null;
    const shown = new Set(chart?.areas.map((area) => area.id));
    const values = totals && {
      production: gwh(totals.production),
      consumption: gwh(totals.consumption),
    };
    return {
      span,
      // In flight; "Loading…" is for when there is nothing else to show.
      loading: request !== null,
      failed,
      stale: Boolean(data?.stale),
      // A load that finished without quarter-hours: just after midnight.
      empty:
        !data || chart
          ? ''
          : span === 'week'
            ? t('No quarter-hours kept yet')
            : t('No quarter-hours yet today'),
      // What the reader should know about a chart that is not the latest.
      status: !chart
        ? ''
        : failed
          ? t('Update failed')
          : data.stale
            ? t('Older data from {time}', {
                time: clock(data.points.at(-1).at),
              })
            : '',
      spans: [
        { id: 'today', label: t('Today') },
        { id: 'week', label: t('Week') },
      ],
      chart,
      dayLines: chart && chart.days > 1 ? chart.xTicks.slice(1, -1) : [],
      xLabels: chart ? xLabels(chart) : [],
      colors: {
        consumption: CONSUMPTION_COLOR,
        export: EXPORT_COLOR,
        import: IMPORT_COLOR,
      },
      yLabels: axis?.labels ?? [],
      yUnit: axis?.unit ?? '',
      netLabel: chart ? `±${powerText(chart.net.max)}` : '',
      // Two literal keys, so the catalog check finds both.
      summary: !values
        ? ''
        : span === 'week'
          ? t(
              'Last 7 days: produced {production} GWh, used {consumption} GWh',
              values,
            )
          : t(
              'So far today: produced {production} GWh, used {consumption} GWh',
              values,
            ),
      // Net per quarter-hour, unlike the layer row's sum over the links.
      exchange: totals
        ? t('Net export {exported} GWh · net import {imported} GWh', {
            exported: gwh(totals.exported),
            imported: gwh(totals.imported),
          })
        : '',
      note:
        span === 'week' && data?.missing
          ? t(
              'Svenska kraftnät shows the current day only, so the week is the days this server kept; gaps are times it was not running.',
            )
          : '',
      legend: [
        ...DAY_TYPES.filter((type) => shown.has(type.id)).map((type) => ({
          id: type.id,
          color: type.color,
          label: TYPE_LABEL[type.id](),
        })),
        {
          id: 'consumption',
          color: CONSUMPTION_COLOR,
          label: t('consumption'),
        },
        { id: 'export', color: EXPORT_COLOR, label: t('export') },
        { id: 'import', color: IMPORT_COLOR, label: t('import') },
      ],
      // i18n-ignore: the source's name
      source: data?.fromEntsoe ? ENTSOE_CREDIT : 'Svenska kraftnät',
      latest: readout(chart?.points.at(-1)),
      readout,
    };
  }

  function publish() {
    panel?.publish(view());
  }

  async function fetchSpan(signal) {
    if (span === 'today') {
      const day = await source.getDay(null, { signal });
      return {
        points: day.points,
        // Midnight of the answer's date; of the first point without one.
        start: midnightOf(day.date),
        days: 1,
        missing: false,
        stale: day.stale === true,
        fromEntsoe: day.source === 'entsoe',
        productionOffered: day.productionOffered !== false,
      };
    }
    const week = await source.getWeek({ signal });
    const days = week.days.slice(-WEEK_DAYS);
    const first = days[0]?.date;
    return {
      points: days.flatMap((day) => day.points).sort((a, b) => a.at - b.at),
      start: first ? midnightOf(first) : null,
      days: days.length || WEEK_DAYS,
      missing: days.slice(0, -1).some((day) => day.points.length < WHOLE_DAY),
      stale: week.stale === true,
      fromEntsoe: week.source === 'entsoe',
      productionOffered: week.productionOffered !== false,
    };
  }

  async function load() {
    if (!active || !offered) return;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    publish();
    try {
      const next = await fetchSpan(controller.signal);
      if (controller.signal.aborted) return;
      data = next;
      failed = false;
      if (next.productionOffered === false) offered = false;
    } catch (error) {
      if (controller.signal.aborted) return;
      console.warn(
        '[Data:PowerGrid] Day unavailable:',
        error?.message || error,
      );
      failed = true;
    } finally {
      if (request === controller) {
        request = null;
        publish();
      }
    }
  }

  return {
    /** Connect the panel: `publish(view|null)`, `connect(actions)`. */
    attach(next) {
      offConnect?.();
      panel = next;
      offConnect =
        panel?.connect?.({
          show: (id) => {
            if ((id !== 'today' && id !== 'week') || id === span) return;
            span = id;
            data = null;
            failed = false;
            load();
          },
        }) ?? null;
      if (!panel) return;
      if (active) load();
      else publish();
    },
    /** The layer turned on or off. */
    setActive(on) {
      active = Boolean(on);
      if (active && panel) load();
      else {
        request?.abort();
        request = null;
        publish();
      }
    },
    /** A layer refresh: today's quarter-hours grow. */
    refresh() {
      if (active && panel) load();
    },
    /** Whether the answers offer production; the panel hides when not. */
    setOffered(on) {
      const next = on !== false;
      if (next === offered) return;
      offered = next;
      if (offered && active && panel) load();
      else publish();
    },
    /** The last load failed or came back old: the next poll asks again. */
    wantsRetry: () => failed || data?.stale === true,
    /** Re-word the view in the reader's language. */
    publish,
    destroy() {
      request?.abort();
      request = null;
      active = false;
      publish();
      offConnect?.();
      offConnect = null;
      panel = null;
    },
  };
}

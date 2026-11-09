/**
 * The power day on the right rail: today's quarter-hours of Sweden's
 * production by type, consumption and exchange, while the power grid layer is
 * on (Svenska kraftnät's control room serves the current day only). Fetches
 * through the layer's source and publishes a view the panel draws. No Cesium.
 */
import { formatNumber, t } from '../../i18n/index.js';
import { formatClock, formatMw, netText } from './cards.js';
import {
  CONSUMPTION_COLOR,
  DAY_TYPES,
  EXPORT_COLOR,
  IMPORT_COLOR,
  buildDayChart,
} from './dayChart.js';

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
const gw = (mw) =>
  mw === 0
    ? '0'
    : t('{gw} GW', {
        gw: formatNumber(mw / 1000, { maximumFractionDigits: 1 }),
      });
const mwText = (mw) => t('{mw} MW', { mw: formatMw(mw) });

/**
 * @param {{source: {getDay: Function}}} options
 */
export function createPowerDay({ source }) {
  let panel = null;
  let offConnect = null;
  let active = false;
  let day = null;
  let loading = false;
  let failed = false;
  let request = null;

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
    return { time: formatClock(point.at), lines };
  }

  function view() {
    if (!active) return null;
    const chart = day?.points?.length ? buildDayChart(day.points) : null;
    const totals = chart?.totals;
    const shown = new Set(chart?.areas.map((area) => area.id));
    return {
      loading,
      failed,
      chart,
      colors: {
        consumption: CONSUMPTION_COLOR,
        export: EXPORT_COLOR,
        import: IMPORT_COLOR,
      },
      yLabels: chart
        ? chart.yTicks.map((tick) => ({ y: tick.y, text: gw(tick.mw) }))
        : [],
      netLabel: chart ? `±${gw(chart.net.max)}` : '',
      summary: totals
        ? t('So far today: produced {production} GWh, used {consumption} GWh', {
            production: gwh(totals.production),
            consumption: gwh(totals.consumption),
          })
        : '',
      exchange: totals
        ? t('Out {exported} GWh · in {imported} GWh', {
            exported: gwh(totals.exported),
            imported: gwh(totals.imported),
          })
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
      source: 'Svenska kraftnät',
      latest: readout(chart?.points.at(-1)),
      readout,
    };
  }

  function publish() {
    panel?.publish(view());
  }

  async function load() {
    if (!active) return;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    loading = true;
    publish();
    try {
      const next = await source.getDay(null, { signal: controller.signal });
      if (controller.signal.aborted) return;
      day = next;
      failed = false;
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
        loading = false;
        publish();
      }
    }
  }

  return {
    /** Connect the panel: `publish(view|null)`, `connect(actions)`. */
    attach(next) {
      offConnect?.();
      panel = next;
      offConnect = panel?.connect?.({}) ?? null;
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
        loading = false;
        publish();
      }
    },
    /** A layer refresh: today's quarter-hours grow. */
    refresh() {
      if (active && panel) load();
    },
    /** Re-word the view in the reader's language. */
    publish,
    destroy() {
      request?.abort();
      active = false;
      publish();
      offConnect?.();
      offConnect = null;
      panel = null;
    },
  };
}

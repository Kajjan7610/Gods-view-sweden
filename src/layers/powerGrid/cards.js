/** Card model for a selected Swedish bidding zone. Pure — no Cesium types. */
import { formatNumber, getLocale, t } from '../../i18n/index.js';
import { flowColor } from './records.js';

export const POWER_GRID_OVERLAY_SOURCE_ID = 'power-grid';

// Swedish grid, Swedish clock.
const CLOCK = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  hour: '2-digit',
  minute: '2-digit',
});

/** "5 699" (whole megawatts, locale grouping). */
export function formatMw(value) {
  return formatNumber(value, { maximumFractionDigits: 0 });
}

/** "11:15" on the Swedish clock. */
export const formatClock = (ms) => CLOCK.format(ms);

const regionNames = new Map();
/** A country's name in the reader's language: "FI" is "Finland". */
export function countryName(code) {
  const locale = getLocale();
  if (!regionNames.has(locale))
    try {
      regionNames.set(
        locale,
        new Intl.DisplayNames([locale, 'en'], { type: 'region' }),
      );
    } catch {
      regionNames.set(locale, null);
    }
  try {
    return regionNames.get(locale)?.of(code) || code;
  } catch {
    return code;
  }
}

/**
 * A bidding zone as a reader knows it: Swedish zones by code, a country
 * with one zone by its name, a split country by name and zone.
 */
export function zoneName(zone) {
  const country = String(zone).slice(0, 2);
  if (country === 'SE') return zone;
  return zone.length > 2
    ? `${countryName(country)} ${zone}`
    : countryName(zone);
}

/** "export 1 284 MW", "import 483 MW" or "balanced": a net seen from Sweden. */
export function netText(net) {
  if (net > 0) return t('export {mw} MW', { mw: formatMw(net) });
  if (net < 0) return t('import {mw} MW', { mw: formatMw(-net) });
  return t('balanced');
}

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/**
 * Card for one Swedish zone: its flows in and out, then Sweden's production
 * and consumption.
 * @param {{id: string, name: string}} area
 * @param {{links: object[], areas: object[], production: object, updated: number|null}} snapshot
 */
export function buildAreaCard(area, snapshot) {
  const details = [];
  const totals = snapshot.areas?.find((one) => one.id === area.id);
  if (totals)
    details.push(
      t('Import {import} MW · export {export} MW', {
        import: formatMw(totals.import),
        export: formatMw(totals.export),
      }),
    );
  const flows = (snapshot.links || [])
    .filter((link) => link.from === area.id || link.to === area.id)
    .sort((a, b) => b.mw - a.mw)
    .map((link) =>
      link.to === area.id
        ? t('from {area} {mw}', { area: link.from, mw: formatMw(link.mw) })
        : t('to {area} {mw}', { area: link.to, mw: formatMw(link.mw) }),
    );
  if (flows.length) details.push(t('{mw} MW', { mw: flows.join(' · ') }));
  const production = snapshot.production || {};
  if (Number.isFinite(production.total))
    details.push(
      t('Sweden: production {production} MW, consumption {consumption} MW', {
        production: formatMw(production.total),
        consumption: Number.isFinite(production.consumption)
          ? formatMw(production.consumption)
          : '–',
      }),
    );
  const types = [
    ['nuclear', t('nuclear')],
    ['hydro', t('hydro')],
    ['wind', t('wind')],
    ['thermal', t('thermal')],
    ['unspecified', t('other')],
  ]
    .filter(([key]) => Number.isFinite(production[key]) && production[key] > 0)
    .map(([key, label]) => `${label} ${formatMw(production[key])}`);
  if (types.length) details.push(t('{mw} MW', { mw: types.join(' · ') }));
  const at = snapshot.updated ?? production.at;
  details.push(
    Number.isFinite(at)
      ? t('Svenska kraftnät · {time}', { time: CLOCK.format(at) })
      : 'Svenska kraftnät',
  );
  const net = totals ? totals.import - totals.export : 0;
  return {
    ...CARD_BASE,
    id: `power-grid-card:${area.id}`,
    interactive: false,
    title: t('POWER GRID · {zone} {name}', {
      zone: area.id,
      name: area.name.toUpperCase(),
    }),
    details,
    accent: flowColor(net > 0 ? 'import' : 'export'),
  };
}

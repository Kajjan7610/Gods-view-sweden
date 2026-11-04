/** Card model for a stop with disruptions. Pure — no Cesium types. */
import { t } from '../../i18n/index.js';
import { alertColor } from './records.js';

export const TRANSIT_ALERTS_OVERLAY_SOURCE_ID = 'transit-alerts';

const DATE = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const SHOWN_ALERTS = 3;
const DESCRIPTION_CHARS = 180;

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

function shorten(text, max) {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * Card for one stop area: its most serious alerts, each with its heading,
 * the start of its text and when it ends.
 * @param {object} row A placed stop row from the proxy.
 */
export function buildStopCard(row) {
  const details = [];
  for (const alert of row.alerts.slice(0, SHOWN_ALERTS)) {
    const end = Number.isFinite(alert.endsAt)
      ? t('until {date}', { date: DATE.format(alert.endsAt) })
      : t('until further notice');
    details.push(`${alert.header || t('Disruption')} (${end})`);
    // The heading often opens the text; show the rest only when it adds.
    if (alert.description && !alert.description.startsWith(alert.header))
      details.push(shorten(alert.description, DESCRIPTION_CHARS));
  }
  const more = row.alerts.length - SHOWN_ALERTS;
  if (more > 0) details.push(t('+{count} more', { count: more }));
  details.push(`${row.operatorName} · Trafiklab`);
  return {
    ...CARD_BASE,
    id: `transit-alerts-card:${row.id}`,
    interactive: false,
    title: t('DISRUPTION · {stop}', { stop: row.name.toUpperCase() }),
    details,
    accent: alertColor(row.kind),
  };
}

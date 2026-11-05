/** Card model for a stop with disruptions. Pure — no Cesium types. */
import { t } from '../../i18n/index.js';
import { foldText } from '../../ui/cardText.js';
import { alertColor } from './records.js';

export const TRANSIT_ALERTS_OVERLAY_SOURCE_ID = 'transit-alerts';

const DATE = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const SHOWN_ALERTS = 3;
const HEADER_LINES = 2;
const DESCRIPTION_LINES = 3;

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/**
 * Card for one stop area: its most serious alerts, each with its heading,
 * the start of its text and when it ends. Card lines never wrap, so the
 * operators' prose is folded into short lines.
 * @param {object} row A placed stop row from the proxy.
 */
export function buildStopCard(row) {
  const details = [];
  for (const alert of row.alerts.slice(0, SHOWN_ALERTS)) {
    const end = Number.isFinite(alert.endsAt)
      ? t('until {date}', { date: DATE.format(alert.endsAt) })
      : t('until further notice');
    details.push(
      ...foldText(`${alert.header || t('Disruption')} (${end})`, HEADER_LINES),
    );
    // The heading often opens the text; show the rest only when it adds.
    if (alert.description && !alert.description.startsWith(alert.header))
      details.push(...foldText(alert.description, DESCRIPTION_LINES));
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

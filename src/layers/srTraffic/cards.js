/** Card model for a selected SR traffic message. Pure — no Cesium types. */
import { msg, t } from '../../i18n/index.js';
import { foldText } from '../../ui/cardText.js';
import { priorityColor } from './records.js';

export const SR_TRAFFIC_OVERLAY_SOURCE_ID = 'sr-traffic';

export const PRIORITY_LABELS = Object.freeze({
  1: msg('Very serious'),
  2: msg('Major incident'),
  3: msg('Disruption'),
  4: msg('Information'),
  5: msg('Minor disruption'),
});

const CLOCK = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/** Card for one message; the texts are Swedish, as SR publishes them. */
export function buildSrCard(row) {
  const details = [];
  if (row.location) details.push(row.location);
  if (row.description) details.push(...foldText(row.description, 4));
  const stamp = [
    t(PRIORITY_LABELS[row.priority] || PRIORITY_LABELS[5]),
    Number.isFinite(row.created) ? CLOCK.format(row.created) : null,
  ].filter(Boolean);
  details.push(stamp.join(' · '));
  details.push(t('Sveriges Radio traffic report'));
  return {
    ...CARD_BASE,
    id: `sr-traffic-card:${row.id}`,
    interactive: false,
    title: [row.kind, row.title].filter(Boolean).join(' · ').toUpperCase(),
    details,
    accent: priorityColor(row.priority),
  };
}

/** Card models for a selected road stretch or incident. Pure — no Cesium types. */
import { t } from '../../i18n/index.js';
import { conditionColor, incidentColor } from './records.js';

export const ROAD_OVERLAY_SOURCE_ID = 'trafikverket-roads';

// Swedish data, Swedish clock: the times read as Trafikverket publishes them.
const CLOCK = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const when = (ms) => (Number.isFinite(ms) ? CLOCK.format(ms) : null);

function validity(row) {
  const from = when(row.start);
  const to = row.untilFurtherNotice ? t('until further notice') : when(row.end);
  if (from && to) return `${from} → ${to}`;
  if (from) return t('from {time}', { time: from });
  if (to) return t('until {time}', { time: to });
  return null;
}

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/** Card for one road-condition stretch. */
export function buildConditionCard(row) {
  const details = [];
  const where = [row.road, row.location].filter(Boolean).join(' · ');
  if (where) details.push(where);
  if (row.info.length) details.push(row.info.join(' · '));
  if (row.warnings.length)
    details.push(t('Warning: {text}', { text: row.warnings.join(', ') }));
  if (row.measures.length)
    details.push(t('Measures: {text}', { text: row.measures.join(', ') }));
  const valid = validity(row);
  if (valid) details.push(valid);
  details.push(t('Trafikverket road condition'));
  return {
    ...CARD_BASE,
    id: `trafikverket-road-card:c:${row.id}`,
    interactive: false,
    title: t('ROAD CONDITION · {condition}', {
      condition: (row.text || t('Unknown')).toUpperCase(),
    }),
    details,
    accent: conditionColor(row.code),
  };
}

/** Card for one incident; linked cards open Trafikverket's page on click. */
export function buildIncidentCard(row, { linkable = false } = {}) {
  // "Trafikmeddelande" says nothing; its code ("Vägen avstängd") is the news.
  const headline =
    /trafikmeddelande/i.test(row.type || '') && row.code
      ? row.code
      : row.type || t('Incident');
  const details = [];
  if (row.header && row.header !== row.code && row.header !== headline)
    details.push(row.header);
  else if (row.code && row.code !== headline) details.push(row.code);
  if (row.message) {
    const message = row.message.replace(/\s+/g, ' ');
    details.push(message.length > 220 ? `${message.slice(0, 219)}…` : message);
  }
  const where = [row.road, row.location].filter(Boolean).join(' · ');
  if (where) details.push(where);
  const impact = [row.severityText, row.restriction].filter(Boolean);
  if (impact.length) details.push(impact.join(' · '));
  const valid = validity(row);
  if (valid) details.push(valid);
  const link = linkable && row.link;
  if (link) details.push(t('Trafikverket ↗ · click card to open'));
  const title = `${headline.toUpperCase()}${
    row.road ? ` · ${row.road.toUpperCase()}` : ''
  }`;
  return {
    ...CARD_BASE,
    id: `trafikverket-road-card:i:${row.id}`,
    interactive: Boolean(link),
    ...(link
      ? { accessibilityLabel: t('Open {title} at Trafikverket', { title }) }
      : undefined),
    title,
    details,
    accent: incidentColor(row.kind),
  };
}

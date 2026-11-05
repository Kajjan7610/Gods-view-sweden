/** Card model for a selected Polisen notice. Pure — no Cesium types. */
import { t } from '../../i18n/index.js';
import { foldText } from '../../ui/cardText.js';
import { categoryColor } from './records.js';

export const POLICE_OVERLAY_SOURCE_ID = 'polisen-events';

// Swedish data, Swedish clock: the time reads as Polisen publishes it.
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

/**
 * Card for one notice; a linked card opens the notice on polisen.se.
 * @param {object} row A normalized notice.
 * @param {{linkable?: boolean}} [options]
 */
export function buildPoliceCard(row, { linkable = false } = {}) {
  const details = [];
  if (row.summary) details.push(...foldText(row.summary, 3));
  details.push(CLOCK.format(row.time));
  details.push(
    row.precision === 'municipality'
      ? t('Drawn near the centre of {place}; Polisen gives no exact place', {
          place: row.place,
        })
      : t('County-wide notice, drawn at the centre of {place}', {
          place: row.place || row.county || '',
        }),
  );
  const link = linkable && row.link;
  if (link) details.push(t('polisen.se ↗ · click card to open'));
  const title = `${row.type} · ${row.place || ''}`.toUpperCase();
  return {
    ...CARD_BASE,
    id: `polisen-card:${row.id}`,
    interactive: Boolean(link),
    ...(link
      ? { accessibilityLabel: t('Open {title} at polisen.se', { title }) }
      : undefined),
    title,
    details,
    accent: categoryColor(row.category),
  };
}

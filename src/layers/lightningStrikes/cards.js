/** Card model for a selected lightning stroke. Pure — no Cesium types. */
import { formatNumber, formatRelativeTime, t } from '../../i18n/index.js';
import { ageClass } from './records.js';

export const LIGHTNING_STRIKES_OVERLAY_SOURCE_ID = 'lightning-strikes';

const CLOCK = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/** The kind of stroke in the language. */
export function strikeKindLabel(kind) {
  switch (kind) {
    case 'ground-negative':
      return t('Cloud to ground, negative');
    case 'ground-positive':
      return t('Cloud to ground, positive');
    case 'cloud':
      return t('Cloud to cloud');
    default:
      return t('Type not stated');
  }
}

/** Card for one stroke, aged against `nowMs`. */
export function buildStrikeCard(row, nowMs = Date.now()) {
  const minutes = Math.max(0, Math.round((nowMs - row.at) / 60_000));
  const details = [
    `${CLOCK.format(row.at)} · ${formatRelativeTime(-minutes, 'minute')}`,
    strikeKindLabel(row.kind),
    ...(row.amp == null
      ? []
      : [
          t('{amp} kA peak current', {
            amp: formatNumber(Math.abs(row.amp), { maximumFractionDigits: 1 }),
          }),
        ]),
    ...(row.sensors
      ? [t('Located by {count} sensors', { count: row.sensors })]
      : []),
    // i18n-ignore: agency name
    `${t('Within about 0.5–2 km near Denmark, less precise farther away')} · DMI`,
  ];
  return {
    ...CARD_BASE,
    id: `lightning-strikes-card:${row.id}`,
    // Always hit-testable, so a click on the card is never the ground.
    interactive: true,
    title:
      row.kind === 'cloud' ? t('LIGHTNING · IN CLOUD') : t('LIGHTNING STRIKE'),
    details,
    accent: ageClass(nowMs - row.at)?.color ?? '#e53935',
  };
}

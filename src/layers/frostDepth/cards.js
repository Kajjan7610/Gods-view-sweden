/** Card model for a selected frost depth point. Pure — no Cesium types. */
import { t } from '../../i18n/index.js';
import { frostColor } from './records.js';

export const FROST_DEPTH_OVERLAY_SOURCE_ID = 'frost-depth';

const WHEN = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  day: 'numeric',
  month: 'numeric',
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

/** "−1.1" with a true minus sign. */
const degrees = (value) =>
  `${value < 0 ? '−' : ''}${Math.abs(value).toFixed(1)}`;

/** A point's frost as its label says it: "36 cm", "≥ 202 cm" or "0". */
export function frostLabel(row) {
  if (!row.frost) return '0';
  return `${row.frost.belowSensors ? '≥ ' : ''}${row.frost.bottom} cm`;
}

/** Sensors a card lists at most; a dense string shows every few. */
const PROFILE_ROWS = 10;

/** The profile in a line: "10 cm −1.1° · 35 cm −0.1° · …". */
export function profileLine(profile) {
  const step = Math.ceil(profile.length / PROFILE_ROWS);
  return profile
    .filter((_, index) => index % step === 0)
    .map((row) => `${row.depth} cm ${degrees(row.value)}°`)
    .join(' · ');
}

/** Card for one point. */
export function buildFrostDepthCard(row) {
  const frost = row.frost;
  const details = [
    frost
      ? frost.belowSensors
        ? t('Frozen to at least {depth} cm, the deepest sensor', {
            depth: frost.bottom,
          })
        : t('Frozen to {depth} cm', { depth: frost.bottom })
      : t('No frozen ground'),
    ...(frost && frost.top > 0
      ? [t('Thawed at the top, frozen from {depth} cm', { depth: frost.top })]
      : []),
    t('Ground temperature by depth:'),
    profileLine(row.profile),
    t('Measured {time}', { time: WHEN.format(row.sampledAt) }),
    // i18n-ignore: agency name
    `${t('Frost depth is read where the ground crosses 0 °C')} · Trafikverket`,
  ];
  return {
    ...CARD_BASE,
    id: `frost-depth-card:${row.id}`,
    interactive: true,
    title: t('FROST DEPTH · {name}', { name: row.name.toUpperCase() }),
    details,
    accent: frostColor(row.depth),
  };
}

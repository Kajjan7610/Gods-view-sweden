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
  // A string starting deep: the frozen span it measures, not a depth.
  if (row.frost.top === null)
    return `${row.profile[0].depth}–${row.frost.bottom} cm`;
  return `${row.frost.belowSensors ? '≥ ' : ''}${row.frost.bottom} cm`;
}

/** A card line longer than this wraps, so the card stays narrow on a phone. */
const LINE_MAX = 38;

/** Items joined into lines no longer than `max`, broken between items. */
export function joinLines(items, separator = ', ', max = LINE_MAX) {
  const lines = [];
  for (const item of items) {
    const last = lines.at(-1);
    if (
      last !== undefined &&
      last.length + separator.length + item.length <= max
    )
      lines[lines.length - 1] = `${last}${separator}${item}`;
    else lines.push(item);
  }
  return lines;
}

/** A long line as several, broken between words. */
export function wrapLine(line, max = LINE_MAX) {
  const lines = [];
  let current = '';
  for (const word of String(line).split(' ')) {
    if (current && current.length + 1 + word.length > max) {
      lines.push(current);
      current = word;
    } else current = current ? `${current} ${word}` : word;
  }
  if (current) lines.push(current);
  return lines;
}

/** Sensors a card lists at most; a dense string shows every few. */
const PROFILE_ROWS = 10;

/** Sensors per card line. */
const PER_LINE = 2;

/** The profile as lines: "10 cm −1.1° · 35 cm −0.1° · 60 cm 1.3°", … */
export function profileLines(profile) {
  const step = Math.ceil(profile.length / PROFILE_ROWS);
  const shown = profile
    .filter((_, index) => index % step === 0)
    .map((row) => `${row.depth} cm ${degrees(row.value)}°`);
  const lines = [];
  for (let i = 0; i < shown.length; i += PER_LINE)
    lines.push(shown.slice(i, i + PER_LINE).join(' · '));
  return lines;
}

/** Card for one point. */
export function buildFrostDepthCard(row) {
  const frost = row.frost;
  const details = [
    frost && frost.top === null
      ? t('Frozen at {from}–{to} cm; no sensors above {from} cm', {
          from: row.profile[0].depth,
          to: frost.bottom,
        })
      : frost
        ? frost.belowSensors
          ? t('Frozen to at least {depth} cm, the deepest sensor', {
              depth: frost.bottom,
            })
          : t('Frozen to {depth} cm', { depth: frost.bottom })
        : t('No frozen ground'),
    ...(frost && frost.top > 0
      ? [t('Thawed at the top, frozen from {depth} cm', { depth: frost.top })]
      : []),
    t(
      'In the ploughed road, from its surface: frost goes deeper here than in open ground',
    ),
    t('Temperature by depth:'),
    ...profileLines(row.profile),
    // Trafikverket's time for the whole batch, not each sensor's reading.
    t('Reported {time}', { time: WHEN.format(row.sampledAt) }),
    // i18n-ignore: agency name
    `${t('Frost depth is read where the temperature crosses 0 °C')} · Trafikverket`,
  ];
  return {
    ...CARD_BASE,
    id: `frost-depth-card:${row.id}`,
    interactive: true,
    title: t('FROST DEPTH · {name}', { name: row.name.toUpperCase() }),
    details: details.flatMap((line) => wrapLine(line)),
    accent: frostColor(row.depth),
  };
}

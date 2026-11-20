/** Card text for a trail or an outdoor facility. Pure — no Cesium types. */
import { formatNumber, msg, t } from '../../i18n/index.js';
import { wrapLine } from '../frostDepth/cards.js';
import { FACILITY_CLASS, TRAIL_CLASS } from './records.js';

export const OUTDOOR_TRAILS_OVERLAY_SOURCE_ID = 'outdoor-trails';

/** The facility classes in the reader's language. */
export const FACILITY_LABELS = Object.freeze({
  shelter: msg('Shelters and cabins'),
  fire: msg('Fireplaces, rest spots and campsites'),
  toilet: msg('Toilets, water and waste'),
  view: msg('Viewpoints and information'),
  access: msg('Parking, jetties and swimming'),
  structure: msg('Bridges, boardwalks and stiles'),
  other: msg('Other facilities'),
});

/** The trail classes in the reader's language. */
export const TRAIL_LABELS = Object.freeze({
  hike: msg('Hiking trails'),
  nature: msg('Nature and culture trails'),
  ski: msg('Ski trails'),
  snowmobile: msg('Snowmobile trails'),
  paddle: msg('Canoe trails'),
  cycleRide: msg('Cycling and riding trails'),
  other: msg('Other trails'),
});

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/** "Vindskydd · Vindskydd med eldstad", without saying a thing twice. */
const typeLine = (...parts) =>
  [...new Set(parts.filter(Boolean))].join(' · ') || null;

/** What a facility is called: its name, else its type. */
export const facilityName = (row) =>
  row.name || row.subtype || row.type || t('Outdoor facility');
/** What a trail is called: its name, else its type. */
export const trailName = (row) => row.name || row.type || t('Trail');

/** The lines every card ends with: the rules and the source. */
const footer = () => [
  t('Reserve rules and access bans apply'),
  t('Source: Naturvårdsverket'),
];

/** Card for one facility. */
export function buildFacilityCard(row) {
  const details = [
    typeLine(row.type, row.subtype),
    ...(row.accessible ? [t('Adapted for reduced mobility')] : []),
    ...(row.area ? [t('Protected area: {name}', { name: row.area })] : []),
    ...(row.stateTrail ? [t('On a state mountain trail')] : []),
    // Naturvårdsverket's own description, as it is written (in Swedish).
    row.description,
    ...footer(),
  ].filter(Boolean);
  return {
    ...CARD_BASE,
    id: `outdoor-trails-card:f:${row.id}`,
    interactive: true,
    title: t('FACILITY · {name}', {
      name: facilityName(row).toUpperCase(),
    }),
    details: details.flatMap((line) => wrapLine(line)),
    accent: FACILITY_CLASS[row.kind]?.color ?? FACILITY_CLASS.other.color,
  };
}

/** Card for one trail. */
export function buildTrailCard(row) {
  const details = [
    typeLine(row.type, row.category),
    ...(Number.isFinite(row.lengthKm) && row.lengthKm > 0
      ? [
          t('Length {length} km', {
            length: formatNumber(row.lengthKm, { maximumFractionDigits: 1 }),
          }),
        ]
      : []),
    ...(row.marking ? [t('Marking: {marking}', { marking: row.marking })] : []),
    ...(row.area ? [t('Protected area: {name}', { name: row.area })] : []),
    ...(row.stateTrail ? [t('State mountain trail')] : []),
    row.description,
    ...footer(),
  ].filter(Boolean);
  return {
    ...CARD_BASE,
    id: `outdoor-trails-card:t:${row.id}`,
    interactive: true,
    title: t('TRAIL · {name}', { name: trailName(row).toUpperCase() }),
    details: details.flatMap((line) => wrapLine(line)),
    accent: TRAIL_CLASS[row.kind]?.color ?? TRAIL_CLASS.other.color,
  };
}

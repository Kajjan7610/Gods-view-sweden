/** Card model for a selected rest area. Pure — no Cesium types. */
import { msg, t } from '../../i18n/index.js';
import { statusColor } from './records.js';
import { joinLines, wrapLine } from '../frostDepth/cards.js';

export const REST_AREAS_OVERLAY_SOURCE_ID = 'rest-areas';

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/** Each piece of equipment as the card names it. */
const EQUIPMENT_LABELS = Object.freeze({
  toilet: msg('toilet'),
  picnicFacilities: msg('picnic tables'),
  playground: msg('play area'),
  dumpingStation: msg('emptying point for portable toilets'),
  refuseBin: msg('waste bins'),
});

/** "8 car spaces · 4 lorry spaces". */
export function spacesLine(spaces) {
  return [
    spaces.car ? t('{count} car spaces', { count: spaces.car }) : null,
    spaces.lorry ? t('{count} lorry spaces', { count: spaces.lorry }) : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Card for one rest area. */
export function buildRestAreaCard(area) {
  const equipment = area.equipment.map((kind) =>
    kind === 'toilet' && area.accessibleToilet
      ? t('toilet (accessible)')
      : t(EQUIPMENT_LABELS[kind]),
  );
  const details = [
    ...(area.status === 'closed' ? [t('Closed')] : []),
    ...(area.status === 'limited' ? [t('Partly closed')] : []),
    ...(spacesLine(area.spaces) ? [spacesLine(area.spaces)] : []),
    ...joinLines(equipment),
    ...(area.free ? [t('Free of charge')] : []),
    // Trafikverket's own note, as it writes it (in Swedish); it may tell of
    // a toilet closed for now.
    ...(area.note
      ? [t('Note from Trafikverket: {note}', { note: area.note })]
      : []),
    // i18n-ignore: agency name
    `${t('Spaces in all, not free spaces now')} · Trafikverket`,
  ];
  return {
    ...CARD_BASE,
    id: `rest-areas-card:${area.id}`,
    interactive: true,
    title: t('REST AREA · {name}', { name: area.name.toUpperCase() }),
    details: details.flatMap((line) => wrapLine(line)),
    accent: statusColor(area.status),
  };
}

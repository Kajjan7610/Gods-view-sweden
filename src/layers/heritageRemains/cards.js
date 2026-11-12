/** Card text for a remain. Pure — no Cesium types. */
import { msg, t } from '../../i18n/index.js';
import { formatShelterDistance } from '../shelters/cards.js';
import { ASSESSMENT } from './records.js';

export const HERITAGE_REMAINS_OVERLAY_SOURCE_ID = 'heritage-remains';

/** The assessments in the reader's language. */
export const ASSESSMENT_LABELS = Object.freeze({
  fl: msg('Ancient monument (protected)'),
  mfl: msg('Possible ancient monument'),
  okl: msg('Other cultural-historical remain'),
  none: msg('No antiquarian assessment'),
  ej: msg('Not a cultural-historical remain'),
});

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/**
 * Card for one remain; a linked card opens it at RAÄ.
 * @param {object} row A normalized remain.
 * @param {{linkable?: boolean}} [options]
 */
export function buildRemainCard(row, { linkable = false } = {}) {
  const kind = row.name || row.type || t('Remain');
  const details = [
    ...(row.name && row.type ? [row.type] : []),
    t(ASSESSMENT_LABELS[row.assessment] ?? ASSESSMENT_LABELS.none),
    [row.number, row.raa].filter(Boolean).join(' · '),
    row.municipality,
    ...(row.confirmed ? [] : [t('Not confirmed in the field')]),
    ...(Number.isFinite(row.distance)
      ? [
          t('{distance} from the map centre', {
            distance: formatShelterDistance(row.distance),
          }),
        ]
      : []),
    ...(linkable ? [t('RAÄ ↗ · click card to open')] : []),
    t('Source: Riksantikvarieämbetet'),
  ].filter(Boolean);
  return {
    ...CARD_BASE,
    id: `heritage-remains-card:${row.id}`,
    interactive: true,
    ...(linkable
      ? {
          accessibilityLabel: t('Open {name} at Riksantikvarieämbetet', {
            name: kind,
          }),
        }
      : {}),
    title: t('REMAIN · {name}', { name: kind }),
    details,
    accent: ASSESSMENT[row.assessment]?.color ?? ASSESSMENT.none.color,
  };
}

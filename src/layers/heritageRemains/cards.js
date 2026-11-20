/** Card text for a remain, a World Heritage site and a protected building. Pure — no Cesium types. */
import { getLocale, msg, t } from '../../i18n/index.js';
import { formatShelterDistance } from '../shelters/cards.js';
import { ASSESSMENT, PROTECTED_TYPE, WORLD_HERITAGE_COLOR } from './records.js';

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
/** What a remain is called: its name, else its type. */
export const remainName = (row) => row.name || row.type || t('Remain');

export function buildRemainCard(row, { linkable = false } = {}) {
  const kind = remainName(row);
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

/** The protections in the reader's language. */
export const PROTECTION_LABELS = Object.freeze({
  bm: msg('Listed building'),
  sbm: msg('State listed building'),
  kk: msg('Protected church heritage'),
});

/** What a protected building or area is called: its name, else its protection. */
export const buildingName = (row) =>
  row.name || t(PROTECTION_LABELS[row.protection] ?? PROTECTION_LABELS.bm);

/** A site's name in the reader's language: Swedish for Swedish, else English. */
export const worldSiteName = (site) =>
  (getLocale() === 'sv' ? site.nameSv : site.nameEn) ||
  site.nameSv ||
  site.nameEn;

/**
 * Card for one World Heritage site; a linked card opens it at UNESCO.
 * @param {object} site A normalized site (records.js).
 * @param {{linkable?: boolean}} [options]
 */
export function buildWorldSiteCard(site, { linkable = false } = {}) {
  const name = worldSiteName(site);
  const other = getLocale() === 'sv' ? site.nameEn : site.nameSv;
  const details = [
    ...(other && other !== name ? [other] : []),
    ...(Number.isFinite(site.inscribed)
      ? [t('Inscribed {year}', { year: String(site.inscribed) })]
      : []),
    ...(site.schematic
      ? [t('The outline is schematic: the arc is a chain of survey points')]
      : []),
    ...(linkable ? [t('UNESCO ↗ · click card to open')] : []),
    t('Source: Riksantikvarieämbetet'),
  ];
  return {
    ...CARD_BASE,
    id: `heritage-world-card:${site.id}`,
    interactive: true,
    ...(linkable
      ? { accessibilityLabel: t('Open {name} at UNESCO', { name }) }
      : {}),
    title: t('WORLD HERITAGE · {name}', { name }),
    details,
    accent: WORLD_HERITAGE_COLOR,
  };
}

/** "Built 1750" or "Built 1750–1780", or null. */
function builtText(built) {
  if (!built) return null;
  return built.from === built.to
    ? t('Built {year}', { year: String(built.from) })
    : t('Built {from}–{to}', {
        from: String(built.from),
        to: String(built.to),
      });
}

/**
 * Card for a protected building or the protection area of a listed
 * building; a linked card opens it in Bebyggelseregistret. Only what the
 * register says of the protection is shown, never anything of an owner.
 * @param {object} row A normalized building or area (records.js).
 * @param {{linkable?: boolean, area?: boolean}} [options]
 */
export function buildBuildingCard(
  row,
  { linkable = false, area = false } = {},
) {
  const protection = t(
    PROTECTION_LABELS[row.protection] ?? PROTECTION_LABELS.bm,
  );
  const name = row.name || protection;
  const details = [
    protection,
    ...(Number.isFinite(row.decided)
      ? [t('Protected since {year}', { year: String(row.decided) })]
      : []),
    builtText(row.built),
    row.purpose,
    row.municipality,
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
    id: `heritage-${area ? 'area' : 'building'}-card:${row.id}`,
    interactive: true,
    ...(linkable
      ? {
          accessibilityLabel: t('Open {name} at Riksantikvarieämbetet', {
            name,
          }),
        }
      : {}),
    title: area
      ? t('PROTECTION AREA · {name}', { name })
      : t('PROTECTED BUILDING · {name}', { name }),
    details,
    accent: PROTECTED_TYPE[row.protection]?.color ?? PROTECTED_TYPE.bm.color,
  };
}

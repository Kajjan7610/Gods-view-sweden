// Marks text for i18n extraction; the UI translates it with t(). Kept local
// so the model stays pure (no DOM, no Cesium, no network) for its tests.
const msg = (text) => text;

/**
 * Pure model of the historical aerial photos layer ("Då och nu"):
 * Lantmäteriet's historical orthophotos as the app's own proxy serves them
 * (`/api/historiska-ortofoton/tile/{layerId}/…`). The years and variants are
 * the proxy's allow-list; nothing here is read from Lantmäteriet.
 *
 * 1960 and 1975 are reference years: one black-and-white mosaic each, put
 * together from flights of several years (how much of Sweden it covers is
 * what Lantmäteriet flew; this model claims no more). Their overlays (`meta-YEAR`, the
 * sheets with the year each was mostly flown, and `seams-YEAR`, the seams
 * between the photos) say which. 1993–2005 are one year each and cover only
 * the parts of Sweden flown that year.
 */

export const HISTORICAL_ORTHO_LAYER_ID = 'historical-ortho';

/** Sweden's box, as the fork's other Swedish layers draw it. */
export const SWEDEN_RECTANGLE = Object.freeze({
  west: 10,
  south: 55,
  east: 24.5,
  north: 69.2,
});

/**
 * Coarsest tile level asked for, and hidden below it: Sweden at level 9 is
 * a few hundred tiles, and nothing coarser is ever fetched.
 */
export const HISTORICAL_ORTHO_MIN_LEVEL = 9;
/** The finest level for 0.5 m photos (about 0.6 m a pixel at 60° N). */
const FINE_MAX_LEVEL = 16;
/** The finest level for 1 m photos. */
const COARSE_MAX_LEVEL = 15;
/** The overlays are lines and labels: one level less than the photos. */
const OVERLAY_MAX_LEVEL = 15;
/**
 * Above this camera height the layer asks for no tiles at all and the row
 * says to zoom in: a view from higher up spans most of a county, where a
 * 0.5 m photo reads as a grey blur.
 */
export const HISTORICAL_ORTHO_MAX_HEIGHT_M = 120_000;
/**
 * On Google's 3D tiles (only when the Esri map cannot be had) the photos
 * show only from much lower and looking down: the tiles are not hidden by
 * level there, and a tilted view would reach far out over the country.
 */
export const HISTORICAL_ORTHO_TILESET_MAX_HEIGHT_M = 25_000;
/** The shallowest camera pitch (radians, −35°) the tileset drape allows. */
export const HISTORICAL_ORTHO_TILESET_MAX_PITCH = (-35 * Math.PI) / 180;

const REFERENCE_YEARS = Object.freeze([1960, 1975]);
const SINGLE_YEARS = Object.freeze(
  Array.from({ length: 13 }, (_, index) => 1993 + index),
);
const COLOUR_YEARS = new Set([2002, 2003, 2004, 2005]);
const IR_YEARS = new Set([2003, 2004, 2005]);

/** Photo variants, in chip order; `bw` is every year's. */
export const HISTORICAL_ORTHO_VARIANTS = Object.freeze(['bw', 'color', 'ir']);

/** A variant's words, for the info line and the analyst. */
export const VARIANT_WORDS = Object.freeze({
  bw: msg('black and white'),
  color: msg('colour'),
  ir: msg('infrared'),
});

const photo = (layerId, resolutionM) =>
  Object.freeze({
    layerId,
    resolutionM,
    maxLevel: resolutionM <= 0.5 ? FINE_MAX_LEVEL : COARSE_MAX_LEVEL,
  });

function yearEntry(year) {
  const reference = REFERENCE_YEARS.includes(year);
  const variants = {
    bw: reference ? photo(String(year), 0.5) : photo(`bw-${year}`, 1),
  };
  if (COLOUR_YEARS.has(year)) variants.color = photo(`color-${year}`, 0.5);
  if (IR_YEARS.has(year)) variants.ir = photo(`ir-${year}`, 0.5);
  return Object.freeze({
    year,
    reference,
    // A reference year is a mosaic of several years' flights; a single
    // year covers only what was flown that year. Where there is no photo,
    // today's map shows through.
    coverage: reference ? 'mosaic' : 'partial',
    variants: Object.freeze(variants),
    // Sheets and flight years, and the seams between the photos.
    overlays: reference
      ? Object.freeze([
          Object.freeze({
            layerId: `seams-${year}`,
            role: 'seams',
            maxLevel: OVERLAY_MAX_LEVEL,
          }),
          Object.freeze({
            layerId: `meta-${year}`,
            role: 'meta',
            maxLevel: OVERLAY_MAX_LEVEL,
          }),
        ])
      : Object.freeze([]),
  });
}

/** Every year the proxy serves, oldest first. */
export const HISTORICAL_ORTHO_CATALOGUE = Object.freeze(
  [...REFERENCE_YEARS, ...SINGLE_YEARS].map(yearEntry),
);

export const HISTORICAL_ORTHO_YEARS = Object.freeze(
  HISTORICAL_ORTHO_CATALOGUE.map((entry) => entry.year),
);

/** Every tile layer id the layer can ask the proxy for. */
export const HISTORICAL_ORTHO_TILE_LAYER_IDS = Object.freeze(
  HISTORICAL_ORTHO_CATALOGUE.flatMap((entry) => [
    ...Object.values(entry.variants).map((variant) => variant.layerId),
    ...entry.overlays.map((overlay) => overlay.layerId),
  ]),
);

export const DEFAULT_SELECTION = Object.freeze({
  year: 1960,
  variant: 'bw',
  flightYears: false,
});

/** A year's entry, or null when the proxy does not serve it. */
export function catalogueYear(year) {
  return (
    HISTORICAL_ORTHO_CATALOGUE.find((entry) => entry.year === Number(year)) ??
    null
  );
}

/**
 * Whether a view touches Sweden's box: its view rectangle (degrees) when
 * the camera has one, else the point under the camera.
 * @param {{west: number, south: number, east: number, north: number} | null} rect
 * @param {{lon?: number, lat?: number} | null} [point]
 */
export function viewTouchesSweden(rect, point = null) {
  const box = SWEDEN_RECTANGLE;
  if (
    rect &&
    [rect.west, rect.south, rect.east, rect.north].every(Number.isFinite)
  )
    return (
      rect.west <= box.east &&
      rect.east >= box.west &&
      rect.south <= box.north &&
      rect.north >= box.south
    );
  const lon = point?.lon;
  const lat = point?.lat;
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return true;
  return (
    lon >= box.west && lon <= box.east && lat >= box.south && lat <= box.north
  );
}

/** Whether a year has photos in a variant. */
export function hasVariant(year, variant) {
  return Boolean(catalogueYear(year)?.variants[variant]);
}

/** Whether a year has the flight-year sheets and seams. */
export function hasFlightYears(year) {
  return (catalogueYear(year)?.overlays.length ?? 0) > 0;
}

/**
 * A selection the proxy can serve: an unknown year is the default year, a
 * variant the year lacks is black and white. The flight-years wish is kept
 * as asked (it applies only where the year has the overlays), so a step to
 * a single year and back keeps it.
 * @param {{year?: number, variant?: string, flightYears?: boolean}} [wanted]
 * @param {{year: number, variant: string, flightYears: boolean}} [current]
 */
export function normalizeSelection(wanted = {}, current = DEFAULT_SELECTION) {
  const yearAsked = wanted.year == null ? current.year : Number(wanted.year);
  const year = catalogueYear(yearAsked) ? yearAsked : DEFAULT_SELECTION.year;
  const variantAsked = wanted.variant ?? current.variant;
  const variant = hasVariant(year, variantAsked) ? variantAsked : 'bw';
  // Only a real boolean changes the wish.
  const flightYears =
    typeof wanted.flightYears === 'boolean'
      ? wanted.flightYears
      : Boolean(current.flightYears);
  return Object.freeze({ year, variant, flightYears });
}

/** The photo a selection shows: its tile layer, resolution and finest level. */
export function selectedPhoto(selection) {
  const entry = catalogueYear(selection?.year);
  return entry?.variants[selection.variant] ?? entry?.variants.bw ?? null;
}

/**
 * The tile layers a selection drapes, bottom to top: the photo, then for a
 * reference year with flight years on, the seams and the sheets.
 * @returns {{layerId: string, role: 'photo'|'seams'|'meta', maxLevel: number}[]}
 */
export function drapedLayers(selection) {
  const entry = catalogueYear(selection?.year);
  const shown = selectedPhoto(selection);
  if (!entry || !shown) return [];
  const layers = [
    { layerId: shown.layerId, role: 'photo', maxLevel: shown.maxLevel },
  ];
  if (selection.flightYears)
    for (const overlay of entry.overlays) layers.push({ ...overlay });
  return layers;
}

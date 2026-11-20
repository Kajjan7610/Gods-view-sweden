/**
 * Sweden's protected nature: the national parks, the nature reserves in
 * force and the culture reserves from Naturvårdsverket's Naturvårdsregistret
 * (open data, CC0; "Källa: Naturvårdsverket" asked for), with the Natura 2000
 * areas and the access bans in protected areas (most of them for bird and
 * seal protection) from the same register. Pure lookups shared by the snapshot build, the server route
 * and the layer. No Cesium, no Node built-ins.
 */

import {
  decodeLine,
  districtsInView,
  polygonsContain,
} from '../electionDistricts/records.js';

export { decodeLine, polygonsContain };

/** The kinds of area, as the layer draws them. */
export const AREA_KINDS = Object.freeze(
  [
    ['np', '#1b5e20'],
    ['nr', '#43a047'],
    ['kr', '#8d6e63'],
    ['n2k', '#1e88e5'],
    ['ban', '#f4511e'],
  ].map(([id, color]) => Object.freeze({ id, color })),
);
export const KIND = Object.freeze(
  Object.fromEntries(AREA_KINDS.map((kind) => [kind.id, kind])),
);
/** The kinds kept in files of their own, read only for a close view. */
export const EXTRA_KINDS = Object.freeze(['n2k', 'ban']);
/** Naturvårdsverket's page for an area in its map service Skyddad natur. */
export const skyddadNaturUrl = (nvrid) =>
  `https://skyddadnatur.naturvardsverket.se/sknat/?nvrid=${encodeURIComponent(nvrid)}`;

/**
 * The Skyddad natur page an area opens, or null: an access ban opens the
 * protected area it belongs to, a Natura 2000 area has no such page by id.
 * @param {{i: string, t: string, r?: string}} area
 * @returns {string|null}
 */
export function areaLink(area) {
  if (area?.t === 'n2k') return null;
  if (area?.t === 'ban') return area.r ? skyddadNaturUrl(area.r) : null;
  return area?.i ? skyddadNaturUrl(area.i) : null;
}

/** An access ban's reason, by the register's FORESKRIFTSSUBTYP. */
export const BAN_REASONS = Object.freeze({
  Fågel: 'bird',
  Säl: 'seal',
  'Fågel och säl': 'birdSeal',
  Övrigt: 'other',
});

/**
 * An access ban's period from the register's "day/month" dates, as
 * [fromDay, fromMonth, toDay, toMonth], or null when either is not a date.
 * @param {string} from E.g. "1/4".
 * @param {string} to E.g. "31/7".
 * @returns {number[]|null}
 */
export function banPeriod(from, to) {
  const parse = (text) => {
    const match = /^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/.exec(String(text ?? ''));
    if (!match) return null;
    const day = Number(match[1]);
    const month = Number(match[2]);
    // 2001 is no leap year: a ban never starts on 29 February.
    const last = new Date(Date.UTC(2001, month, 0)).getUTCDate();
    return month >= 1 && month <= 12 && day >= 1 && day <= last
      ? [day, month]
      : null;
  };
  const start = parse(from);
  const end = parse(to);
  return start && end ? [...start, ...end] : null;
}

/** Whether a ban period covers the whole year. */
export const allYear = (period) =>
  Array.isArray(period) && period.join('/') === '1/1/31/12';

/**
 * A Natura 2000 site's designation from the files it is in: the Birds
 * Directive's SPA file, the Habitats Directive's SCI file, or both.
 * @param {boolean} spa
 * @param {boolean} sci
 * @returns {'spa'|'sci'|'spa-sci'|null}
 */
export function naturaDesignation(spa, sci) {
  if (spa && sci) return 'spa-sci';
  return spa ? 'spa' : sci ? 'sci' : null;
}

/**
 * The year a site joined Natura 2000: the earliest of its "YYYYMM" dates
 * (classified as an SPA, proposed or approved as an SCI), or null.
 * @param {...string} dates
 * @returns {number|null}
 */
export function naturaYear(...dates) {
  const years = dates
    .map((date) => Number(String(date ?? '').slice(0, 4)))
    .filter((year) => year > 1900);
  return years.length ? Math.min(...years) : null;
}

/**
 * The areas whose box meets a view, nearest its centre first, at most
 * `limit`. A wide view gets the national parks alone; one not close (no
 * wider than `closeBelowDeg`) leaves out the Natura 2000 areas and bans.
 * @param {{t: string, b: number[]}[]} areas Snapshot areas.
 * @param {number[]} bbox [west, south, east, north].
 * @param {{limit: number, wideAboveDeg: number, closeBelowDeg?: number}} options
 * @returns {{areas: object[], wide: boolean, close: boolean}}
 */
export function areasInView(
  areas,
  bbox,
  { limit, wideAboveDeg, closeBelowDeg = Infinity },
) {
  const wide = isWideView(bbox, wideAboveDeg);
  const close = !wide && !isWideView(bbox, closeBelowDeg);
  const shown = wide
    ? areas.filter((area) => area.t === 'np')
    : close
      ? areas
      : areas.filter((area) => !EXTRA_KINDS.includes(area.t));
  return { wide, close, areas: districtsInView(shown, bbox, limit) };
}

/** Whether a view is wider or taller than `wideAboveDeg` degrees. */
export function isWideView([west, south, east, north], wideAboveDeg) {
  return east - west > wideAboveDeg || north - south > wideAboveDeg;
}

/**
 * Sweden's protected nature: the national parks, the nature reserves in
 * force and the culture reserves from Naturvårdsverket's Naturvårdsregistret
 * (open data, CC0; "Källa: Naturvårdsverket" asked for). Pure lookups shared
 * by the snapshot build, the server route and the layer. No Cesium, no Node
 * built-ins.
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
  ].map(([id, color]) => Object.freeze({ id, color })),
);
export const KIND = Object.freeze(
  Object.fromEntries(AREA_KINDS.map((kind) => [kind.id, kind])),
);
/** Naturvårdsverket's page for an area in its map service Skyddad natur. */
export const skyddadNaturUrl = (nvrid) =>
  `https://skyddadnatur.naturvardsverket.se/sknat/?nvrid=${encodeURIComponent(nvrid)}`;

/**
 * The areas whose box meets a view, nearest its centre first, at most
 * `limit`. A wide view gets the national parks alone.
 * @param {{t: string, b: number[]}[]} areas Snapshot areas.
 * @param {number[]} bbox [west, south, east, north].
 * @param {{limit: number, wideAboveDeg: number}} options
 * @returns {{areas: object[], wide: boolean}}
 */
export function areasInView(areas, bbox, { limit, wideAboveDeg }) {
  const [west, south, east, north] = bbox;
  const wide = east - west > wideAboveDeg || north - south > wideAboveDeg;
  return {
    wide,
    areas: districtsInView(
      wide ? areas.filter((area) => area.t === 'np') : areas,
      bbox,
      limit,
    ),
  };
}

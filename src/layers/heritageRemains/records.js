/**
 * Ancient and other cultural-heritage remains from Riksantikvarieämbetet's
 * Kulturmiljöregistret (the register behind Fornsök), as RAÄ's INSPIRE OGC
 * API Features serves them: public domain, "ange gärna Riksantikvarieämbetet
 * som källa" with the date (product description v3, 2026-02-02). Pure parsing
 * and queries shared by the server proxy and the layer. No Cesium, no Node
 * built-ins.
 *
 * Only what identifies a remain is kept: its type, legal assessment, number,
 * name, municipality and whether it is confirmed in the field. RAÄ's
 * description and directions for finding it stay in Fornsök, one click away.
 */

import { clipViewBox, distanceMeters } from '../shelters/records.js';

export { distanceMeters };

/** The assessments, protected first, with their colour. */
export const ASSESSMENTS = Object.freeze(
  [
    ['fl', 'Fornlämning', '#ff7043'],
    ['mfl', 'Möjlig fornlämning', '#ffd54f'],
    ['okl', 'Övrig kulturhistorisk lämning', '#bcaaa4'],
    ['none', 'Ingen antikvarisk bedömning', '#90a4ae'],
    ['ej', 'Ej kulturhistorisk lämning', '#78909c'],
  ].map(([id, name, color]) => Object.freeze({ id, name, color })),
);
const BY_NAME = new Map(ASSESSMENTS.map((entry) => [entry.name, entry]));
export const ASSESSMENT = Object.freeze(
  Object.fromEntries(ASSESSMENTS.map((entry) => [entry.id, entry])),
);

/** A view wider than this (degrees) shows no remains: there are some 840 000. */
export const REMAINS_MAX_SPAN_DEG = 0.15;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** RAÄ's page for a remain, the one Fornsök links to. */
export const remainUrl = (uuid) =>
  `https://pub.raa.se/visa/objekt/lamning/${uuid}`;

const text = (value, max) =>
  typeof value === 'string' && value.trim()
    ? value.trim().replace(/\s+/g, ' ').slice(0, max)
    : null;

/** A point to draw a remain at: the point, a line's middle, an area's mean. */
function representative(geometry) {
  const type = geometry?.type;
  const c = geometry?.coordinates;
  if (!Array.isArray(c)) return null;
  const mean = (points) => {
    const usable = points.filter(
      (p) =>
        Array.isArray(p) && Number.isFinite(+p[0]) && Number.isFinite(+p[1]),
    );
    if (!usable.length) return null;
    return [
      usable.reduce((sum, p) => sum + +p[0], 0) / usable.length,
      usable.reduce((sum, p) => sum + +p[1], 0) / usable.length,
    ];
  };
  switch (type) {
    case 'Point':
      return [+c[0], +c[1]];
    case 'MultiPoint':
      return mean(c);
    case 'LineString':
      return c[Math.floor(c.length / 2)]?.map(Number) ?? null;
    case 'MultiLineString':
      return c[0]?.[Math.floor((c[0]?.length ?? 0) / 2)]?.map(Number) ?? null;
    case 'Polygon':
      // The closing vertex repeats the first.
      return mean((c[0] ?? []).slice(0, -1));
    case 'MultiPolygon':
      return mean((c[0]?.[0] ?? []).slice(0, -1));
    default:
      return null;
  }
}

/**
 * One remain, or null without an id or a place in Sweden.
 * @param {object} feature A GeoJSON feature of kulturhistoriska_fornlamningar.
 */
export function normalizeRemain(feature) {
  const props = feature?.properties || {};
  const id = String(props.pk_id ?? '').toLowerCase();
  const point = representative(feature?.geometry);
  if (!UUID_RE.test(id) || !point) return null;
  const [lon, lat] = point;
  if (
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    lat < 54 ||
    lat > 70 ||
    lon < 9 ||
    lon > 25.5
  )
    return null;
  const page =
    /^https:\/\/pub\.raa\.se\/visa\/objekt\/lamning\/([0-9a-f-]{36})$/i.exec(
      String(props.url ?? ''),
    )?.[1];
  return {
    id,
    point: [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5],
    type: text(props.lamningstyp, 80),
    number: text(props.lamningsnummer, 30),
    raa: text(props.raa_nummer, 60),
    name: text(props.lamningsnamn, 80),
    municipality: text(props.kommun, 60),
    assessment: BY_NAME.get(text(props.antikvariskbedomning, 60))?.id ?? 'none',
    confirmed: text(props.aktualitetstatus, 60) === 'Bekräftad i fält',
    page: page && UUID_RE.test(page.toLowerCase()) ? page.toLowerCase() : null,
  };
}

/** Every remain in a collection, without duplicates. */
export function normalizeRemains(features) {
  if (!Array.isArray(features)) throw new Error('Malformed remains collection');
  const seen = new Set();
  return features
    .map(normalizeRemain)
    .filter((row) => row && !seen.has(row.id) && seen.add(row.id));
}

/** The view box cut to REMAINS_MAX_SPAN_DEG a side about the centre. */
export const clipRemainsBox = (bbox, center) =>
  clipViewBox(bbox, center, REMAINS_MAX_SPAN_DEG);

const GRID = 0.02;
/**
 * A box widened to the 0.02-degree grid, so views close to each other share
 * one answer from RAÄ and one cache entry.
 */
export function snapToGrid([west, south, east, north]) {
  const down = (value) => Math.floor(value / GRID + 1e-9) * GRID;
  const up = (value) => Math.ceil(value / GRID - 1e-9) * GRID;
  return [down(west), down(south), up(east), up(north)].map(
    (value) => Math.round(value * 100) / 100,
  );
}

/**
 * The remains in a box: how many, and the nearest `limit` to the centre,
 * nearest first, each with its distance.
 * @param {object[]} rows Normalized remains.
 * @param {{bbox: number[], center: number[], limit?: number}} query
 */
export function remainsInView(rows, { bbox, center, limit = 1500 }) {
  const [west, south, east, north] = bbox;
  const inside = rows.filter(({ point: [lon, lat] }) => {
    return lon >= west && lon <= east && lat >= south && lat <= north;
  });
  const shown = inside
    .map((row) => ({
      ...row,
      distance: Math.round(distanceMeters(center, row.point)),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, Math.max(0, limit));
  return { total: inside.length, remains: shown };
}

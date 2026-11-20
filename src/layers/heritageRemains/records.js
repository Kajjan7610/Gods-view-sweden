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
export function representative(geometry) {
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

/**
 * Sweden's UNESCO World Heritage sites and its protected buildings, from
 * Riksantikvarieämbetet's INSPIRE OGC API Features on the same Metria
 * GeoServer as the remains. Pure parsing and queries shared by the server
 * proxy and the layer. No Cesium, no Node built-ins.
 *
 * World Heritage (Varldsarv_ogc / varldsarv_sverige): some fifteen sites,
 * public domain, "Riksantikvarieämbetet" asked for as the source. The areas
 * carry no buffer zones, and Struve's arc is drawn schematically.
 *
 * Protected buildings come from Bebyggelseregistret (CC0, photos excluded):
 * the inventory (kulturhistoriskt_inventerad_bebyggelse) and the protection
 * areas of listed buildings (byggnadsminnen_skyddsomraden).
 *
 * PRIVACY: the inventory is mostly ordinary, unprotected homes. Only the
 * legal protections in PROTECTED_TYPES are ever kept, both in the request
 * to RAÄ and again here, whatever RAÄ answers. Of a building only its name,
 * protection, decision year, building years, purpose, municipality and RAÄ
 * page are kept: never the property, its register building or an owner.
 */

/**
 * The legal protections shown, as `skyddstyp_namn` spells them (RAÄ,
 * "Bebyggelse, kulturhistoriskt inventerad, wms – teknisk beskrivning"
 * v1.0, 2025-04-14: Anmälningsplikt, Byggnadsminne, Statligt byggnadsminne,
 * Kyrkligt kulturminne, Identifierat kulturvärde, Förstört kulturvärde).
 * Left out on purpose: "Identifierat kulturvärde" (an inventory's
 * judgement, mostly private homes, no protection), "Förstört kulturvärde"
 * (lost) and "Anmälningsplikt" (a pending duty to report, not a decision).
 */
export const PROTECTED_TYPES = Object.freeze(
  [
    ['bm', 'Byggnadsminne', '#f06292'],
    ['sbm', 'Statligt byggnadsminne', '#ba68c8'],
    ['kk', 'Kyrkligt kulturminne', '#4db6ac'],
  ].map(([id, name, color]) => Object.freeze({ id, name, color })),
);
export const PROTECTED_TYPE = Object.freeze(
  Object.fromEntries(PROTECTED_TYPES.map((entry) => [entry.id, entry])),
);
const TYPE_BY_NAME = new Map(
  PROTECTED_TYPES.map((entry) => [entry.name.toLowerCase(), entry.id]),
);

/** The colour of a World Heritage site. */
export const WORLD_HERITAGE_COLOR = '#29b6f6';

/**
 * The CQL2 text filter that keeps the inventory to PROTECTED_TYPES (basic
 * CQL2 comparisons, which the service conforms to).
 */
export const PROTECTED_BUILDINGS_FILTER = PROTECTED_TYPES.map(
  ({ name }) => `skyddstyp_namn = '${name}'`,
).join(' OR ');

/** The most outline points kept per ring of a protection area. */
export const AREA_RING_POINTS = 120;
/** The most outline points kept per ring of a World Heritage site. */
export const SITE_RING_POINTS = 400;
const AREA_POLYGONS = 8;
const SITE_POLYGONS = 60;

const BUILDING_PAGE_RE =
  /^https:\/\/pub\.raa\.se\/visa\/objekt\/bebyggelse\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNESCO_RE = /^https?:\/\/whc\.unesco\.org\/[a-z0-9/._-]{0,80}$/i;

/** A page at Bebyggelseregistret, or null. */
export const buildingPage = (value) => {
  const url = String(value ?? '')
    .trim()
    .toLowerCase();
  return BUILDING_PAGE_RE.test(url) ? url : null;
};
/** A page at UNESCO's World Heritage Centre, over https, or null. */
export const unescoPage = (value) => {
  const url = String(value ?? '').trim();
  return UNESCO_RE.test(url) ? url.replace(/^http:/i, 'https:') : null;
};

const year = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 800 && n <= 2100 ? n : null;
};
const dateYear = (value) =>
  year(/^(\d{4})-\d{2}-\d{2}/.exec(text(value, 40) ?? '')?.[1]);
/** An id safe in a pick id (no colon), or null. */
const safeId = (value) => {
  if (value === null || value === undefined) return null;
  const id = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^0-9a-z._-]/g, '_');
  return id.length <= 80 && /[0-9a-z]/.test(id) ? id : null;
};
const inSweden = ([lon, lat]) =>
  Number.isFinite(lon) &&
  Number.isFinite(lat) &&
  lat >= 54 &&
  lat <= 70 &&
  lon >= 9 &&
  lon <= 25.5;
const round5 = (value) => Math.round(value * 1e5) / 1e5;

/**
 * The protection a `skyddstyp_namn` names: exactly one of PROTECTED_TYPES,
 * or null for anything else (an unprotected building is never kept).
 */
export function protectionOf(value) {
  return TYPE_BY_NAME.get(text(value, 60)?.toLowerCase() ?? '') ?? null;
}

/** A ring cut to at most `max` points, evenly, rounded, open (no repeat). */
function thinRing(ring, max) {
  if (!Array.isArray(ring)) return null;
  const points = ring
    .filter(
      (p) =>
        Array.isArray(p) && Number.isFinite(+p[0]) && Number.isFinite(+p[1]),
    )
    .map((p) => [round5(+p[0]), round5(+p[1])]);
  const [first] = points;
  const last = points.at(-1);
  if (
    first &&
    last &&
    points.length > 1 &&
    first[0] === last[0] &&
    first[1] === last[1]
  )
    points.pop();
  if (points.length < 3) return null;
  if (points.length <= max) return points;
  const step = points.length / max;
  return Array.from({ length: max }, (_, i) => points[Math.floor(i * step)]);
}

/** The outer rings of a (Multi)Polygon, thinned; holes are left out. */
function outerRings(geometry, maxPoints, maxPolygons) {
  const c = geometry?.coordinates;
  if (!Array.isArray(c)) return [];
  const polygons =
    geometry.type === 'Polygon'
      ? [c]
      : geometry.type === 'MultiPolygon'
        ? c
        : [];
  return polygons
    .map((polygon) => thinRing(polygon?.[0], maxPoints))
    .filter(Boolean)
    .slice(0, maxPolygons);
}

/** A ring's box as [west, south, east, north]. */
function ringBox(ring) {
  let [west, south, east, north] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [lon, lat] of ring) {
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  return [west, south, east, north];
}

/** The box around every ring, or null. */
const ringsBox = (rings) =>
  rings.length
    ? rings
        .map(ringBox)
        .reduce((a, b) => [
          Math.min(a[0], b[0]),
          Math.min(a[1], b[1]),
          Math.max(a[2], b[2]),
          Math.max(a[3], b[3]),
        ])
    : null;

/** The mean of the largest ring's points: where a site's dot goes. */
function largestRingMiddle(rings) {
  let best = null;
  let bestArea = -1;
  for (const ring of rings) {
    const [w, s, e, n] = ringBox(ring);
    const area = (e - w) * (n - s);
    if (area > bestArea) [best, bestArea] = [ring, area];
  }
  if (!best) return null;
  return [
    round5(best.reduce((sum, p) => sum + p[0], 0) / best.length),
    round5(best.reduce((sum, p) => sum + p[1], 0) / best.length),
  ];
}

/** The building years as {from, to}, or null when RAÄ has none. */
function builtYears(from, to) {
  const a = year(from);
  const b = year(to);
  if (a === null && b === null) return null;
  return { from: a ?? b, to: b !== null && b >= (a ?? b) ? b : (a ?? b) };
}

/**
 * One protected building of the inventory, or null for anything not under
 * one of PROTECTED_TYPES, without an id or a place in Sweden.
 * @param {object} feature A feature of kulturhistoriskt_inventerad_bebyggelse.
 */
export function normalizeBuilding(feature) {
  const props = feature?.properties || {};
  const protection = protectionOf(props.skyddstyp_namn);
  if (!protection) return null;
  const id = safeId(props.id);
  const at = representative(feature?.geometry);
  if (!id || !at || !inSweden(at.map(Number))) return null;
  return {
    id,
    point: [round5(+at[0]), round5(+at[1])],
    name: text(props.namn, 120),
    protection,
    decided: dateYear(props.beslutsdatum),
    built: builtYears(
      props.nybyggnad_tillkomstar_from,
      props.nybyggnad_tillkomstar_tom,
    ),
    purpose:
      text(props.andamal_underkategori, 80) ??
      text(props.andamal_huvudkategori, 80),
    municipality: text(props.kommunnamn, 60),
    page: buildingPage(props.url),
  };
}

/**
 * The protection of a listed building's protection area: a named listed
 * building, state-owned or not. The collection holds nothing else, so a
 * spelling RAÄ adds ("Enskilt byggnadsminne") is read by its words.
 */
function areaProtection(value) {
  const name = text(value, 60)?.toLowerCase() ?? '';
  const exact = protectionOf(name);
  if (exact === 'bm' || exact === 'sbm') return exact;
  if (!name.includes('byggnadsminne')) return null;
  return name.includes('statlig') ? 'sbm' : 'bm';
}

/**
 * One protection area of a listed building, its outline thinned, or null
 * for a protection since lifted (`havt_skydd`), without an id or outline.
 * @param {object} feature A feature of byggnadsminnen_skyddsomraden.
 */
export function normalizeProtectionArea(feature) {
  const props = feature?.properties || {};
  if (props.havt_skydd === true || props.havt_skydd === 'true') return null;
  const protection = areaProtection(props.skyddstyp_namn);
  const id = safeId(props.id) ?? safeId(props.fid);
  const rings = outerRings(feature?.geometry, AREA_RING_POINTS, AREA_POLYGONS);
  const at = largestRingMiddle(rings);
  if (!protection || !id || !at || !inSweden(at)) return null;
  return {
    id,
    point: at,
    box: ringsBox(rings),
    rings,
    name: text(props.namn, 120),
    protection,
    decided: dateYear(props.beslutsdatum),
    built: builtYears(props.tillkomstar_from, props.tillkomstar_tom),
    purpose:
      text(props.andamal_underkategori, 80) ??
      text(props.andamal_huvudkategori, 80),
    municipality: text(props.kommunnamn, 60),
    page: buildingPage(props.url),
  };
}

/**
 * One World Heritage site: its names, the year it was inscribed, UNESCO's
 * page, its outlines (thinned) and a point for its dot.
 * @param {object} feature A feature of varldsarv_sverige.
 */
export function normalizeWorldSite(feature) {
  const props = feature?.properties || {};
  const id =
    safeId(props.id) ?? safeId(props.fid) ?? safeId(feature?.id ?? null);
  const geometry = feature?.geometry;
  const rings = outerRings(geometry, SITE_RING_POINTS, SITE_POLYGONS);
  let at = largestRingMiddle(rings);
  if (!at && /Point$/.test(geometry?.type ?? '')) {
    const p = representative(geometry);
    at = p ? [round5(+p[0]), round5(+p[1])] : null;
  }
  const nameSv = text(props.sitename_sve, 120);
  const nameEn = text(props.sitename_eng, 120);
  if (!id || !at || !inSweden(at) || !(nameSv || nameEn)) return null;
  return {
    id,
    point: at,
    rings,
    nameSv: nameSv ?? nameEn,
    nameEn: nameEn ?? nameSv,
    inscribed: year(props.legalfoundationyear),
    unesco: unescoPage(props.unesco_href),
    // Struve's arc is a chain of survey points; RAÄ's areas only stand for them.
    schematic: /struve/i.test(`${nameSv} ${nameEn}`),
  };
}

/** Every row a normalizer keeps, without duplicate ids. */
export function normalizeAll(features, normalize) {
  if (!Array.isArray(features)) throw new Error('Malformed collection');
  const seen = new Set();
  return features
    .map(normalize)
    .filter((row) => row && !seen.has(row.id) && seen.add(row.id));
}

/**
 * The protection areas touching a box, nearest to the centre first, at most
 * `limit`.
 */
export function areasInView(rows, { bbox, center, limit = 200 }) {
  const [west, south, east, north] = bbox;
  return rows
    .filter(
      ({ box: [w, s, e, n] }) =>
        w <= east && e >= west && s <= north && n >= south,
    )
    .map((row) => ({ row, d: distanceMeters(center, row.point) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, Math.max(0, limit))
    .map(({ row }) => {
      const { box: _box, ...rest } = row;
      return rest;
    });
}

/**
 * Swedish hospitals and their emergency departments: pure parsing and
 * queries shared by the snapshot build and the layer. No Cesium, no Node
 * built-ins.
 *
 * Hospitals come from OpenStreetMap (ODbL). Socialstyrelsen's yearly fact
 * sheet on emergency departments (Patientregistret) gives, per department,
 * the visits and the medians for time to physician (TTL) and total stay
 * (TVT). There is no open live waiting time in Sweden: these are the year's
 * medians, so the layer compares them, it does not promise them.
 */

/** What colours the departments: time to physician or total stay. */
export const ED_METRICS = Object.freeze(
  [
    ['ttl', 'Time to physician'],
    ['tvt', 'Total stay'],
  ].map(([id, label]) => Object.freeze({ id, label })),
);

/**
 * Bands against the national median: more than 15 % shorter, within 15 %,
 * more than 15 % longer. Hospitals outside the statistics are grey.
 */
export const ED_BANDS = Object.freeze(
  [
    ['shorter', '#64ffda'],
    ['near', '#ffd54f'],
    ['longer', '#ff8a65'],
  ].map(([id, color]) => Object.freeze({ id, color })),
);
export const HOSPITAL_COLOR = '#b0bec5';
/** A department the statistics give no figure for in the chosen measure. */
export const NO_FIGURE_COLOR = '#eceff1';
const BAND_SHARE = 0.15;

/**
 * The median in minutes for a metric in the statistics' year, or null. The
 * figures are keyed by year (`ttl2025`); `statistics.year` says which is now.
 */
export function edMinutes(row, metric, statistics) {
  const value = row?.ed?.[`${metric}${statistics?.year}`];
  return Number.isFinite(value) ? value : null;
}

/** Sweden's median in minutes for a metric in the statistics' year, or null. */
export function nationalMinutes(metric, statistics) {
  const value = statistics?.national?.[`${metric}${statistics.year}`];
  return Number.isFinite(value) ? value : null;
}

/** The band of a department against the national median, or null. */
export function edBand(row, metric, statistics) {
  const value = edMinutes(row, metric, statistics);
  const median = nationalMinutes(metric, statistics);
  if (value === null || median === null) return null;
  if (value < median * (1 - BAND_SHARE)) return 'shorter';
  if (value > median * (1 + BAND_SHARE)) return 'longer';
  return 'near';
}

export function hospitalColor(row, metric, statistics) {
  const band = edBand(row, metric, statistics);
  if (band) return ED_BANDS.find((entry) => entry.id === band).color;
  return row?.ed ? NO_FIGURE_COLOR : HOSPITAL_COLOR;
}

const text = (value, max) =>
  typeof value === 'string' && value.trim()
    ? value.trim().replace(/\s+/g, ' ').slice(0, max)
    : null;

// Health centres, clinics and entrances tagged as hospitals, and Finnish
// health centres just across the border, are not hospitals here.
const NOT_A_HOSPITAL =
  /vårdcentral|vårdcentrum|mottagning|ingång|förlossning|BUP|ambulans|terveyskeskus|sanatorium|akut|område|sjukhem|klinik|centralen|^hus\b/i;
const A_HOSPITAL = /sjukhus|lasarett|sjukstuga|hospital/i;

/** Whether an OSM name reads as a hospital (not a clinic inside one). */
export function isHospitalName(name) {
  return Boolean(name) && A_HOSPITAL.test(name) && !NOT_A_HOSPITAL.test(name);
}

const fold = (name) =>
  String(name || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/**
 * One hospital from an Overpass element (`out tags center`), or null.
 * @param {object} element
 * @param {string|null} [name] A name for an element mapped without one.
 */
export function normalizeHospital(element, name = null) {
  const tags = element?.tags || {};
  const lon = Number(element?.center?.lon ?? element?.lon);
  const lat = Number(element?.center?.lat ?? element?.lat);
  const id = `${String(element?.type || '').slice(0, 1)}${element?.id}`;
  const label = text(tags.name, 80) ?? text(name, 80);
  if (
    !/^[nwr]\d+$/.test(id) ||
    !label ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon)
  )
    return null;
  return {
    id,
    point: [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5],
    name: label,
    operator: text(tags.operator, 80),
  };
}

const RAD = Math.PI / 180;
/** Great-circle metres between two [lon, lat] points. */
export function distanceMeters([lon1, lat1], [lon2, lat2]) {
  const a =
    Math.sin(((lat2 - lat1) * RAD) / 2) ** 2 +
    Math.cos(lat1 * RAD) *
      Math.cos(lat2 * RAD) *
      Math.sin(((lon2 - lon1) * RAD) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
}

// Words every hospital name shares; the rest tell two hospitals apart.
const GENERIC = new Set(
  'sjukhus sjukhuset narsjukhus narsjukhuset lasarett lasarettet i och'.split(
    ' ',
  ),
);
const coreWords = (name) =>
  new Set(
    fold(name)
      .split(' ')
      .filter((word) => !GENERIC.has(word)),
  );

/** Whether two hospitals are one site mapped twice. */
function sameSite(a, b) {
  const distance = distanceMeters(a.point, b.point);
  if (fold(a.name) === fold(b.name)) return distance < 3000;
  // A children's hospital on a hospital's grounds is a hospital of its own.
  if (/barn/i.test(a.name) !== /barn/i.test(b.name)) return false;
  const words = coreWords(b.name);
  return distance < 500 && [...coreWords(a.name)].some((w) => words.has(w));
}

/**
 * Hospitals without the doubles OSM keeps (a site mapped as both a node and
 * an area, or under two names): the same folded name within 3 km, or a
 * shared distinctive word within 500 m, is one hospital. `keep` ids win;
 * otherwise a relation beats a way beats a node.
 */
export function dedupeHospitals(rows, keep = new Set()) {
  const rank = (row) =>
    (keep.has(row.id) ? 10 : 0) + { r: 3, w: 2, n: 1 }[row.id[0]];
  const sorted = [...rows].sort((a, b) => rank(b) - rank(a));
  const kept = [];
  for (const row of sorted) {
    if (!kept.some((other) => sameSite(other, row))) kept.push(row);
  }
  return kept;
}

/**
 * The hospitals with an emergency department in the statistics, nearest to
 * a point first, or the shortest median in a box first.
 * @param {object[]} rows Hospitals.
 * @param {{center: number[], statistics: object, bbox?: number[]|null,
 *   metric?: string, order?: 'nearest'|'shortest', limit?: number}} query
 */
export function rankDepartments(
  rows,
  {
    center,
    statistics,
    bbox = null,
    metric = 'ttl',
    order = 'nearest',
    limit = 5,
  },
) {
  const minutes = (row) => edMinutes(row, metric, statistics);
  const inBox = (row) => {
    if (!bbox) return true;
    const [west, south, east, north] = bbox;
    const [lon, lat] = row.point;
    return lon >= west && lon <= east && lat >= south && lat <= north;
  };
  const ranked = rows
    .filter((row) =>
      order === 'nearest'
        ? Boolean(row.ed)
        : minutes(row) !== null && inBox(row),
    )
    .map((row) => ({
      row,
      distance: Math.round(distanceMeters(center, row.point)),
    }));
  ranked.sort((a, b) =>
    order === 'shortest'
      ? minutes(a.row) - minutes(b.row) || a.distance - b.distance
      : a.distance - b.distance,
  );
  return ranked.slice(0, Math.max(0, limit));
}

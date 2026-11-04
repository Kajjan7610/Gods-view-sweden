/**
 * SMHI (Sweden) impact-based weather warnings: pure parsing shared by the
 * server proxy and the layer. No Cesium, no Node built-ins.
 *
 * SMHI's open warning API (CC BY 4.0, no key) publishes each warning with one
 * or more warning areas. An area has a level — MESSAGE, YELLOW, ORANGE or
 * RED by expected impact — an approximate start and end, texts in Swedish
 * and English ("What happens?", "What should I think about?") and its own
 * GeoJSON polygon: a county, a sea district or a drawn region.
 */

/** Levels, least severe first; drawing and the legend follow this order. */
export const WARNING_LEVELS = Object.freeze([
  Object.freeze({ code: 'MESSAGE', rank: 0, color: '#90caf9' }),
  Object.freeze({ code: 'YELLOW', rank: 1, color: '#ffd600' }),
  Object.freeze({ code: 'ORANGE', rank: 2, color: '#ff9100' }),
  Object.freeze({ code: 'RED', rank: 3, color: '#ff1744' }),
]);
const LEVEL_BY_CODE = new Map(
  WARNING_LEVELS.map((level) => [level.code, level]),
);

export const MAX_AREAS = 500;
const MAX_RING_POINTS = 4000;
const MAX_TEXT = 1200;

export function warningLevel(code) {
  return LEVEL_BY_CODE.get(String(code ?? '').toUpperCase()) || null;
}

export function levelColor(code) {
  return warningLevel(code)?.color || '#9e9e9e';
}

const text = (value, max = MAX_TEXT) => {
  const s = String(value ?? '').trim();
  return s ? s.slice(0, max) : null;
};
const bilingual = (node, max) => {
  const sv = text(node?.sv, max);
  const en = text(node?.en, max);
  return sv || en ? { sv: sv || en, en: en || sv } : null;
};
const time = (value) => {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : null;
};

function ringOf(coordinates) {
  if (!Array.isArray(coordinates)) return null;
  const ring = [];
  for (const point of coordinates.slice(0, MAX_RING_POINTS)) {
    const lon = Number(point?.[0]);
    const lat = Number(point?.[1]);
    if (
      !Number.isFinite(lon) ||
      !Number.isFinite(lat) ||
      Math.abs(lon) > 180 ||
      Math.abs(lat) > 90
    )
      continue;
    ring.push([Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5]);
  }
  return ring.length >= 3 ? ring : null;
}

/**
 * A GeoJSON Polygon or MultiPolygon as [{outer, holes}].
 * @param {object} geometry
 * @returns {{outer: number[][], holes: number[][][]}[]}
 */
export function polygonsOf(geometry) {
  const polygons =
    geometry?.type === 'Polygon'
      ? [geometry.coordinates]
      : geometry?.type === 'MultiPolygon'
        ? geometry.coordinates
        : [];
  const out = [];
  for (const rings of Array.isArray(polygons) ? polygons : []) {
    if (!Array.isArray(rings)) continue;
    const [outer, ...holes] = rings.map(ringOf);
    if (!outer) continue;
    out.push({ outer, holes: holes.filter(Boolean) });
  }
  return out;
}

/**
 * Normalize one warning area of one warning; null when it has no level, no
 * polygon or has already ended.
 * @param {object} warning
 * @param {object} area
 * @param {number} nowMs
 */
export function normalizeWarningArea(warning, area, nowMs) {
  const level = warningLevel(area?.warningLevel?.code);
  const polygons = polygonsOf(area?.area?.geometry);
  if (!level || !polygons.length || area?.id == null || warning?.id == null)
    return null;
  const end = time(area.approximateEnd);
  if (end != null && end < nowMs) return null;
  const start = time(area.approximateStart);
  return {
    id: `${String(warning.id).slice(0, 20)}:${String(area.id).slice(0, 20)}`,
    level: level.code,
    event: bilingual(warning.event, 120),
    eventCode: text(warning.event?.code, 40),
    description: bilingual(area.eventDescription, 160),
    area: bilingual(area.areaName, 160),
    counties: (Array.isArray(area.affectedAreas) ? area.affectedAreas : [])
      .map((entry) => bilingual(entry, 80))
      .filter(Boolean)
      .slice(0, 12),
    start,
    end,
    upcoming: start != null && start > nowMs,
    published: time(area.published),
    texts: (Array.isArray(area.descriptions) ? area.descriptions : [])
      .map((entry) => ({
        code: text(entry?.title?.code, 20),
        title: bilingual(entry?.title, 80),
        text: bilingual(entry?.text),
      }))
      .filter((entry) => entry.text)
      .slice(0, 6),
    polygons,
  };
}

/**
 * Normalize the API answer: every warning area still in effect or upcoming.
 * @param {object[]} payload Parsed JSON body (an array of warnings).
 * @param {number} nowMs
 * @returns {{areas: object[], truncated: boolean}}
 */
export function normalizeWarnings(payload, nowMs) {
  if (!Array.isArray(payload)) throw new Error('Malformed SMHI warnings');
  const areas = [];
  let total = 0;
  for (const warning of payload) {
    for (const area of Array.isArray(warning?.warningAreas)
      ? warning.warningAreas
      : []) {
      total++;
      if (areas.length >= MAX_AREAS) continue;
      const row = normalizeWarningArea(warning, area, nowMs);
      if (row) areas.push(row);
    }
  }
  areas.sort(
    (a, b) =>
      warningLevel(a.level).rank - warningLevel(b.level).rank ||
      a.id.localeCompare(b.id),
  );
  return { areas, truncated: total > MAX_AREAS };
}

/**
 * Swedish sea weather: pure parsing shared by the server proxy and the layer.
 * No Cesium, no Node built-ins.
 *
 * SMHI's ocean observations (open data, CC BY 4.0, no key): three files,
 * each with every station's last day, give the water level, the water
 * temperature and the waves along the coast. They measure no wind; the wind
 * classes serve rows that carry one. Sjöfartsverket's ViVa is not read: it
 * does not allow its data to be republished.
 */

/** Mean-wind classes in m/s, calmest first (Swedish sea-forecast steps). */
export const WIND_CLASSES = Object.freeze([
  Object.freeze({ id: 'calm', max: 4, color: '#80deea' }),
  Object.freeze({ id: 'moderate', max: 8, color: '#9ccc65' }),
  Object.freeze({ id: 'fresh', max: 13, color: '#ffd600' }),
  Object.freeze({ id: 'gale', max: 20, color: '#ff9100' }),
  Object.freeze({ id: 'storm', max: Infinity, color: '#ff1744' }),
]);
/** Water-level classes in cm against mean water, lowest first. */
export const LEVEL_CLASSES = Object.freeze([
  Object.freeze({ id: 'very-low', max: -40, color: '#7c4dff' }),
  Object.freeze({ id: 'low', max: -10, color: '#448aff' }),
  Object.freeze({ id: 'normal', max: 10, color: '#9ccc65' }),
  Object.freeze({ id: 'high', max: 40, color: '#ffd600' }),
  Object.freeze({ id: 'very-high', max: Infinity, color: '#ff1744' }),
]);
export const NO_VALUE_COLOR = '#9e9e9e';
/** A sample older than this is no longer the weather at the station. */
export const SEA_SAMPLE_MAX_AGE_MS = 3 * 60 * 60_000;

/**
 * SMHI ocean observation parameters per row field. The level is against the
 * year's mean water (parameter 12), MVY; parameter 6 is
 * in RH 2000 and is not read.
 */
export const SMHI_SEA_PARAMETERS = Object.freeze({
  level: 12,
  waterTemp: 5,
  waveHeight: 1,
});

/** MVY, mean water (medelvattenyta): the zero the classes assume. */
export const isMeanWater = (reference) =>
  String(reference ?? '')
    .trim()
    .toUpperCase() === 'MVY';

/**
 * The level when it is measured against mean water, else null: a level in
 * RH 2000 or above chart datum is another quantity and shares no classes.
 */
export function meanWaterLevel(row) {
  return row?.level != null && isMeanWater(row.levelReference)
    ? row.level
    : null;
}

export function classOf(classes, value) {
  if (!Number.isFinite(value)) return null;
  return classes.find((entry) => value <= entry.max) || null;
}

const text = (value, max) => {
  const s = String(value ?? '').trim();
  return s ? s.slice(0, max) : null;
};

/**
 * Merge SMHI's per-parameter answers into one row per station. Old, empty
 * or out-of-area readings drop.
 * @param {{[field: string]: object}} answers row field → ocobs JSON
 * @param {number} nowMs
 * @returns {object[]}
 */
export function mergeSmhiSea(answers, nowMs) {
  const byKey = new Map();
  for (const [field, answer] of Object.entries(answers || {})) {
    for (const station of Array.isArray(answer?.station)
      ? answer.station
      : []) {
      const lat = Number(station?.latitude);
      const lon = Number(station?.longitude);
      if (
        station?.key == null ||
        !Number.isFinite(lat) ||
        !Number.isFinite(lon)
      )
        continue;
      if (lat < 54 || lat > 70 || lon < 9 || lon > 25) continue;
      // The newest sample with a value: the day's file can end in an empty one.
      const reading = (s) =>
        s?.value == null || s.value === '' ? NaN : Number(s.value);
      const samples = Array.isArray(station.value) ? station.value : [];
      const sample = samples.findLast((s) => Number.isFinite(reading(s)));
      const value = reading(sample);
      const at = Number(sample?.date);
      if (!Number.isFinite(value) || !Number.isFinite(at)) continue;
      if (nowMs - at > SEA_SAMPLE_MAX_AGE_MS) continue;
      const key = String(station.key).slice(0, 12);
      const row = byKey.get(key) || {
        id: `smhi:${key}`,
        source: 'smhi',
        name: text(station.name, 80) || key,
        point: [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5],
        meanWind: null,
        gust: null,
        windHeading: null,
        level: null,
        levelReference: null,
        waterTemp: null,
        airTemp: null,
        waveHeight: null,
        visibility: null,
        updated: null,
      };
      row[field] = value;
      if (field === 'level') row.levelReference = 'MVY';
      if (!row.updated || at > row.updated) row.updated = at;
      byKey.set(key, row);
    }
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, 'sv'));
}

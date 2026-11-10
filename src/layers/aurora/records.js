/**
 * Aurora forecast: pure parsing shared by the server proxy and the layer.
 * No Cesium, no Node built-ins.
 *
 * NOAA SWPC's OVATION model (services.swpc.noaa.gov, public domain, no key)
 * gives, every few minutes, the chance of aurora overhead on a one-degree
 * grid for the next half hour or so; the planetary Kp index (0–9) says how
 * stirred the geomagnetic field is. Only the northern band is kept: Sweden's
 * auroras sit between 55° and 72° N.
 */

/** The kept band: latitudes SOUTH..90 N, longitudes 0..359 E. */
export const AURORA_SOUTH = 30;
const ROWS = 90 - AURORA_SOUTH + 1;

/** Swedish towns whose chance the layer row lists, north to south. */
export const AURORA_TOWNS = Object.freeze([
  Object.freeze({ name: 'Kiruna', point: [20.23, 67.86] }),
  Object.freeze({ name: 'Luleå', point: [22.15, 65.58] }),
  Object.freeze({ name: 'Umeå', point: [20.26, 63.83] }),
  Object.freeze({ name: 'Östersund', point: [14.64, 63.18] }),
  Object.freeze({ name: 'Sundsvall', point: [17.31, 62.39] }),
  Object.freeze({ name: 'Västerås', point: [16.54, 59.61] }),
  Object.freeze({ name: 'Stockholm', point: [18.07, 59.33] }),
  Object.freeze({ name: 'Göteborg', point: [11.97, 57.71] }),
  Object.freeze({ name: 'Malmö', point: [13.0, 55.6] }),
]);

/** Colour ramp by chance in percent: green, then yellow, then red. */
export function auroraColor(chance) {
  if (chance >= 50) return '#ff1744';
  if (chance >= 30) return '#ffd600';
  if (chance >= 10) return '#00e676';
  if (chance >= 3) return '#1de9b6';
  return null;
}

/**
 * The OVATION answer to {observed, forecast, rows}: rows[0] is AURORA_SOUTH,
 * rows.at(-1) is 90 N, each 360 chances indexed by longitude 0..359 E.
 * @param {object} payload ovation_aurora_latest.json
 */
export function normalizeOvation(payload) {
  const cells = Array.isArray(payload?.coordinates)
    ? payload.coordinates
    : null;
  if (!cells) throw new Error('Malformed OVATION grid');
  const rows = Array.from({ length: ROWS }, () => new Array(360).fill(0));
  for (const cell of cells) {
    const lon = Math.round(Number(cell?.[0]));
    const lat = Math.round(Number(cell?.[1]));
    const chance = Number(cell?.[2]);
    if (lat < AURORA_SOUTH || lat > 90 || lon < 0 || lon > 359) continue;
    if (!Number.isFinite(chance)) continue;
    rows[lat - AURORA_SOUTH][lon] = Math.max(
      0,
      Math.min(100, Math.round(chance)),
    );
  }
  const time = (value) => {
    const ms = Date.parse(String(value ?? ''));
    return Number.isFinite(ms) ? ms : null;
  };
  return {
    observed: time(payload['Observation Time']),
    forecast: time(payload['Forecast Time']),
    rows,
  };
}

/** The newest Kp from the planetary K-index list, or null. */
export function latestKp(payload) {
  const list = Array.isArray(payload) ? payload : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const raw = list[i]?.Kp;
    if (raw == null || raw === '') continue;
    const kp = Number(raw);
    const at = Date.parse(`${String(list[i]?.time_tag ?? '')}Z`);
    if (Number.isFinite(kp)) return { kp, at: Number.isFinite(at) ? at : null };
  }
  return null;
}

/** The chance at a point (degrees, east positive), or 0 outside the band. */
export function chanceAt(grid, [lon, lat]) {
  const row = grid?.rows?.[Math.round(lat) - AURORA_SOUTH];
  if (!row) return 0;
  return row[((Math.round(lon) % 360) + 360) % 360] ?? 0;
}

/** A forecast for a time this far behind the clock is no longer the sky. */
export const AURORA_MAX_AGE_MS = 60 * 60_000;

/**
 * True when the grid is for a time over an hour past, as when NOAA keeps
 * answering with a file it has stopped renewing. Without a forecast time
 * the observation's stands in; without either there is nothing to judge.
 */
export function auroraOutdated(snapshot, nowMs) {
  const at = snapshot?.forecast ?? snapshot?.observed;
  return Number.isFinite(at) && nowMs - at > AURORA_MAX_AGE_MS;
}

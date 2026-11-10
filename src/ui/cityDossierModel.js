/**
 * The city dossier's pure parts: sunrise and sunset, the election year
 * behind Kolada's figures, the population trend, the police notices and the
 * air quality reading that belong to a town, and the wait for a layer's
 * first read. No DOM, no Cesium, no i18n.
 */
import { greatCircleKm } from '../geoDistance.js';

/** Swedish general elections fall every fourth year from 2022 (September). */
const ELECTION_ANCHOR = 2022;

/**
 * The municipal election a Kolada year's figures come from: Kolada repeats
 * the latest result each year until the next election.
 * @param {number} dataYear
 */
export function electionYear(dataYear) {
  if (!Number.isFinite(dataYear)) return null;
  return dataYear - ((((dataYear - ELECTION_ANCHOR) % 4) + 4) % 4);
}

/**
 * Change over a population series, first year to last.
 * @param {{year: number, value: number}[]} history
 */
export function populationChange(history) {
  const rows = (Array.isArray(history) ? history : []).filter(
    (row) => Number.isFinite(row?.year) && Number.isFinite(row?.value),
  );
  if (rows.length < 2) return null;
  const first = rows[0];
  const last = rows.at(-1);
  if (!first.value) return null;
  return {
    fromYear: first.year,
    toYear: last.year,
    change: last.value - first.value,
    percent: ((last.value - first.value) / first.value) * 100,
  };
}

/**
 * An SVG polyline for a population series in a `width`×`height` box, with a
 * little headroom so a flat series does not sit on the edge.
 */
export function sparklinePoints(history, width, height) {
  const rows = (Array.isArray(history) ? history : []).filter((row) =>
    Number.isFinite(row?.value),
  );
  if (rows.length < 2) return '';
  const values = rows.map((row) => row.value);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || Math.max(1, max * 0.01);
  const pad = height * 0.12;
  return rows
    .map((row, index) => {
      const x = (index / (rows.length - 1)) * width;
      const y = height - pad - ((row.value - min) / span) * (height - 2 * pad);
      return `${Math.round(x * 10) / 10},${Math.round(y * 10) / 10}`;
    })
    .join(' ');
}

const RAD = Math.PI / 180;

/**
 * Sunrise and sunset (NOAA's simplified solar position) for a day, as epoch
 * ms; `polar` is 'day' under the midnight sun and 'night' in the polar night.
 * Accurate to a minute or two, which is all a dossier line needs.
 * @param {number} lat Degrees north.
 * @param {number} lon Degrees east.
 * @param {number} dayMs Any instant on the (UTC) day wanted.
 */
export function sunTimes(lat, lon, dayMs) {
  const day = Math.floor(dayMs / 864e5);
  const noonUtc = day * 864e5 + 432e5;
  const julianCentury = (noonUtc / 864e5 + 2440587.5 - 2451545) / 36525;
  const meanLon = (280.46646 + julianCentury * 36000.76983) % 360;
  const meanAnomaly = 357.52911 + julianCentury * 35999.05029;
  const eccentricity = 0.016708634 - julianCentury * 0.000042037;
  const center =
    Math.sin(meanAnomaly * RAD) * (1.914602 - julianCentury * 0.004817) +
    Math.sin(2 * meanAnomaly * RAD) * 0.019993 +
    Math.sin(3 * meanAnomaly * RAD) * 0.000289;
  const apparentLon =
    meanLon +
    center -
    0.00569 -
    0.00478 * Math.sin((125.04 - 1934.136 * julianCentury) * RAD);
  const obliquity =
    23 +
    (26 + (21.448 - julianCentury * 46.815) / 60) / 60 +
    0.00256 * Math.cos((125.04 - 1934.136 * julianCentury) * RAD);
  const declination = Math.asin(
    Math.sin(obliquity * RAD) * Math.sin(apparentLon * RAD),
  );
  const y = Math.tan((obliquity / 2) * RAD) ** 2;
  const equationOfTime =
    (4 *
      (y * Math.sin(2 * meanLon * RAD) -
        2 * eccentricity * Math.sin(meanAnomaly * RAD) +
        4 *
          eccentricity *
          y *
          Math.sin(meanAnomaly * RAD) *
          Math.cos(2 * meanLon * RAD) -
        0.5 * y * y * Math.sin(4 * meanLon * RAD) -
        1.25 * eccentricity * eccentricity * Math.sin(2 * meanAnomaly * RAD))) /
    RAD;
  const cosHourAngle =
    Math.cos(90.833 * RAD) / (Math.cos(lat * RAD) * Math.cos(declination)) -
    Math.tan(lat * RAD) * Math.tan(declination);
  if (cosHourAngle < -1) return { rise: null, set: null, polar: 'day' };
  if (cosHourAngle > 1) return { rise: null, set: null, polar: 'night' };
  const hourAngle = Math.acos(cosHourAngle) / RAD;
  const solarNoonMin = 720 - 4 * lon - equationOfTime;
  const midnight = day * 864e5;
  return {
    rise: Math.round(midnight + (solarNoonMin - 4 * hourAngle) * 6e4),
    set: Math.round(midnight + (solarNoonMin + 4 * hourAngle) * 6e4),
    polar: null,
  };
}

const fold = (value) =>
  String(value ?? '')
    .toLocaleLowerCase('sv-SE')
    .replace(/\s+kommun$/, '')
    .trim();

/**
 * Police notices placed in a town's municipality over the last `windowMs`,
 * newest first. Polisen names the municipality ("Stockholm"); the town list
 * may carry it in the genitive ("Stockholms") or name the seat.
 * @param {object[]} events Normalized /api/polisen-events rows.
 * @param {{municipality: string, name: string}} city
 * @param {number} nowMs
 */
export function policeEventsFor(events, city, nowMs, windowMs = 864e5) {
  const names = new Set(
    [city.name, city.municipality, String(city.municipality).replace(/s$/, '')]
      .filter(Boolean)
      .map(fold),
  );
  return (Array.isArray(events) ? events : [])
    .filter(
      (event) =>
        event?.precision === 'municipality' &&
        names.has(fold(event.place)) &&
        Number.isFinite(event.time) &&
        nowMs - event.time <= windowMs &&
        event.time <= nowMs + 6e4,
    )
    .sort((a, b) => b.time - a.time);
}

/**
 * The air quality reading nearest a point within `maxKm`, or null.
 * @param {object[]} readings Rows with lat/lon (normalizeSmhiReadings).
 * @param {[number, number]} point [lon, lat]
 */
export function nearestReading(readings, point, maxKm = 30) {
  let best = null;
  for (const row of Array.isArray(readings) ? readings : []) {
    const km = greatCircleKm(
      { lat: point[1], lon: point[0] },
      { lat: row?.lat, lon: row?.lon },
    );
    if (km <= maxKm && (!best || km < best.km)) best = { row, km };
  }
  return best ? { ...best.row, km: best.km } : null;
}

/**
 * Ask `step` again and again until it answers: true or false ends the wait
 * with that answer, anything else waits `intervalMs` and asks once more.
 * False when `timeoutMs` has gone without an answer.
 * @param {() => boolean | undefined} step
 */
export async function pollUntil(
  step,
  {
    timeoutMs,
    intervalMs = 100,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  for (let waited = 0; ; waited += intervalMs) {
    const answer = step();
    if (answer === true || answer === false) return answer;
    if (waited >= timeoutMs) return false;
    await sleep(intervalMs);
  }
}

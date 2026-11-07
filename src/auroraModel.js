/**
 * Tonight's northern lights outlook (Swedish fork): when it is dark enough,
 * how strong the geomagnetic activity is forecast to be (NOAA's planetary
 * Kp, three-hourly), what Kp a latitude needs, and how cloudy the dark hours
 * look (SMHI, octas). Pure: the server and its tests share it.
 */

const HOUR_MS = 3_600_000;
/** The sky is dark enough below this solar elevation (degrees). */
export const DARK_ELEVATION = -10;
/** The outlook looks this far ahead for the coming dark spell. */
const HORIZON_MS = 24 * HOUR_MS;

/** The sun's elevation in degrees at a place and moment (NOAA's formula). */
export function solarElevation(lat, lon, ms) {
  const rad = Math.PI / 180;
  const days = ms / 86_400_000 - 10_957.5; // days since J2000.0
  const meanLon = (280.46 + 0.9856474 * days) % 360;
  const anomaly = ((357.528 + 0.9856003 * days) % 360) * rad;
  const eclipticLon =
    (meanLon + 1.915 * Math.sin(anomaly) + 0.02 * Math.sin(2 * anomaly)) * rad;
  const obliquity = (23.439 - 0.0000004 * days) * rad;
  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLon));
  const rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLon),
    Math.cos(eclipticLon),
  );
  const sidereal = ((280.46061837 + 360.98564736629 * days + lon) % 360) * rad;
  const hourAngle = sidereal - rightAscension;
  return (
    Math.asin(
      Math.sin(lat * rad) * Math.sin(declination) +
        Math.cos(lat * rad) * Math.cos(declination) * Math.cos(hourAngle),
    ) / rad
  );
}

/**
 * The Kp that usually brings the aurora overhead or low in the north at a
 * Swedish latitude: Kiruna needs little, Malmö a strong storm.
 */
export function requiredKp(lat) {
  if (lat >= 67) return 1;
  if (lat >= 65) return 2;
  if (lat >= 63) return 3;
  if (lat >= 61) return 4;
  if (lat >= 58) return 5;
  if (lat >= 56) return 6;
  return 7;
}

/**
 * The coming dark spell within a day: whole hours, from the first dark one
 * to the last before the light returns; null with no darkness (midnight sun,
 * or a summer night too light in the south).
 */
export function darkSpell(lat, lon, nowMs) {
  const start = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  let from = null;
  let to = null;
  for (let t = start; t <= start + HORIZON_MS; t += HOUR_MS) {
    const dark = solarElevation(lat, lon, t + HOUR_MS / 2) < DARK_ELEVATION;
    if (dark && from === null) from = t;
    if (!dark && from !== null) {
      to = t;
      break;
    }
  }
  if (from === null) return null;
  return { from, to: to ?? start + HORIZON_MS };
}

/** The Kp forecast for one moment: the three-hour slot it falls in. */
const kpAt = (series, ms) =>
  series.find((row) => row.time <= ms && ms < row.time + 3 * HOUR_MS)?.kp ??
  null;
/** The cloud cover for one moment: the nearest hourly forecast (octas). */
const cloudsAt = (clouds, ms) => {
  let best = null;
  for (const row of clouds)
    if (!best || Math.abs(row.time - ms) < Math.abs(best.time - ms)) best = row;
  return best && Math.abs(best.time - ms) <= 2 * HOUR_MS ? best.octas : null;
};

/**
 * Tonight's outlook at a place.
 * @param {{ kp: {time:number,kp:number,scale:?string}[],
 *   clouds: {time:number,octas:number}[], lat: number, lon: number,
 *   now: number }} input
 * @returns {{ level: 'none'|'low'|'possible'|'good'|'high', dark: ?{from:number,to:number},
 *   maxKp: ?number, requiredKp: number, cloudPct: ?number, best: ?number,
 *   scale: ?string }}
 */
export function auroraOutlook({ kp, clouds, lat, lon, now }) {
  const required = requiredKp(lat);
  const dark = darkSpell(lat, lon, now);
  const none = {
    level: 'none',
    dark,
    maxKp: null,
    requiredKp: required,
    cloudPct: null,
    best: null,
    scale: null,
  };
  if (!dark) return none;
  const hours = [];
  for (let t = Math.max(dark.from, now); t < dark.to; t += HOUR_MS)
    hours.push({ time: t, kp: kpAt(kp, t), octas: cloudsAt(clouds, t) });
  const known = hours.filter((hour) => hour.kp !== null);
  if (!known.length) return none;
  const maxKp = Math.max(...known.map((hour) => hour.kp));
  const covered = hours.filter((hour) => hour.octas !== null);
  const meanOctas = covered.length
    ? covered.reduce((sum, hour) => sum + hour.octas, 0) / covered.length
    : null;
  const clearness = meanOctas === null ? 0.5 : 1 - meanOctas / 8;
  // The best hour: the most activity under the least cloud.
  const best = known
    .map((hour) => ({
      time: hour.time,
      score: hour.kp - (hour.octas ?? 4) / 2,
    }))
    .sort((a, b) => b.score - a.score || a.time - b.time)[0].time;
  const margin = maxKp - required;
  const level =
    margin >= 1 && clearness >= 0.6
      ? 'high'
      : margin >= 0 && clearness >= 0.5
        ? 'good'
        : margin >= -1 && clearness >= 0.25
          ? 'possible'
          : 'low';
  return {
    level,
    dark,
    maxKp: Math.round(maxKp * 10) / 10,
    requiredKp: required,
    cloudPct: meanOctas === null ? null : Math.round((meanOctas / 8) * 100),
    best,
    scale:
      kp.find(
        (row) =>
          row.scale && row.time + 3 * HOUR_MS > dark.from && row.time < dark.to,
      )?.scale ?? null,
  };
}

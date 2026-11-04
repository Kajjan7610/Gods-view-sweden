/**
 * Sjöfartsverket ViVa sea weather: pure parsing shared by the server proxy
 * and the layer. No Cesium, no Node built-ins.
 *
 * ViVa (services.viva.sjofartsverket.se, open, no key) lists some 185
 * stations along the coast, the lakes and the canals — Sjöfartsverket's own,
 * SMHI's and ports' — and answers one station at a time with its latest
 * samples: mean wind and gusts, water level against mean water, water and
 * air temperature, waves, visibility and more, stamped in Swedish local time.
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

export function classOf(classes, value) {
  if (!Number.isFinite(value)) return null;
  return classes.find((entry) => value <= entry.max) || null;
}

/** The last number in a sample value: "SV 7.4" gives 7.4, "-18" gives -18. */
export function sampleNumber(value) {
  const matches = String(value ?? '').match(/-?\d+(?:[.,]\d+)?/g);
  if (!matches?.length) return null;
  const n = Number(matches.at(-1).replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

const STOCKHOLM_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Stockholm',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/**
 * "2026-11-04 22:45:00" in Swedish local time to epoch ms, with the offset
 * Stockholm keeps at that instant (CET or CEST).
 */
export function stockholmTime(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(
    String(value ?? ''),
  );
  if (!match) return null;
  const [, y, mo, d, h, mi, s = '0'] = match;
  const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
  const parts = STOCKHOLM_PARTS.formatToParts(asUtc);
  const get = (type) => Number(parts.find((p) => p.type === type)?.value);
  const shown = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - (shown - asUtc);
}

const text = (value, max) => {
  const s = String(value ?? '').trim();
  return s ? s.slice(0, max) : null;
};

/**
 * One station with the samples the layer shows; null without a place in
 * Sweden's waters or without any of wind, level or temperature.
 * @param {object} station {ID, Name, Lat, Lon} from the station list.
 * @param {object[]} samples GetSingleStationResult.Samples.
 */
export function normalizeSeaStation(station, samples) {
  const lat = Number(station?.Lat);
  const lon = Number(station?.Lon);
  if (station?.ID == null || !Number.isFinite(lat) || !Number.isFinite(lon))
    return null;
  if (lat < 54 || lat > 70 || lon < 9 || lon > 25) return null;
  const row = {
    id: String(station.ID).slice(0, 12),
    name: text(station.Name, 80) || String(station.ID),
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
  for (const sample of Array.isArray(samples) ? samples : []) {
    if (sample?.Quality && sample.Quality !== 'Ok') continue;
    const name = String(sample?.Name ?? '');
    const value = sampleNumber(sample?.Value);
    if (value == null) continue;
    const when = stockholmTime(sample.Updated);
    if (when && (!row.updated || when > row.updated)) row.updated = when;
    if (name === 'Medelvind') {
      row.meanWind = value;
      const heading = Number(sample.Heading);
      if (Number.isFinite(heading)) row.windHeading = heading;
    } else if (name === 'Byvind') row.gust = value;
    else if (name === 'Vattenstånd') {
      row.level = value;
      row.levelReference = text(sample.WaterLevelReference, 12);
    } else if (name === 'Vattentemp') row.waterTemp = value;
    else if (name === 'Lufttemp') row.airTemp = value;
    else if (name === 'Våghöjd') row.waveHeight = value;
    else if (name === 'Sikt') row.visibility = value;
  }
  const measured = [row.meanWind, row.level, row.waterTemp, row.airTemp];
  return measured.some((value) => value != null) ? row : null;
}

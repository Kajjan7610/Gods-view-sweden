/**
 * SMHI weather now and forecast: pure parsing shared by the server proxy and
 * the layer. No Cesium, no Node built-ins.
 *
 * Two open SMHI APIs (CC BY 4.0, no key):
 *   metobs — the latest hourly observation per station and parameter
 *     (air temperature 1, mean wind 4, gust 21, hourly precipitation 7);
 *   metfcst snow1g — the point forecast, hourly at first and then in longer
 *     steps for about ten days, with a weather symbol code (1–27).
 */

export const OBSERVATION_PARAMETERS = Object.freeze({
  airTemp: 1,
  wind: 4,
  gust: 21,
  precipitation: 7,
});
/** Observations older than this are not shown as "now". */
export const MAX_OBSERVATION_AGE_MS = 3 * 60 * 60_000;

/** The SMHI forecast grid covers the Nordic area; points outside are refused. */
export const FORECAST_BOUNDS = Object.freeze({
  west: 2,
  south: 52,
  east: 38,
  north: 72,
});

/** Weather symbol code (1–27) to an emoji, so no symbol text needs translating. */
export function symbolEmoji(code) {
  const n = Math.round(Number(code));
  if (n === 1) return '☀️';
  if (n === 2) return '🌤️';
  if (n === 3 || n === 4) return '⛅';
  if (n === 5 || n === 6) return '☁️';
  if (n === 7) return '🌫️';
  if (n >= 8 && n <= 10) return '🌦️';
  if (n === 11 || n === 21) return '⛈️';
  if ((n >= 12 && n <= 14) || (n >= 22 && n <= 24)) return '🌨️';
  if ((n >= 15 && n <= 17) || (n >= 25 && n <= 27)) return '❄️';
  if (n >= 18 && n <= 20) return '🌧️';
  return '';
}

// The forecast's days are Swedish days.
const DAY = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm' });

const finite = (value) => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * Merge per-parameter metobs answers into one row per station.
 * @param {{[field: string]: object}} answers field name → metobs JSON
 * @param {number} nowMs
 * @returns {object[]}
 */
export function mergeObservations(answers, nowMs) {
  const byKey = new Map();
  for (const [field, answer] of Object.entries(answers || {})) {
    for (const station of Array.isArray(answer?.station)
      ? answer.station
      : []) {
      const lat = finite(station?.latitude);
      const lon = finite(station?.longitude);
      if (lat == null || lon == null || station?.key == null) continue;
      const sample = Array.isArray(station.value) ? station.value.at(-1) : null;
      const value = finite(sample?.value);
      const at = finite(sample?.date);
      if (value == null || at == null || nowMs - at > MAX_OBSERVATION_AGE_MS)
        continue;
      const key = String(station.key).slice(0, 12);
      const row = byKey.get(key) || {
        id: key,
        name: String(station.name ?? key).slice(0, 80),
        point: [Math.round(lon * 1e4) / 1e4, Math.round(lat * 1e4) / 1e4],
        airTemp: null,
        wind: null,
        gust: null,
        precipitation: null,
        updated: null,
      };
      row[field] = value;
      if (!row.updated || at > row.updated) row.updated = at;
      byKey.set(key, row);
    }
  }
  return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name, 'sv'));
}

/**
 * Summarise a snow1g forecast: the next 24 hours and the following days.
 * @param {object} payload snow1g point JSON
 * @param {number} nowMs
 * @returns {{next24: object|null, days: object[], point: number[]|null}}
 */
export function summarizeForecast(payload, nowMs) {
  const steps = (Array.isArray(payload?.timeSeries) ? payload.timeSeries : [])
    .map((step) => ({ at: Date.parse(step?.time), data: step?.data || {} }))
    .filter((step) => Number.isFinite(step.at) && step.at >= nowMs - 3600e3)
    .sort((a, b) => a.at - b.at);
  const sumUp = (list, symbolAt) => {
    const temps = list
      .map((s) => finite(s.data.air_temperature))
      .filter((v) => v != null);
    const gusts = list
      .map((s) => finite(s.data.wind_speed_of_gust))
      .filter((v) => v != null);
    const rain = list
      .map((s) => finite(s.data.precipitation_amount_mean))
      .filter((v) => v != null && v >= 0);
    const symbols = list
      .map((s) => finite(s.data.symbol_code))
      .filter((v) => v != null);
    return temps.length
      ? {
          min: Math.min(...temps),
          max: Math.max(...temps),
          gust: gusts.length ? Math.max(...gusts) : null,
          precipitation: rain.length
            ? Math.round(rain.reduce((a, b) => a + b, 0) * 10) / 10
            : null,
          symbol: symbols[symbolAt(symbols.length)] ?? null,
        }
      : null;
  };
  // The first symbol speaks for the coming 24 hours, the midday one for a day.
  const next24 = sumUp(
    steps.filter((s) => s.at < nowMs + 24 * 3600e3),
    () => 0,
  );
  const midday = (count) => Math.floor(count / 2);
  const dayKey = (ms) => DAY.format(ms);
  const today = dayKey(nowMs);
  const groups = new Map();
  for (const step of steps) {
    const key = dayKey(step.at);
    if (key === today) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(step);
  }
  const days = [...groups.entries()]
    .slice(0, 4)
    .map(([day, list]) => ({ day, at: list[0].at, ...sumUp(list, midday) }))
    .filter((day) => day.min != null);
  const coords = payload?.geometry?.coordinates;
  return {
    next24,
    days,
    point: Array.isArray(coords) ? coords.slice(0, 2).map(Number) : null,
  };
}

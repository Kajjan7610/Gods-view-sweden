/**
 * Swedish electricity spot prices per bidding zone (SE1–SE4): pure parsing
 * shared by the server proxy and the layer. No Cesium, no Node built-ins.
 *
 * elprisetjustnu.se republishes the Nord Pool day-ahead price per zone as
 * free JSON (no key): one file per zone and day, in quarter-hours since the
 * 15-minute market, SEK and EUR per kWh, excluding VAT, grid fees and energy
 * tax. Tomorrow's prices appear after the auction, early afternoon.
 *
 * No open map of the zone borders is used: each zone is drawn as one labelled
 * point in a town well inside it.
 */

export const ELECTRICITY_ZONES = Object.freeze([
  Object.freeze({ id: 'SE1', name: 'Luleå', point: [22.15, 65.58] }),
  Object.freeze({ id: 'SE2', name: 'Sundsvall', point: [17.31, 62.39] }),
  Object.freeze({ id: 'SE3', name: 'Stockholm', point: [16.0, 59.5] }),
  Object.freeze({ id: 'SE4', name: 'Malmö', point: [13.6, 56.1] }),
]);

/** Price classes in SEK/kWh, cheapest first; max is inclusive of the class. */
export const PRICE_CLASSES = Object.freeze([
  Object.freeze({ id: 'very-low', max: 0.5, color: '#00e676' }),
  Object.freeze({ id: 'low', max: 1, color: '#c6ff00' }),
  Object.freeze({ id: 'medium', max: 2, color: '#ffd600' }),
  Object.freeze({ id: 'high', max: 3, color: '#ff9100' }),
  Object.freeze({ id: 'very-high', max: Infinity, color: '#ff1744' }),
]);

export function priceClass(sek) {
  if (!Number.isFinite(sek)) return null;
  return PRICE_CLASSES.find((entry) => sek <= entry.max) || null;
}

export function priceColor(sek) {
  return priceClass(sek)?.color || '#9e9e9e';
}

/** The day file URL for a zone, by the Stockholm calendar date. */
export function priceUrl(zone, ms) {
  const [year, month, day] = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Europe/Stockholm',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(ms)
    .split('-');
  return `https://www.elprisetjustnu.se/api/v1/prices/${year}/${month}-${day}_${zone}.json`;
}

/**
 * One day file to [{start, end, sek, eur}], sorted; junk rows dropped.
 * @param {object[]} payload
 */
export function normalizePriceDay(payload) {
  const rows = [];
  for (const row of Array.isArray(payload) ? payload : []) {
    const start = Date.parse(String(row?.time_start ?? ''));
    const end = Date.parse(String(row?.time_end ?? ''));
    const sek = Number(row?.SEK_per_kWh);
    const eur = Number(row?.EUR_per_kWh);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
      continue;
    if (!Number.isFinite(sek)) continue;
    rows.push({
      start,
      end,
      sek: Math.round(sek * 1e4) / 1e4,
      eur: Number.isFinite(eur) ? Math.round(eur * 1e5) / 1e5 : null,
    });
  }
  return rows.sort((a, b) => a.start - b.start).slice(0, 200);
}

/**
 * Lowest, highest and mean price of a day, with when the extremes fall.
 * @param {object[]} rows From normalizePriceDay.
 */
export function summarizeDay(rows) {
  if (!rows?.length) return null;
  let min = rows[0];
  let max = rows[0];
  let sum = 0;
  for (const row of rows) {
    if (row.sek < min.sek) min = row;
    if (row.sek > max.sek) max = row;
    sum += row.sek;
  }
  return {
    min: min.sek,
    minAt: min.start,
    max: max.sek,
    maxAt: max.start,
    mean: Math.round((sum / rows.length) * 1e4) / 1e4,
  };
}

/** The interval that holds `ms`, or null. */
export function priceAt(rows, ms) {
  return rows?.find((row) => row.start <= ms && ms < row.end) || null;
}

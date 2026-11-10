/**
 * Sweden's power system from the ENTSO-E Transparency Platform: the same
 * answers the control-room proxy gives (records.js), built from documented
 * data. A reserve source, used only when the server is told to (see
 * server/providers/powerGridEntsoe.js). Pure parsing shared by the server
 * proxy and its tests. No Cesium, no Node built-ins.
 *
 * Three data items, all published per bidding zone at the latest an hour
 * after the operating period:
 *   Physical flows [12.1.G] (documentType A11), one series per direction of
 *     each border; CC BY 4.0 on ENTSO-E's list of data free for re-use.
 *   Actual generation per production type [16.1.B&C] (A75, processType A16)
 *     and actual total load [6.1.A] (A65, processType A16); not on that list,
 *     so their re-use needs the data owner's (Svenska kraftnät's) consent.
 */
import { LINKS, isSwedish } from './records.js';

export const ENTSOE_API_URL = 'https://web-api.tp.entsoe.eu/api';

/** Energy Identification Codes of the areas the Swedish links join. */
export const ENTSOE_AREAS = Object.freeze({
  SE1: '10Y1001A1001A44P',
  SE2: '10Y1001A1001A45N',
  SE3: '10Y1001A1001A46L',
  SE4: '10Y1001A1001A47J',
  FI: '10YFI-1--------U',
  NO1: '10YNO-1--------2',
  NO3: '10YNO-3--------J',
  NO4: '10YNO-4--------9',
  DK1: '10YDK-1--------W',
  DK2: '10YDK-2--------M',
  // Baltic Cable lands in the German-Luxembourg bidding zone.
  DE: '10Y1001A1001A82H',
  PL: '10YPL-AREA-----S',
  LT: '10YLT-1001A0008Q',
});

/** The Swedish bidding zones whose production and load make up Sweden's. */
export const SWEDISH_ZONES = Object.freeze(['SE1', 'SE2', 'SE3', 'SE4']);

/** ENTSO-E production types (psrType) to the control room's types. */
const TYPE_OF_PSR = Object.freeze({
  B14: 'nuclear',
  B10: 'hydro',
  B11: 'hydro',
  B12: 'hydro',
  B18: 'wind',
  B19: 'wind',
  // Biomass, fossil fuels, geothermal and waste: thermal power.
  B01: 'thermal',
  B02: 'thermal',
  B03: 'thermal',
  B04: 'thermal',
  B05: 'thermal',
  B06: 'thermal',
  B07: 'thermal',
  B08: 'thermal',
  B09: 'thermal',
  B17: 'thermal',
});
const PRODUCTION_KEYS = Object.freeze([
  'nuclear',
  'hydro',
  'thermal',
  'wind',
  'unspecified',
]);

const QUARTER_MS = 15 * 60_000;
const RESOLUTION_MS = Object.freeze({
  PT15M: QUARTER_MS,
  PT30M: 2 * QUARTER_MS,
  PT60M: 4 * QUARTER_MS,
});
/** Positions read from one period at most: a week of quarter-hours and some. */
const MAX_POSITIONS = 1000;

/** "202611101200": a UTC time as the API's periodStart and periodEnd read it. */
export function entsoeTime(ms) {
  return new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 12);
}

/** One query to the API; the token is added by the caller, never logged. */
export function entsoeQuery(params) {
  return new URLSearchParams(
    Object.entries(params).filter(([, value]) => value != null),
  );
}

const tag = (name) =>
  new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([^<]*)</(?:\\w+:)?${name}>`);
const blocks = (name, text) =>
  text.match(
    new RegExp(
      `<(?:\\w+:)?${name}\\b[^>]*>[\\s\\S]*?</(?:\\w+:)?${name}>`,
      'g',
    ),
  ) || [];
const first = (name, text) => tag(name).exec(text)?.[1]?.trim() ?? null;

/**
 * Whether an answer is ENTSO-E's "no matching data" acknowledgement (reason
 * 999), which is an empty answer, not a failure. Any other acknowledgement
 * throws with its reason text.
 * @param {string} xml
 * @returns {boolean}
 */
export function isNoDataAnswer(xml) {
  const text = String(xml ?? '');
  if (!/Acknowledgement_MarketDocument/.test(text)) return false;
  const code = first('code', text);
  if (code === '999') return true;
  const reason = first('text', text) || 'refused';
  throw new Error(`ENTSO-E refused the query: ${reason.slice(0, 200)}`);
}

/**
 * The time series of an answer, each as quarter-hour points. A coarser
 * resolution is spread over its quarters; a variable-sized block (curveType
 * A03) holds its value until the next position or the period's end.
 * @param {string} xml
 * @returns {Array<{inArea: string|null, outArea: string|null,
 *   psrType: string|null, points: Map<number, number>}>}
 */
export function parseEntsoeSeries(xml) {
  const text = String(xml ?? '');
  if (isNoDataAnswer(text)) return [];
  const series = [];
  for (const block of blocks('TimeSeries', text)) {
    const points = new Map();
    const curve = first('curveType', block) || 'A01';
    for (const period of blocks('Period', block)) {
      const start = Date.parse(first('start', period) ?? '');
      const end = Date.parse(first('end', period) ?? '');
      const step = RESOLUTION_MS[first('resolution', period)];
      if (!Number.isFinite(start) || !Number.isFinite(end) || !step) continue;
      const count = Math.min(MAX_POSITIONS, Math.round((end - start) / step));
      const values = blocks('Point', period)
        .map((point) => [
          Number(first('position', point)),
          Number(first('quantity', point)),
        ])
        .filter(
          ([position, value]) =>
            Number.isInteger(position) &&
            position >= 1 &&
            position <= count &&
            Number.isFinite(value),
        )
        .sort((a, b) => a[0] - b[0]);
      values.forEach(([position, value], index) => {
        const last =
          curve === 'A03'
            ? (values[index + 1]?.[0] ?? count + 1) - 1
            : position;
        for (let at = position; at <= last; at += 1)
          for (let quarter = 0; quarter < step; quarter += QUARTER_MS)
            points.set(start + (at - 1) * step + quarter, value);
      });
    }
    series.push({
      inArea:
        first('inBiddingZone_Domain.mRID', block) ||
        first('in_Domain.mRID', block),
      outArea:
        first('outBiddingZone_Domain.mRID', block) ||
        first('out_Domain.mRID', block),
      psrType: first('psrType', block),
      points,
    });
  }
  return series;
}

/** Every Swedish link with the EICs of its two ends, as records.js names it. */
export const ENTSOE_LINKS = Object.freeze(
  LINKS.map((link) =>
    Object.freeze({
      ...link,
      aCode: ENTSOE_AREAS[link.a],
      bCode: ENTSOE_AREAS[link.b],
    }),
  ),
);

/** The flow from one area to another at each quarter, summed over series. */
function directed(series) {
  const sum = new Map();
  for (const one of series)
    for (const [at, value] of one.points)
      sum.set(at, (sum.get(at) ?? 0) + value);
  return sum;
}

/**
 * The flows answer, as records.js's normalizeFlows gives it, from the two
 * directions of every link: `byLink` maps a link id to {aToB, bToA}, each the
 * parsed series of that direction. A link is read at its newest quarter where
 * every direction that publishes has a value; a link with no data is left out.
 * @param {Map<string, {aToB: object[], bToA: object[]}>} byLink
 */
export function flowsFromEntsoe(byLink) {
  const links = [];
  const totals = new Map();
  let updated = null;
  for (const link of ENTSOE_LINKS) {
    const pair = byLink.get(link.id);
    if (!pair) continue;
    const ab = directed(pair.aToB);
    const ba = directed(pair.bToA);
    const sides = [ab, ba].filter((side) => side.size);
    if (!sides.length) continue;
    const times = [...sides[0].keys()]
      .filter((at) => sides.every((side) => side.has(at)))
      .sort((a, b) => b - a);
    if (!times.length) continue;
    const at = times[0];
    const value = (ab.get(at) ?? 0) - (ba.get(at) ?? 0);
    const forward = value >= 0;
    const from = forward ? link.a : link.b;
    const to = forward ? link.b : link.a;
    const mw = Math.round(Math.abs(value));
    links.push({
      id: link.id,
      from,
      to,
      fromPoint: forward ? link.aPoint : link.bPoint,
      toPoint: forward ? link.bPoint : link.aPoint,
      place: link.place,
      mw,
      kind:
        isSwedish(from) && isSwedish(to)
          ? 'internal'
          : isSwedish(to)
            ? 'import'
            : 'export',
    });
    for (const [area, side] of [
      [to, 'import'],
      [from, 'export'],
    ])
      if (isSwedish(area)) {
        const entry = totals.get(area) ?? { id: area, import: 0, export: 0 };
        entry[side] += mw;
        totals.set(area, entry);
      }
    updated = Math.max(updated ?? at, at);
  }
  return {
    links: links.sort((a, b) => a.id.localeCompare(b.id)),
    areas: [...totals.values()].sort((a, b) => a.id.localeCompare(b.id)),
    updated,
  };
}

/**
 * Sweden's quarter-hours, oldest first, as records.js's
 * normalizeProductionDay gives them: MW per type, total, consumption and net
 * (positive when Sweden exports). Generation and load are given per zone;
 * a quarter counts only when all four zones report both, so a zone that
 * publishes late never shows as a dip.
 * @param {Map<string, object[]>} generationByZone Parsed A75 series per zone.
 * @param {Map<string, object[]>} loadByZone Parsed A65 series per zone.
 * @returns {Array<{at: number} & Record<string, number>>}
 */
export function productionFromEntsoe(generationByZone, loadByZone) {
  const byTime = new Map();
  const zonesAt = new Map();
  for (const zone of SWEDISH_ZONES) {
    const seen = new Set();
    // A series with an out-area only is consumption (pumped storage) in A75.
    for (const series of generationByZone.get(zone) ?? []) {
      if (!series.inArea && series.outArea) continue;
      const type = TYPE_OF_PSR[series.psrType] ?? 'unspecified';
      for (const [at, value] of series.points) {
        const entry = byTime.get(at) ?? { at };
        entry[type] = (entry[type] ?? 0) + value;
        byTime.set(at, entry);
        seen.add(at);
      }
    }
    const load = directed(loadByZone.get(zone) ?? []);
    for (const [at, value] of load) {
      if (!seen.has(at)) continue;
      const entry = byTime.get(at);
      entry.consumption = (entry.consumption ?? 0) + value;
      zonesAt.set(at, (zonesAt.get(at) ?? 0) + 1);
    }
  }
  const points = [];
  for (const [at, entry] of byTime) {
    if (zonesAt.get(at) !== SWEDISH_ZONES.length) continue;
    const row = { at };
    let total = 0;
    for (const key of PRODUCTION_KEYS)
      if (Number.isFinite(entry[key])) {
        row[key] = Math.round(entry[key]);
        total += entry[key];
      }
    row.total = Math.round(total);
    row.consumption = Math.round(entry.consumption);
    row.net = row.total - row.consumption;
    points.push(row);
  }
  return points.sort((a, b) => a.at - b.at);
}

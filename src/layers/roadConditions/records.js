/**
 * Trafikverket (Sweden) road conditions and traffic incidents: pure parsing
 * shared by the server proxy and the layer. No Cesium, no Node built-ins.
 *
 * Two object types of Trafikverket's open traffic API (CC0 1.0) feed this:
 *   RoadCondition (Road.TrafficInfo 1.3) — winter road surface per stretch,
 *     published 1 November to 30 April;
 *   Situation (Road.TrafficInfo 1.6) — Deviation[] events: accidents,
 *     roadworks, obstacles, restrictions, traffic messages, ferries.
 */

export const ROAD_CONDITION_CODES = Object.freeze({
  1: Object.freeze({ id: 'normal', color: '#4caf50' }),
  2: Object.freeze({ id: 'difficult', color: '#ffb300' }),
  3: Object.freeze({ id: 'very-difficult', color: '#ff3b30' }),
  4: Object.freeze({ id: 'ice-snow', color: '#64b5f6' }),
});
export const UNKNOWN_CONDITION_COLOR = '#9e9e9e';

/**
 * Incident kinds, in legend order. `match` reads the Swedish MessageType;
 * closure and minor have none because they come from the MessageCode (see
 * incidentKind). Blue is left to the ice-and-snow road condition alone.
 */
export const INCIDENT_KINDS = Object.freeze([
  Object.freeze({ id: 'accident', match: /olycka/i, color: '#ff1744' }),
  // Drawn white with a heavy red ring, like a no-entry sign.
  Object.freeze({ id: 'closure', match: null, color: '#ffffff' }),
  Object.freeze({ id: 'obstacle', match: /hinder/i, color: '#ff9100' }),
  Object.freeze({ id: 'roadwork', match: /vägarbete/i, color: '#ffd600' }),
  Object.freeze({
    id: 'important',
    match: /viktig trafikinformation/i,
    color: '#e040fb',
  }),
  Object.freeze({ id: 'restriction', match: /restriktion/i, color: '#ab47bc' }),
  Object.freeze({ id: 'ferry', match: /färj/i, color: '#1de9b6' }),
  Object.freeze({
    id: 'message',
    match: /trafikmeddelande/i,
    color: '#b0bec5',
  }),
  // Speed limits, lane closures and the like that ride along with roadworks;
  // hidden by default because they outnumber everything else.
  Object.freeze({ id: 'minor', match: null, color: '#78909c' }),
]);
/** MessageCode texts that mean the road is closed. */
const CLOSURE_CODE = /vägen avstängd|avstängd väg/i;
/** Traffic-message codes that are routine consequences of roadworks. */
const MINOR_CODE =
  /hastighetsbegränsning|körfältsavstängning|omkörning förbjuden|viktbegränsning|bärighetsbegränsning/i;
/** Traffic-message codes that are hazards on the road. */
const HAZARD_CODE = /fordonshaveri|djur på vägen|vägskada|hinder/i;
export const OTHER_INCIDENT = Object.freeze({ id: 'other', color: '#9e9e9e' });

export const MAX_CONDITIONS = 20000;
export const MAX_INCIDENTS = 10000;
const MAX_POINTS_PER_LINE = 400;
/** Vertices closer than this to the previous kept one are dropped. */
const MIN_VERTEX_SPACING_M = 30;
const MAX_TEXT = 400;

export function conditionColor(code) {
  return ROAD_CONDITION_CODES[code]?.color || UNKNOWN_CONDITION_COLOR;
}

const kindById = (id) => INCIDENT_KINDS.find((kind) => kind.id === id);

/**
 * Legend kind for one Deviation. Accidents win; a closed road is a closure
 * whatever its type; a traffic message is then sorted by its code.
 * @param {string} messageType e.g. "Trafikmeddelande"
 * @param {string} [messageCode] e.g. "Vägen avstängd"
 */
export function incidentKind(messageType, messageCode = '') {
  const type = String(messageType ?? '');
  const code = String(messageCode ?? '');
  if (/olycka/i.test(type)) return kindById('accident');
  if (CLOSURE_CODE.test(code)) return kindById('closure');
  if (/trafikmeddelande/i.test(type)) {
    if (MINOR_CODE.test(code)) return kindById('minor');
    if (HAZARD_CODE.test(code)) return kindById('obstacle');
  }
  return (
    INCIDENT_KINDS.find((kind) => kind.match?.test(type)) || OTHER_INCIDENT
  );
}

export function incidentColor(kindId) {
  return (
    INCIDENT_KINDS.find((kind) => kind.id === kindId)?.color ||
    OTHER_INCIDENT.color
  );
}

const text = (value, max = MAX_TEXT) => {
  const s = String(value ?? '').trim();
  return s ? s.slice(0, max) : null;
};
const texts = (value) =>
  (Array.isArray(value) ? value : value == null ? [] : [value])
    .map((entry) => text(entry, 200))
    .filter(Boolean)
    .slice(0, 8);
const time = (value) => {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : null;
};

function plausible([lon, lat]) {
  return (
    Number.isFinite(lon) &&
    Number.isFinite(lat) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    !(Math.abs(lat) < 1e-6 && Math.abs(lon) < 1e-6)
  );
}

function pointsOf(body) {
  return body
    .split(',')
    .map((pair) => pair.trim().split(/\s+/).slice(0, 2).map(Number))
    .filter((point) => point.length === 2 && plausible(point));
}

/**
 * Parse the WKT Trafikverket publishes: POINT, LINESTRING, MULTILINESTRING
 * (an optional Z/M dimension is ignored).
 * @param {string} wkt
 * @returns {{point: number[]|null, lines: number[][][]}}
 */
export function parseWkt(wkt) {
  const source = String(wkt ?? '').trim();
  const match =
    /^(POINT|LINESTRING|MULTILINESTRING)\s*(?:Z|M|ZM)?\s*\((.*)\)$/i.exec(
      source,
    );
  if (!match) return { point: null, lines: [] };
  const type = match[1].toUpperCase();
  if (type === 'POINT') {
    const [point] = pointsOf(match[2]);
    return { point: point || null, lines: [] };
  }
  const bodies =
    type === 'LINESTRING'
      ? [match[2]]
      : match[2].split(/\)\s*,\s*\(/).map((part) => part.replace(/[()]/g, ''));
  return {
    point: null,
    lines: bodies.map(pointsOf).filter((line) => line.length >= 2),
  };
}

/**
 * Thin a road line for drawing: 5 decimals (~1 m), vertices at least
 * MIN_VERTEX_SPACING_M apart, at most MAX_POINTS_PER_LINE, ends kept.
 * @param {number[][]} line
 * @returns {number[][]}
 */
export function simplifyLine(line) {
  const round = ([lon, lat]) => [
    Math.round(lon * 1e5) / 1e5,
    Math.round(lat * 1e5) / 1e5,
  ];
  if (line.length <= 2) return line.map(round);
  const kept = [line[0]];
  for (let i = 1; i < line.length - 1; i++) {
    const [lon0, lat0] = kept[kept.length - 1];
    const [lon, lat] = line[i];
    const dx = (lon - lon0) * 111320 * Math.cos((lat * Math.PI) / 180);
    const dy = (lat - lat0) * 110540;
    if (Math.hypot(dx, dy) >= MIN_VERTEX_SPACING_M) kept.push(line[i]);
  }
  kept.push(line[line.length - 1]);
  let out = kept;
  if (out.length > MAX_POINTS_PER_LINE) {
    const step = (out.length - 1) / (MAX_POINTS_PER_LINE - 1);
    out = Array.from(
      { length: MAX_POINTS_PER_LINE },
      (_, i) => out[Math.round(i * step)],
    );
  }
  return out.map(round);
}

/**
 * One RoadCondition record -> one drawable stretch, or null.
 * @param {object} record
 * @returns {object|null}
 */
export function normalizeRoadCondition(record) {
  if (!record || typeof record !== 'object' || record.Deleted === true)
    return null;
  const id = text(record.Id, 120);
  const { lines } = parseWkt(record.Geometry?.WGS84);
  if (!id || !lines.length) return null;
  const code = Number.isInteger(record.ConditionCode)
    ? record.ConditionCode
    : null;
  return {
    id,
    code,
    text: text(record.ConditionText, 80),
    info: texts(record.ConditionInfo),
    warnings: texts(record.Warning),
    measures: texts(record.Measure),
    causes: texts(record.Cause),
    road: text(record.RoadNumber, 40),
    location: text(record.LocationText, 200),
    start: time(record.StartTime),
    end: time(record.EndTime),
    lines: lines.map(simplifyLine),
  };
}

/**
 * One Situation Deviation -> one incident, or null when it is suspended,
 * not yet started or already over at `nowMs`.
 * @param {object} deviation
 * @param {number} nowMs
 * @returns {object|null}
 */
export function normalizeDeviation(deviation, nowMs) {
  if (!deviation || typeof deviation !== 'object') return null;
  if (deviation.Suspended === true) return null;
  const id = text(deviation.Id, 120);
  if (!id) return null;
  const start = time(deviation.StartTime);
  const end = time(deviation.EndTime);
  const untilFurtherNotice = deviation.ValidUntilFurtherNotice === true;
  if (start !== null && start > nowMs) return null;
  if (!untilFurtherNotice && end !== null && end < nowMs) return null;
  const geometry = deviation.Geometry || {};
  const point =
    parseWkt(geometry.Point?.WGS84).point || parseWkt(geometry.WGS84).point;
  const { lines } = parseWkt(geometry.Line?.WGS84);
  const anchor = point || lines[0]?.[Math.floor(lines[0].length / 2)] || null;
  if (!anchor) return null;
  const kind = incidentKind(deviation.MessageType, deviation.MessageCode);
  const severity = Number.isInteger(deviation.SeverityCode)
    ? deviation.SeverityCode
    : null;
  let link = text(deviation.WebLink, 500);
  try {
    if (link && !/^https?:$/.test(new URL(link).protocol)) link = null;
  } catch {
    link = null;
  }
  return {
    id,
    kind: kind.id,
    type: text(deviation.MessageType, 60),
    code: text(deviation.MessageCode, 80),
    header: text(deviation.Header, 200),
    message: text(deviation.Message),
    severity,
    severityText: text(deviation.SeverityText, 80),
    road: text(deviation.RoadNumber, 40),
    location: text(deviation.LocationDescriptor, 200),
    restriction: text(deviation.TrafficRestrictionType, 120),
    start,
    end,
    untilFurtherNotice,
    link,
    point: [
      Math.round(anchor[0] * 1e5) / 1e5,
      Math.round(anchor[1] * 1e5) / 1e5,
    ],
    lines: lines.map(simplifyLine),
  };
}

/**
 * Normalize the two-query API answer (RoadCondition first, Situation second).
 * @param {object} payload Parsed JSON body.
 * @param {number} nowMs
 * @returns {{conditions: object[], incidents: object[], truncated: boolean}}
 */
export function normalizeRoadSnapshot(payload, nowMs) {
  const results = Array.isArray(payload?.RESPONSE?.RESULT)
    ? payload.RESPONSE.RESULT
    : [];
  const failure = results.find((result) => result?.ERROR);
  if (failure) {
    const error = new Error(
      `Trafikverket refused the query: ${String(
        failure.ERROR.MESSAGE || failure.ERROR.SOURCE || 'error',
      ).slice(0, 200)}`,
    );
    error.status = failure.ERROR.SOURCE === 'Security' ? 401 : 400;
    throw error;
  }
  const records = results.flatMap((result) =>
    Array.isArray(result?.RoadCondition) ? result.RoadCondition : [],
  );
  const situations = results.flatMap((result) =>
    Array.isArray(result?.Situation) ? result.Situation : [],
  );
  const conditions = [];
  for (const record of records) {
    if (conditions.length >= MAX_CONDITIONS) break;
    const row = normalizeRoadCondition(record);
    if (row) conditions.push(row);
  }
  const incidents = [];
  const seen = new Set();
  for (const situation of situations) {
    if (situation?.Deleted === true) continue;
    for (const deviation of situation?.Deviation || []) {
      if (incidents.length >= MAX_INCIDENTS) break;
      const row = normalizeDeviation(deviation, nowMs);
      if (!row || seen.has(row.id)) continue;
      seen.add(row.id);
      incidents.push(row);
    }
  }
  return {
    conditions,
    incidents,
    truncated:
      records.length > MAX_CONDITIONS || incidents.length >= MAX_INCIDENTS,
  };
}

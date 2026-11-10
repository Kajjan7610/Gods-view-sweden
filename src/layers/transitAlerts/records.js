/**
 * Public-transport disruptions in Sweden from the regional operators'
 * GTFS-RT ServiceAlerts (Trafiklab GTFS Regional): pure helpers shared by the
 * server proxy and the layer. No Cesium, no Node built-ins.
 *
 * Nearly every alert names the stops it touches; the proxy places it at the
 * stop area those platforms belong to, from the operator's static GTFS, and
 * gathers the alerts of one stop area into one row.
 */
import { PbfReader } from 'pbf';

/** GTFS-RT Alert.Effect values that mean the stop is not served. */
const NO_SERVICE_EFFECTS = new Set([1, 2]);
const STOP_MOVED_EFFECT = 9;
const CLOSED_TEXT =
  /stängd|avstängd|inställd|indrag|stannar (?:inte|ej)|trafiker(?:ar|as) (?:inte|ej)|ersätt|no service|cancel/i;
/**
 * A closed lift, escalator or entrance: the station is still served. Read
 * from the heading, which names what is closed.
 */
const FACILITY_TEXT =
  /hiss|rulltrapp|entré|uppgång|ingång|toalett|väntsal|biljettautomat/i;
const MOVED_TEXT = /flytta|flyttad|tillfällig hållplats|moved/i;

/** Disruption kinds, most serious first, with their colour. */
export const ALERT_KINDS = Object.freeze([
  Object.freeze({ id: 'closed', color: '#ff5252' }),
  Object.freeze({ id: 'moved', color: '#ffd740' }),
  Object.freeze({ id: 'other', color: '#40c4ff' }),
]);
const KIND_RANK = new Map(ALERT_KINDS.map((kind, index) => [kind.id, index]));
const KIND_COLOR = new Map(ALERT_KINDS.map((kind) => [kind.id, kind.color]));

export function alertColor(kind) {
  return KIND_COLOR.get(kind) || '#9e9e9e';
}

/** The more serious of two kinds. */
export function worseKind(a, b) {
  return (KIND_RANK.get(a) ?? 9) <= (KIND_RANK.get(b) ?? 9) ? a : b;
}

/**
 * What an alert does to its stops, from its effect or, as most Swedish
 * operators leave the effect unset, from its Swedish text.
 * @param {{effect?: number, header?: string, description?: string}} alert
 */
export function classifyAlert(alert) {
  if (NO_SERVICE_EFFECTS.has(alert.effect)) return 'closed';
  if (alert.effect === STOP_MOVED_EFFECT) return 'moved';
  const text = `${alert.header || ''} ${alert.description || ''}`;
  if (MOVED_TEXT.test(text)) return 'moved';
  if (FACILITY_TEXT.test(alert.header || alert.description || ''))
    return 'other';
  if (CLOSED_TEXT.test(text)) return 'closed';
  return 'other';
}

/** Whether any of an alert's periods holds `nowSec` (none = always). */
export function isActive(periods, nowSec) {
  if (!periods?.length) return true;
  return periods.some(
    ({ start = 0, end = 0 }) =>
      (!start || start <= nowSec) && (!end || nowSec <= end),
  );
}

// ── GTFS-RT decoding (FeedMessage → alerts) ────────────────────────────────
// FeedMessage 2 entity; FeedEntity 1 id, 5 alert; Alert 1 active_period,
// 5 informed_entity, 6 cause, 7 effect, 10 header_text, 11 description_text;
// TimeRange 1 start, 2 end; EntitySelector 2 route_id, 5 stop_id;
// TranslatedString 1 translation; Translation 1 text, 2 language.

const MAX_ALERTS = 5000;
const MAX_TEXT = 2000;

function readTranslation(tag, out, pbf) {
  if (tag === 1) out.text = pbf.readString().slice(0, MAX_TEXT);
  else if (tag === 2) out.language = pbf.readString().slice(0, 16);
}
function readTranslated(tag, out, pbf) {
  if (tag === 1) out.push(pbf.readMessage(readTranslation, {}));
}
function readRange(tag, out, pbf) {
  if (tag === 1) out.start = pbf.readVarint();
  else if (tag === 2) out.end = pbf.readVarint();
}
function readSelector(tag, out, pbf) {
  if (tag === 2) out.route = pbf.readString().slice(0, 64);
  else if (tag === 5) out.stop = pbf.readString().slice(0, 64);
}
function readAlert(tag, alert, pbf) {
  if (tag === 1) alert.periods.push(pbf.readMessage(readRange, {}));
  else if (tag === 5) alert.entities.push(pbf.readMessage(readSelector, {}));
  else if (tag === 6) alert.cause = pbf.readVarint();
  else if (tag === 7) alert.effect = pbf.readVarint();
  else if (tag === 10) alert.headerText = pbf.readMessage(readTranslated, []);
  else if (tag === 11)
    alert.descriptionText = pbf.readMessage(readTranslated, []);
}
function readEntity(tag, entity, pbf) {
  if (tag === 1) entity.id = pbf.readString().slice(0, 128);
  else if (tag === 5)
    entity.alert = pbf.readMessage(readAlert, { periods: [], entities: [] });
}
function readFeed(tag, feed, pbf) {
  if (tag === 2 && feed.entity.length < MAX_ALERTS)
    feed.entity.push(pbf.readMessage(readEntity, {}));
}

/** Swedish text if there is one, else the first translation. */
function pickText(translations) {
  if (!translations?.length) return '';
  const swedish = translations.find((one) => /^sv/i.test(one.language || 'sv'));
  return String((swedish || translations[0]).text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A ServiceAlerts feed to plain alerts.
 * @param {Uint8Array} bytes
 * @returns {Array<{id: string, header: string, description: string,
 *   effect: number|null, periods: object[], stopIds: string[]}>}
 */
export function decodeServiceAlerts(bytes) {
  const feed = new PbfReader(bytes).readFields(readFeed, { entity: [] });
  const alerts = [];
  for (const entity of feed.entity) {
    const alert = entity.alert;
    if (!alert || !entity.id) continue;
    alerts.push({
      id: entity.id,
      header: pickText(alert.headerText).slice(0, 200),
      description: pickText(alert.descriptionText).slice(0, 600),
      effect: Number.isFinite(alert.effect) ? alert.effect : null,
      periods: alert.periods,
      stopIds: [
        ...new Set(alert.entities.map((one) => one.stop).filter(Boolean)),
      ],
    });
  }
  return alerts;
}

/**
 * Active alerts placed at their stop areas: one row per stop area with its
 * alerts, most serious kind first. Alerts whose stops are unknown are left
 * out.
 * @param {object[]} alerts From decodeServiceAlerts.
 * @param {Map<string, [number, number, string, string]>} stops
 * @param {{operator: string, operatorName: string, nowSec: number}} context
 */
export function placeAlerts(alerts, stops, { operator, operatorName, nowSec }) {
  const rows = new Map();
  for (const alert of alerts) {
    if (!isActive(alert.periods, nowSec)) continue;
    const kind = classifyAlert(alert);
    const ends = alert.periods
      .map((period) => period.end)
      .filter((end) => end > 0);
    for (const stopId of alert.stopIds) {
      const stop = stops.get(stopId);
      if (!stop) continue;
      const area = stop[3] && stops.get(stop[3]) ? stop[3] : stopId;
      const [lon, lat, name] = stops.get(area);
      const id = `${operator}:${area}`;
      let row = rows.get(id);
      if (!row) {
        row = {
          id,
          name: name || stop[2],
          point: [lon, lat],
          operator,
          operatorName,
          kind,
          alerts: [],
        };
        rows.set(id, row);
      }
      if (row.alerts.some((one) => one.id === alert.id)) continue;
      row.kind = worseKind(row.kind, kind);
      row.alerts.push({
        id: alert.id,
        kind,
        header: alert.header,
        description: alert.description,
        endsAt: ends.length ? Math.max(...ends) * 1000 : null,
      });
    }
  }
  for (const row of rows.values())
    row.alerts.sort((a, b) => KIND_RANK.get(a.kind) - KIND_RANK.get(b.kind));
  return [...rows.values()];
}

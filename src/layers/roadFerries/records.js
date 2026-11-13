/**
 * Trafikverket's road ferries: pure parsing shared by the server proxy and
 * the layer. No Cesium, no Node built-ins.
 *
 * Trafikverket's open API (CC0 1.0) describes each ferry route (FerryRoute:
 * name, one map point, its harbours) and its departures (FerryAnnouncement:
 * time, from and to harbour, notes), and the ferry messages among its traffic
 * situations (Situation, message type "Färjor"). One request asks for all
 * three; the answers arrive in that order.
 */

/** Departures kept per route, soonest first. */
export const DEPARTURES_PER_ROUTE = 4;
/** How far ahead departures are asked for. */
export const LOOK_AHEAD_MS = 3 * 3600_000;
/** A departure stays listed this long after its time. */
export const GRACE_MS = 2 * 60_000;

export const ROUTE_COLOR = '#29b6f6';
export const MESSAGE_COLOR = '#ffb300';
export const IDLE_COLOR = '#78909c';

const text = (value, max = 120) => {
  const s = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s ? s.slice(0, max) : null;
};

/** A WKT "POINT (lon lat)" as [lon, lat], or null outside Sweden's waters. */
export function pointOf(wkt) {
  const match = /POINT\s*\(\s*([-\d.]+)\s+([-\d.]+)\s*\)/.exec(
    String(wkt ?? ''),
  );
  if (!match) return null;
  const lon = Number(match[1]);
  const lat = Number(match[2]);
  return lon >= 10 && lon <= 25 && lat >= 55 && lat <= 69.5 ? [lon, lat] : null;
}

/**
 * The ferry messages by deviation id. Every route has a standing deviation
 * whose header is only the route's name; only one with a message says
 * something.
 */
export function ferryMessages(situations) {
  const byId = new Map();
  for (const situation of Array.isArray(situations) ? situations : []) {
    if (situation?.Deleted === true) continue;
    for (const deviation of Array.isArray(situation?.Deviation)
      ? situation.Deviation
      : []) {
      const id = text(deviation?.Id, 80);
      const message = text(deviation?.Message, 240);
      if (id && message) byId.set(id, message);
    }
  }
  return byId;
}

/** One departure, or null when it has no time or is gone. */
export function normalizeDeparture(row, nowMs) {
  if (row?.Deleted === true) return null;
  const at = Date.parse(String(row?.DepartureTime ?? ''));
  if (!Number.isFinite(at) || at < nowMs - GRACE_MS) return null;
  if (at > nowMs + LOOK_AHEAD_MS) return null;
  return {
    routeId: Number(row?.Route?.Id),
    at,
    from: text(row?.FromHarbor?.Name, 60),
    to: text(row?.ToHarbor?.Name, 60),
    info: (Array.isArray(row?.Info) ? row.Info : [])
      .map((line) => text(line, 120))
      .filter(Boolean)
      .slice(0, 2),
    deviationId: text(row?.DeviationId, 80),
  };
}

/** A route's own short status for the legend and the dot. */
export function routeStatus(route) {
  if (route.messages.length) return 'message';
  return route.departures.length ? 'running' : 'idle';
}

export function statusColor(status) {
  return status === 'message'
    ? MESSAGE_COLOR
    : status === 'idle'
      ? IDLE_COLOR
      : ROUTE_COLOR;
}

/**
 * Every ferry route with a place, its next departures and messages.
 * @param {object} payload Trafikverket's answer to the three queries.
 * @param {number} nowMs
 */
export function normalizeFerrySnapshot(payload, nowMs) {
  const results = Array.isArray(payload?.RESPONSE?.RESULT)
    ? payload.RESPONSE.RESULT
    : [];
  const messages = ferryMessages(results[2]?.Situation);
  const departures = new Map();
  for (const row of Array.isArray(results[1]?.FerryAnnouncement)
    ? results[1].FerryAnnouncement
    : []) {
    const departure = normalizeDeparture(row, nowMs);
    if (!departure || !Number.isFinite(departure.routeId)) continue;
    if (!departures.has(departure.routeId))
      departures.set(departure.routeId, []);
    departures.get(departure.routeId).push(departure);
  }
  const routes = [];
  for (const row of Array.isArray(results[0]?.FerryRoute)
    ? results[0].FerryRoute
    : []) {
    if (row?.Deleted === true) continue;
    const id = Number(row?.Id);
    const point = pointOf(row?.Geometry?.WGS84);
    const name = text(row?.Name, 80);
    if (!Number.isFinite(id) || !point || !name) continue;
    const own = (departures.get(id) || [])
      .sort((a, b) => a.at - b.at)
      .slice(0, DEPARTURES_PER_ROUTE);
    const ids = [
      text(row.DeviationId, 80),
      ...own.map((departure) => departure.deviationId),
    ].filter(Boolean);
    const routeMessages = [
      ...new Set(ids.map((key) => messages.get(key)).filter(Boolean)),
    ].slice(0, 3);
    const harbors = (Array.isArray(row.Harbor) ? row.Harbor : [])
      .slice()
      .sort((a, b) => (Number(a?.SortOrder) || 0) - (Number(b?.SortOrder) || 0))
      .map((harbor) => text(harbor?.Name, 60))
      .filter(Boolean);
    const route = {
      id: String(id),
      name,
      shortName: text(row.Shortname, 20),
      type: text(row.Type?.Name, 40),
      point,
      harbors: [...new Set(harbors)],
      departures: own.map(({ at, from, to, info }) => ({ at, from, to, info })),
      messages: routeMessages,
    };
    route.status = routeStatus(route);
    routes.push(route);
  }
  routes.sort((a, b) => a.name.localeCompare(b.name, 'sv'));
  return { routes };
}

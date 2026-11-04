/**
 * Sveriges Radio traffic messages: pure parsing shared by the server proxy
 * and the layer. No Cesium, no Node built-ins.
 *
 * api.sr.se/api/v2/traffic/messages (open, no key) carries the traffic
 * reports SR's traffic desks read on air — road incidents, public-transport
 * disruptions, planned works — each with a point, a priority from 1 (very
 * serious) to 5 (minor) and a category. Content © Sveriges Radio, shown as
 * published with SR credited.
 */

/** Priorities, most serious first. */
export const SR_PRIORITIES = Object.freeze([
  Object.freeze({ id: 1, color: '#ff1744' }),
  Object.freeze({ id: 2, color: '#ff9100' }),
  Object.freeze({ id: 3, color: '#ffd600' }),
  Object.freeze({ id: 4, color: '#40c4ff' }),
  Object.freeze({ id: 5, color: '#b0bec5' }),
]);
/** SR's category numbers. */
export const SR_CATEGORIES = Object.freeze({
  0: 'road',
  1: 'transit',
  2: 'planned',
  3: 'other',
});
export const MAX_SR_MESSAGES = 2000;

export function priorityColor(priority) {
  return (
    SR_PRIORITIES.find((entry) => entry.id === priority)?.color || '#b0bec5'
  );
}

const text = (value, max) => {
  const s = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s ? s.slice(0, max) : null;
};

/** "/Date(1793804400033+0100)/" (epoch ms plus a zone note) to ms, or null. */
export function parseSrDate(value) {
  const match = /Date\((-?\d+)/.exec(String(value ?? ''));
  const ms = match ? Number(match[1]) : Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

/** One message, or null without an id or a place in Sweden's neighbourhood. */
export function normalizeSrMessage(message) {
  const id = message?.id;
  const lat = Number(message?.latitude);
  const lon = Number(message?.longitude);
  if (id == null || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < 54 || lat > 70 || lon < 9 || lon > 25) return null;
  const priority = Number(message.priority);
  return {
    id: String(id).slice(0, 20),
    point: [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5],
    priority: priority >= 1 && priority <= 5 ? priority : 5,
    category: SR_CATEGORIES[message.category] || 'other',
    kind: text(message.subcategory, 60),
    title: text(message.title, 160),
    location: text(message.exactlocation, 200),
    description: text(message.description, 800),
    created: parseSrDate(message.createddate),
  };
}

/**
 * Normalize the API answer, most serious and newest first.
 * @param {object} payload
 * @returns {{messages: object[], truncated: boolean}}
 */
export function normalizeSrMessages(payload) {
  const list = Array.isArray(payload?.messages) ? payload.messages : null;
  if (!list) throw new Error('Malformed SR traffic messages');
  const messages = [];
  const seen = new Set();
  for (const message of list.slice(0, MAX_SR_MESSAGES)) {
    const row = normalizeSrMessage(message);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    messages.push(row);
  }
  messages.sort(
    (a, b) => a.priority - b.priority || (b.created ?? 0) - (a.created ?? 0),
  );
  return { messages, truncated: list.length > MAX_SR_MESSAGES };
}

/**
 * Krisinformation.se (MCF) crisis messages: pure parsing shared by the server
 * proxy and the warnings layer. No Cesium, no Node built-ins.
 *
 * Two lists of the open API (no key, Swedish text): /v3/vmas, the VMA
 * ("Viktigt meddelande till allmänheten") in effect, and /v3/news, the
 * authorities' crisis news of the last days. Each names its areas — the
 * country, a county or a municipality — usually without a coordinate, so the
 * proxy places it at the municipality seat, the mean of a county's seats, or
 * the middle of Sweden for the whole country. An item that names no Swedish
 * area (news about abroad, or no area at all) is drawn there too, but says so.
 */

/** Roughly the geographic middle of Sweden (Flataklocken, Ånge). */
export const SWEDEN_CENTRE = Object.freeze([16.32, 62.39]);
export const CRISIS_KINDS = Object.freeze([
  Object.freeze({ id: 'vma', color: '#ff1744' }),
  Object.freeze({ id: 'news', color: '#40c4ff' }),
]);
export const MAX_CRISIS_ITEMS = 100;
/**
 * News neither published nor updated for this long is dropped: /v3/news?days=3
 * still answers with older items.
 */
export const CRISIS_NEWS_MAX_AGE_MS = 3 * 24 * 60 * 60_000;

/** County codes (the first two digits of a municipality code) to names. */
export const SWEDISH_COUNTIES = Object.freeze({
  '01': 'Stockholms län',
  '03': 'Uppsala län',
  '04': 'Södermanlands län',
  '05': 'Östergötlands län',
  '06': 'Jönköpings län',
  '07': 'Kronobergs län',
  '08': 'Kalmar län',
  '09': 'Gotlands län',
  10: 'Blekinge län',
  12: 'Skåne län',
  13: 'Hallands län',
  14: 'Västra Götalands län',
  17: 'Värmlands län',
  18: 'Örebro län',
  19: 'Västmanlands län',
  20: 'Dalarnas län',
  21: 'Gävleborgs län',
  22: 'Västernorrlands län',
  23: 'Jämtlands län',
  24: 'Västerbottens län',
  25: 'Norrbottens län',
});

const fold = (value) =>
  String(value ?? '')
    .normalize('NFC')
    .toLocaleLowerCase('sv-SE')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * County centres as the mean of their municipality seats.
 * @param {Array<[string, string, string, number, number]>} rows
 * @returns {(name: string) => [number, number] | null}
 */
export function createCountyLookup(rows) {
  const sums = new Map();
  for (const [code, , , lon, lat] of rows || []) {
    const name = SWEDISH_COUNTIES[String(code).slice(0, 2)];
    if (!name) continue;
    const sum = sums.get(name) || [0, 0, 0];
    sums.set(name, [sum[0] + lon, sum[1] + lat, sum[2] + 1]);
  }
  const centres = new Map(
    [...sums].map(([name, [lon, lat, n]]) => [
      fold(name),
      [Math.round((lon / n) * 1e4) / 1e4, Math.round((lat / n) * 1e4) / 1e4],
    ]),
  );
  return (name) => {
    const key = fold(name);
    return centres.get(key) || centres.get(`${key} län`) || null;
  };
}

const text = (value, max) => {
  const s = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s ? s.slice(0, max) : null;
};

/** A coordinate the API may give: {Latitude, Longitude} or "lat,lon". */
function coordinateOf(area) {
  const object = area?.coordinateObject;
  const lat = Number(object?.latitude ?? object?.Latitude);
  const lon = Number(object?.longitude ?? object?.Longitude);
  if (Number.isFinite(lat) && Number.isFinite(lon) && (lat || lon))
    return [lon, lat];
  const numbers = String(area?.coordinate ?? '')
    .split(/[\s,;]+/)
    .map(Number)
    .filter(Number.isFinite);
  if (numbers.length < 2) return null;
  // Swedish latitudes are 55–69; longitudes 10–25.
  const [a, b] = numbers;
  return a > 50 ? [b, a] : [a, b];
}

/**
 * Where an item is drawn and how exact that is.
 * @returns {{point: number[], place: string|null, scope: 'point'|'municipality'|'county'|'country'|'unplaced'}}
 */
export function placeCrisisItem(areas, { places, counties }) {
  const list = Array.isArray(areas) ? areas : [];
  for (const area of list) {
    const point = coordinateOf(area);
    if (point)
      return { point, place: text(area.description, 80), scope: 'point' };
  }
  for (const area of list) {
    const type = String(area?.type ?? '').toLowerCase();
    const name = text(area?.description, 80);
    if (!name) continue;
    if (type === 'municipality') {
      const point = places?.(name.replace(/ kommun$/i, ''));
      if (point) return { point, place: name, scope: 'municipality' };
    }
    if (type === 'county') {
      const point = counties?.(name);
      if (point) return { point, place: name, scope: 'county' };
    }
  }
  const country = list.find((area) => /country/i.test(area?.type ?? ''));
  const named = text(country?.description, 80);
  if (country && (!named || /^(sverige|sweden)$/i.test(named)))
    return {
      point: [...SWEDEN_CENTRE],
      place: named || 'Sverige',
      scope: 'country',
    };
  // Another country, an area the gazetteer does not know, or no area at all:
  // not "all of Sweden". The card names what the item names, if anything.
  const other = list.map((area) => text(area?.description, 80)).find(Boolean);
  return {
    point: [...SWEDEN_CENTRE],
    place: named || other || null,
    scope: 'unplaced',
  };
}

/**
 * Normalize the two lists into drawable items, VMAs first, newest first.
 * @param {{vmas: object[], news: object[]}} lists
 * @param {{places: Function, counties: Function}} lookups
 * @param {number} [nowMs] With it, news past CRISIS_NEWS_MAX_AGE_MS drops.
 * @returns {object[]}
 */
export function normalizeCrisisItems({ vmas = [], news = [] }, lookups, nowMs) {
  const items = [];
  const seen = new Set();
  for (const [kind, list] of [
    ['vma', vmas],
    ['news', news],
  ]) {
    for (const entry of Array.isArray(list) ? list : []) {
      if (items.length >= MAX_CRISIS_ITEMS) break;
      const id = text(entry?.identifier ?? entry?.contentId, 40);
      const headline = text(entry?.headline, 200);
      if (!id || !headline || seen.has(`${kind}:${id}`)) continue;
      seen.add(`${kind}:${id}`);
      const published = Date.parse(String(entry.published ?? ''));
      const updated = Date.parse(String(entry.updated ?? ''));
      const latest = Math.max(
        Number.isFinite(published) ? published : -Infinity,
        Number.isFinite(updated) ? updated : -Infinity,
      );
      if (
        kind === 'news' &&
        Number.isFinite(nowMs) &&
        Number.isFinite(latest) &&
        nowMs - latest > CRISIS_NEWS_MAX_AGE_MS
      )
        continue;
      const web = text(entry.web, 400);
      items.push({
        id: `${kind}:${id}`,
        kind,
        headline,
        preamble: text(entry.preamble, 600),
        sender: text(entry.senderName, 120),
        published: Number.isFinite(published) ? published : null,
        updated: Number.isFinite(updated) ? updated : null,
        link: web && /^https:\/\//i.test(web) ? web : null,
        ...placeCrisisItem(entry.area, lookups),
      });
    }
  }
  return items.sort(
    (a, b) =>
      (a.kind === 'vma' ? 0 : 1) - (b.kind === 'vma' ? 0 : 1) ||
      (b.published ?? 0) - (a.published ?? 0),
  );
}

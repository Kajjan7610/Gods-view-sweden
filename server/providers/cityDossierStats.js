import { readResponseJsonCapped } from './common/http.js';

// The city dossier's STATISTICS tab: a handful of Kolada key figures for
// every municipality, read in one paginated request a day. One table answers
// every town: its own value, Sweden's, and where it places among the
// municipalities. Kolada's terms: free, even commercially, credited
// "Källa: Kolada"; a value we compute ourselves (the placing) must not be
// credited to Kolada. Each figure names its original producer (BRÅ,
// Skolverket and others) in Kolada's own description.

export const KOLADA_DATA_URL = 'https://api.kolada.se/v3/data/kpi';
const USER_AGENT =
  'GodsEyeView-Sweden/0.1 (https://github.com/Kajjan7610/Gods-view-sweden)';

/** The figures, by the name the dossier gives them, in the tab's order. */
export const STAT_KPIS = Object.freeze([
  ['meritValue', 'N15504'],
  ['pupilsPerTeacher', 'N15033'],
  ['reportedCrimes', 'N07540'],
  ['violentCrimes', 'N07403'],
  ['lifeWomen', 'N00925'],
  ['lifeMen', 'N00923'],
  ['sickDays', 'N00938'],
  ['debtors', 'N00989'],
  ['newFirms', 'N00999'],
  ['emissions', 'N00401'],
  ['protectedNature', 'N85054'],
  ['guestNights', 'N45850'],
]);
/** Years asked for: the figures are published one to two years behind. */
const YEARS_BACK = 3;
/** A year counts once this many municipalities have a value for it. */
export const MIN_MUNICIPALITIES = 200;
/** Kolada's code for Sweden as a whole. */
const SWEDEN = '0000';
const TABLE_TTL_MS = 24 * 60 * 60_000;
const RETRY_AFTER_FAILURE_MS = 5 * 60_000;
/** Longest a failed refresh keeps serving the last table. */
const STALE_MAX_MS = 3 * 24 * 60 * 60_000;
const MAX_PAGES = 10;
const MAX_BODY_BYTES = 12 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

const finite = (value) =>
  value == null || value === '' || !Number.isFinite(Number(value))
    ? null
    : Number(value);

/** The URLs of one read: every municipality, then Sweden as a whole. */
export function statsUrls(thisYear) {
  const years = Array.from(
    { length: YEARS_BACK + 1 },
    (_, i) => thisYear - YEARS_BACK + i,
  ).join(',');
  const ids = STAT_KPIS.map(([, id]) => id).join(',');
  return {
    municipalities: `${KOLADA_DATA_URL}/${ids}/year/${years}?region_type=municipality&per_page=5000`,
    sweden: `${KOLADA_DATA_URL}/${ids}/municipality/${SWEDEN}/year/${years}`,
  };
}

/**
 * Kolada's rows as kpi → year → municipality → value: the total (T), never
 * one gender alone, and no deleted values.
 * @param {object[]} rows MunicipalityData rows from every page.
 */
export function statsTable(rows) {
  const table = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const code = String(row?.municipality ?? '');
    const year = finite(row?.period);
    if (!/^\d{4}$/.test(code) || year == null) continue;
    const values = Array.isArray(row.values) ? row.values : [];
    // The total; a figure not split by gender has only that.
    const total = values.find(
      (entry) => entry?.gender === 'T' || entry?.gender == null,
    );
    const value = total?.isdeleted ? null : finite(total?.value);
    if (value == null) continue;
    if (!table.has(row.kpi)) table.set(row.kpi, new Map());
    const years = table.get(row.kpi);
    if (!years.has(year)) years.set(year, new Map());
    years.get(year).set(code, value);
  }
  return table;
}

/**
 * One municipality's figures: for each, the newest year most municipalities
 * have, the town's value, Sweden's, and its place counted from the highest
 * (ties share a place). A figure the town lacks that year is left out.
 */
export function statsFor(table, code) {
  const stats = [];
  for (const [key, kpi] of STAT_KPIS) {
    const years = table.get(kpi);
    if (!years) continue;
    const year = [...years.keys()]
      .sort((a, b) => b - a)
      .find((candidate) => {
        const byCode = years.get(candidate);
        const municipalities = [...byCode.keys()].filter((c) => c !== SWEDEN);
        return municipalities.length >= MIN_MUNICIPALITIES;
      });
    if (year == null) continue;
    const byCode = years.get(year);
    const value = byCode.get(code);
    if (value == null || code === SWEDEN) continue;
    const others = [...byCode.entries()]
      .filter(([c]) => c !== SWEDEN)
      .map(([, v]) => v);
    stats.push({
      key,
      kpi,
      year,
      value,
      sweden: byCode.get(SWEDEN) ?? null,
      rank: 1 + others.filter((v) => v > value).length,
      count: others.length,
    });
  }
  return stats;
}

/** The daily table, read from Kolada page by page and shared by every town. */
export function createKoladaStats({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let cached = null;
  let retryAfter = 0;
  let pending = null;

  async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { Accept: 'application/json', 'User-Agent': USER_AGENT },
      });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw new Error(`Kolada HTTP ${response.status}`);
      }
      return await readResponseJsonCapped(response, MAX_BODY_BYTES);
    } finally {
      clearTimeout(timer);
    }
  }

  async function load() {
    const urls = statsUrls(new Date(now()).getUTCFullYear());
    const rows = [];
    let url = urls.municipalities;
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const body = await getJson(url);
      if (!Array.isArray(body?.values))
        throw new Error('Malformed Kolada answer');
      rows.push(...body.values);
      // Only Kolada's own next page is followed.
      url =
        typeof body.next_url === 'string' &&
        body.next_url.startsWith(KOLADA_DATA_URL)
          ? body.next_url
          : null;
    }
    // Sweden as a whole, for comparison; the figures stand without it.
    try {
      const sweden = await getJson(urls.sweden);
      if (Array.isArray(sweden?.values)) rows.push(...sweden.values);
    } catch (error) {
      console.warn(`[city-dossier] Kolada Sweden failed: ${error?.message}`);
    }
    const table = statsTable(rows);
    if (!table.size) throw new Error('No Kolada figures');
    return table;
  }

  /** The table, or null when Kolada has not answered and nothing is kept. */
  async function table() {
    const fresh = cached && now() - cached.savedAt < TABLE_TTL_MS;
    if (fresh || now() < retryAfter) return tableIfCurrent();
    pending ??= load()
      .then((value) => {
        cached = { value, savedAt: now() };
        retryAfter = 0;
        console.log(`[city-dossier] Kolada statistics: ${value.size} figures`);
      })
      .catch((error) => {
        console.warn(
          `[city-dossier] Kolada statistics failed: ${error?.message || error}`,
        );
        retryAfter = now() + RETRY_AFTER_FAILURE_MS;
      })
      .finally(() => {
        pending = null;
      });
    await pending;
    return tableIfCurrent();
  }

  const tableIfCurrent = () =>
    cached && now() - cached.savedAt <= STALE_MAX_MS
      ? { table: cached.value, savedAt: cached.savedAt }
      : null;

  return {
    /** A municipality's figures: {stats, fetchedAt} or null. */
    async forMunicipality(code) {
      const current = await table();
      return current
        ? { stats: statsFor(current.table, code), fetchedAt: current.savedAt }
        : null;
    },
  };
}

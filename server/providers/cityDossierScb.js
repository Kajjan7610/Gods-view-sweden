// SCB's population figures for the city dossier (open PxWebApi 2.0, no key):
// the town's population year by year inside its latest boundary, and the
// municipality's population at the end of the latest month. Version 1 of
// the API stops at the turn of 2026/2027; version 2 answers in JSON-stat 2.0
// and allows 30 requests per 10 seconds per address.

export const SCB_API = 'https://statistikdatabasen.scb.se/api/v2';
/**
 * Table titles; the newest matching table (by last period) is used. The
 * search itself takes a few words: a whole title finds nothing.
 */
export const SCB_TOWN_TITLE =
  'Förtätning och utglesning av tätorter, folkmängd efter tätortens basår och tätort';
export const SCB_MONTHLY_TITLE =
  'Folkmängden per månad efter region, ålder och kön';
const SEARCH = Object.freeze({
  [SCB_TOWN_TITLE]: 'förtätning utglesning tätorter',
  [SCB_MONTHLY_TITLE]: 'folkmängden per månad',
});

const fold = (value) =>
  String(value ?? '')
    .trim()
    .toLocaleLowerCase('sv-SE');

/**
 * The town codes SCB gives a town in a municipality: codes start with the
 * municipality code ("2180TC108"), names are matched without case or
 * padding. The first name that matches wins.
 * @param {{values: string[], valueTexts: string[]}} variable SCB's Region variable.
 * @param {string} code Municipality code.
 * @param {string[]} names Candidate town names, most likely first.
 */
export function townCode(variable, code, names) {
  const values = Array.isArray(variable?.values) ? variable.values : [];
  const texts = Array.isArray(variable?.valueTexts) ? variable.valueTexts : [];
  for (const name of names.filter(Boolean).map(fold)) {
    const index = values.findIndex(
      (value, i) =>
        String(value).startsWith(`${code}T`) && fold(texts[i]) === name,
    );
    if (index >= 0) return values[index];
  }
  return null;
}

/**
 * The newest table in a v2 table search whose title starts so: a series is
 * split into tables by period ("År 2025M01-2026M09"), so the one with the
 * latest last period wins.
 * @param {{tables?: object[]}} listing GET /tables?query=… answer.
 */
export function newestTable(listing, titleStart) {
  const tables = (Array.isArray(listing?.tables) ? listing.tables : []).filter(
    (row) =>
      !row?.discontinued &&
      String(row?.label ?? '').startsWith(titleStart) &&
      typeof row.id === 'string',
  );
  tables.sort((a, b) =>
    String(b.lastPeriod ?? '').localeCompare(String(a.lastPeriod ?? '')),
  );
  return tables[0]?.id ?? null;
}

/** A JSON-stat dimension as v1-style parallel code and text lists. */
export function dimensionValues(metadata, id) {
  const category = metadata?.dimension?.[id]?.category;
  const index = category?.index ?? {};
  const codes = Array.isArray(index)
    ? index
    : Object.keys(index).sort((a, b) => index[a] - index[b]);
  return {
    values: codes,
    valueTexts: codes.map((code) => category?.label?.[code] ?? code),
  };
}

const cellValue = (cell) =>
  cell == null || String(cell).trim() === '' ? NaN : Number(cell);

/** The answer's single period, e.g. "2025" or "2026M09". */
const periodOf = (payload) =>
  dimensionValues(payload, 'Tid').values.at(-1) ?? '';

/**
 * The town's latest population from a JSON-stat answer queried for one
 * town, one boundary and the latest year.
 */
export function normalizeTownAnswer(payload) {
  // An empty cell is no count, never a town of 0.
  const value = cellValue(payload?.value?.[0]);
  const year = Number(periodOf(payload));
  return Number.isFinite(value) && Number.isFinite(year) && year > 0
    ? { value, year }
    : null;
}

/**
 * The municipality's population, men and women at the end of the latest
 * month, from a JSON-stat answer queried with Kon = TotSa, 1, 2.
 */
export function normalizeMonthlyAnswer(payload) {
  const values = Array.isArray(payload?.value) ? payload.value : [];
  // Every other dimension holds one value, so the cells follow Kon's order.
  const sexes = dimensionValues(payload, 'Kon').values;
  const bySex = new Map();
  sexes.forEach((sex, i) => {
    const value = cellValue(values[i]);
    if (Number.isFinite(value)) bySex.set(String(sex), value);
  });
  const match = /^(\d{4})M(\d{2})$/.exec(periodOf(payload));
  const total = bySex.get('TotSa');
  if (!match || !Number.isFinite(total)) return null;
  return {
    value: total,
    men: bySex.get('1') ?? null,
    women: bySex.get('2') ?? null,
    year: Number(match[1]),
    month: Number(match[2]),
  };
}

/** A data address selecting one value list per variable. */
export function dataUrl(table, selections) {
  const params = new URLSearchParams({
    lang: 'sv',
    outputFormat: 'json-stat2',
  });
  for (const [code, values] of selections)
    params.set(`valuecodes[${code}]`, values.join(','));
  return `${SCB_API}/tables/${table}/data?${params}`;
}

/**
 * SCB lookups over one JSON fetcher. Each table is found by title and its
 * metadata (some 2,800 towns) read once per process.
 * @param {(url: string, init?: object) => Promise<any>} getJson
 */
export function createScbPopulation(getJson) {
  let town = null;
  let monthly = null;

  /** The newest table with this title and its metadata, read once. */
  const tableOnce = (title) =>
    (async () => {
      const id = newestTable(
        await getJson(
          `${SCB_API}/tables?lang=sv&pageSize=50&query=${encodeURIComponent(SEARCH[title] ?? title)}`,
        ),
        title,
      );
      if (!id) throw new Error(`no SCB table "${title}"`);
      return {
        id,
        meta: await getJson(`${SCB_API}/tables/${id}/metadata?lang=sv`),
      };
    })();

  async function townPopulation(code, names) {
    town ||= tableOnce(SCB_TOWN_TITLE).catch((error) => {
      town = null;
      throw error;
    });
    const { id, meta } = await town;
    const place = townCode(dimensionValues(meta, 'Region'), code, names);
    const boundaries = dimensionValues(meta, 'BasarTatort').values;
    const contents = dimensionValues(meta, 'ContentsCode');
    // The table also holds land area; the population is "Folkmängd".
    const population =
      contents.values[
        contents.valueTexts.findIndex((text) => fold(text) === 'folkmängd')
      ] ?? contents.values[0];
    if (!place || !boundaries.length || !population) return null;
    return normalizeTownAnswer(
      await getJson(
        dataUrl(id, [
          ['Region', [place]],
          ['BasarTatort', [boundaries.at(-1)]],
          ['ContentsCode', [population]],
          ['Tid', ['top(1)']],
        ]),
      ),
    );
  }

  async function municipalityPopulation(code) {
    monthly ||= tableOnce(SCB_MONTHLY_TITLE).catch((error) => {
      monthly = null;
      throw error;
    });
    const { id, meta } = await monthly;
    const ages = dimensionValues(meta, 'Alder').values;
    const age = ages.find((value) => /^tot/i.test(value)) ?? ages[0];
    const contents = dimensionValues(meta, 'ContentsCode').values[0];
    if (!age || !contents) return null;
    return normalizeMonthlyAnswer(
      await getJson(
        dataUrl(id, [
          ['Region', [code]],
          ['Alder', [age]],
          ['Kon', ['TotSa', '1', '2']],
          ['ContentsCode', [contents]],
          ['Tid', ['top(1)']],
        ]),
      ),
    );
  }

  return { townPopulation, municipalityPopulation };
}

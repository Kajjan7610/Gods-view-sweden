// SCB's population figures for the city dossier (open PxWeb API, no key):
// the town's population year by year inside its latest boundary, and the
// municipality's population at the end of the latest month.

export const SCB_API = 'https://api.scb.se/OV0104/v1/doris/sv/ssd';
/** Town population per year within each delimitation's boundary. */
export const SCB_TOWN_TABLE = `${SCB_API}/MI/MI0810/MI0810A/FortatUtglesRegion`;
/** The folder whose newest "per month" table holds monthly population. */
export const SCB_POPULATION_FOLDER = `${SCB_API}/BE/BE0101/BE0101A`;

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

/** The newest table in a PxWeb folder listing whose title starts so. */
export function newestTable(listing, titleStart) {
  const tables = (Array.isArray(listing) ? listing : []).filter(
    (row) =>
      row?.type === 't' &&
      String(row.text ?? '').startsWith(titleStart) &&
      typeof row.id === 'string',
  );
  tables.sort((a, b) =>
    String(b.updated ?? '').localeCompare(String(a.updated ?? '')),
  );
  return tables[0]?.id ?? null;
}

/**
 * The town's latest population from a PxWeb answer queried for one town,
 * one boundary and the latest year.
 */
export function normalizeTownAnswer(payload) {
  const row = payload?.data?.[0];
  const cell = row?.values?.[0];
  // An empty cell is no count, never a town of 0.
  const value = cell == null || String(cell).trim() === '' ? NaN : Number(cell);
  const year = Number(row?.key?.at(-1));
  return Number.isFinite(value) && Number.isFinite(year)
    ? { value, year }
    : null;
}

/**
 * The municipality's population, men and women at the end of the latest
 * month, from a PxWeb answer queried with Kon = TotSa, 1, 2.
 */
export function normalizeMonthlyAnswer(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const bySex = new Map();
  let month = null;
  for (const row of rows) {
    const key = Array.isArray(row?.key) ? row.key : [];
    const value = Number(row?.values?.[0]);
    if (!Number.isFinite(value)) continue;
    // key: [region, age, sex, "2026M08"]
    bySex.set(String(key[2]), value);
    month = String(key.at(-1) ?? '');
  }
  const match = /^(\d{4})M(\d{2})$/.exec(month ?? '');
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

const query = (selections) => ({
  query: selections.map(([code, values, filter = 'item']) => ({
    code,
    selection: { filter, values },
  })),
  response: { format: 'json' },
});

/**
 * SCB lookups over one JSON fetcher. The town table's metadata (some 2,800
 * towns) and the monthly table's name are read once per process.
 * @param {(url: string, init?: object) => Promise<any>} getJson
 */
export function createScbPopulation(getJson) {
  let townMeta = null;
  let monthly = null;

  async function townPopulation(code, names) {
    townMeta ||= getJson(SCB_TOWN_TABLE).catch((error) => {
      townMeta = null;
      throw error;
    });
    const meta = await townMeta;
    const variable = (code) =>
      meta?.variables?.find((entry) => entry.code === code);
    const town = townCode(variable('Region'), code, names);
    const boundaries = variable('BasarTatort')?.values ?? [];
    const contents = variable('ContentsCode')?.values?.[0];
    if (!town || !boundaries.length || !contents) return null;
    return normalizeTownAnswer(
      await getJson(SCB_TOWN_TABLE, {
        method: 'POST',
        body: query([
          ['Region', [town]],
          ['BasarTatort', [boundaries.at(-1)]],
          ['ContentsCode', [contents]],
          ['Tid', ['1'], 'top'],
        ]),
      }),
    );
  }

  async function municipalityPopulation(code) {
    monthly ||= (async () => {
      const id = newestTable(
        await getJson(SCB_POPULATION_FOLDER),
        'Folkmängden per månad',
      );
      if (!id) throw new Error('no monthly population table');
      const url = `${SCB_POPULATION_FOLDER}/${id}`;
      const meta = await getJson(url);
      const age = meta?.variables?.find((entry) => entry.code === 'Alder')
        ?.values?.[0];
      const contents = meta?.variables?.find(
        (entry) => entry.code === 'ContentsCode',
      )?.values?.[0];
      return { url, age, contents };
    })().catch((error) => {
      monthly = null;
      throw error;
    });
    const table = await monthly;
    return normalizeMonthlyAnswer(
      await getJson(table.url, {
        method: 'POST',
        body: query([
          ['Region', [code]],
          ['Alder', [table.age]],
          ['Kon', ['TotSa', '1', '2']],
          ['ContentsCode', [table.contents]],
          ['Tid', ['1'], 'top'],
        ]),
      }),
    );
  }

  return { townPopulation, municipalityPopulation };
}

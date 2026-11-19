// SCB's population figures for the city dossier (open PxWebApi 2.0, no key):
// the town's population year by year inside its latest boundary, and the
// municipality's population at the end of the latest month. Version 1 of
// the API stops at the turn of 2026/2027; version 2 answers in JSON-stat 2.0.
// SCB names two limits (30 and 10 requests per 10 seconds per address); the
// lookups keep to the stricter one.

export const SCB_API = 'https://statistikdatabasen.scb.se/api/v2';
/** SCB's open-data page: at most ten calls per ten seconds per address. */
export const SCB_CALLS_PER_WINDOW = 10;
export const SCB_WINDOW_MS = 10_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
/**
 * The further tables of the dossier: how the title starts (the newest
 * table so named wins) and the words that find it.
 */
export const SCB_TABLES = Object.freeze({
  // Births, deaths and moves per month (TAB6473 for 2025M01–).
  changes: {
    match: /^Befolkningsstatistik efter region och kön\.\s+Månad/,
    search: 'befolkningsstatistik region kön',
  },
  // Detached houses sold: number and mean price (TAB1169).
  houses: {
    match:
      /^Försålda småhus efter region \(kommun, län, riket\) och fastighetstyp\.\s+År/,
    search: 'försålda småhus fastighetstyp',
  },
  // Dwellings started in new buildings per quarter (TAB4572).
  starts: {
    match: /^Lägenheter i nybyggda hus efter region och hustyp\.\s+Kvartal/,
    search: 'lägenheter nybyggda hus hustyp',
  },
  // New cars by fuel per month, Trafikanalys's statistics (TAB3277).
  cars: {
    match:
      /^Nyregistrerade personbilar efter län och kommun samt drivmedel\.\s+Månad/,
    search: 'nyregistrerade personbilar drivmedel',
  },
  // Employed people by home and workplace municipality (TAB1830).
  commuting: {
    match:
      /^Sysselsatta 15.74 år efter bostadskommun, arbetsställekommun och kön/,
    search: 'bostadskommun arbetsställekommun',
  },
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
  const matches = (label) =>
    titleStart instanceof RegExp
      ? titleStart.test(label)
      : label.startsWith(titleStart);
  const tables = (Array.isArray(listing?.tables) ? listing.tables : []).filter(
    (row) =>
      !row?.discontinued &&
      matches(String(row?.label ?? '')) &&
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

/**
 * Every cell of a JSON-stat answer as {coords: {dimension: code}, value},
 * the value list dense or sparse; an empty cell is left out.
 */
export function jsonStatCells(payload) {
  const ids = Array.isArray(payload?.id) ? payload.id : [];
  const codes = ids.map((id) => dimensionValues(payload, id).values);
  const values = payload?.value ?? [];
  const total = codes.reduce((n, list) => n * list.length, ids.length ? 1 : 0);
  const cells = [];
  for (let index = 0; index < total; index += 1) {
    const value = cellValue(values[index]);
    if (!Number.isFinite(value)) continue;
    const coords = {};
    let rest = index;
    for (let d = ids.length - 1; d >= 0; d -= 1) {
      coords[ids[d]] = codes[d][rest % codes[d].length];
      rest = Math.floor(rest / codes[d].length);
    }
    cells.push({ coords, value });
  }
  return cells;
}

/** The dimension whose label or values pass `test`, or null. */
export function findDimension(metadata, test) {
  const dimensions = metadata?.dimension ?? {};
  for (const id of Object.keys(dimensions)) {
    const values = dimensionValues(metadata, id);
    if (test(fold(dimensions[id]?.label ?? id), values, id)) return id;
  }
  return null;
}

/** The code whose text starts with the pattern, or null. */
export function codeByText(values, pattern) {
  const index = values.valueTexts.findIndex((text) => pattern.test(fold(text)));
  return index >= 0 ? values.values[index] : null;
}

/**
 * A municipality's code in a region variable: the code itself, a text that
 * starts with it ("0180 Stockholm (bostad)"), or a code carrying a suffix.
 */
export function regionCode(values, code) {
  const index = values.values.findIndex(
    (value, i) =>
      value === code ||
      String(values.valueTexts[i] ?? '').startsWith(`${code} `) ||
      new RegExp(`^${code}[A-Z]?$`).test(value),
  );
  return index >= 0 ? values.values[index] : null;
}

/** A region text without its code and qualifier: "Stockholm". */
const placeName = (text) =>
  String(text ?? '')
    .replace(/^\d{4}\s+/, '')
    .replace(/\s*\([^)]*\)\s*$/, '')
    .trim();

/** "2026M09" as {year, month}, or null. */
const monthOf = (period) => {
  const match = /^(\d{4})M(\d{2})$/.exec(String(period ?? ''));
  return match ? { year: Number(match[1]), month: Number(match[2]) } : null;
};

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
export function createScbPopulation(
  getJsonDirect,
  {
    limit = SCB_CALLS_PER_WINDOW,
    windowMs = SCB_WINDOW_MS,
    now = Date.now,
    wait = sleep,
  } = {},
) {
  // SCB's stricter page allows ten calls per ten seconds from one address:
  // every read waits for its turn in that window.
  const sent = [];
  let queue = Promise.resolve();
  const getJson = (url, init) => {
    const turn = queue.then(async () => {
      while (sent.length >= limit) {
        const ready = sent[0] + windowMs - now();
        if (ready > 0) await wait(ready);
        while (sent.length && now() - sent[0] >= windowMs) sent.shift();
      }
      sent.push(now());
    });
    queue = turn.catch(() => {});
    return turn.then(() => getJsonDirect(url, init));
  };
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

  /** The further tables, each found and its metadata read once. */
  const further = new Map();
  const furtherTable = (name) => {
    if (!further.has(name)) {
      const { match, search } = SCB_TABLES[name];
      const load = (async () => {
        const id = newestTable(
          await getJson(
            `${SCB_API}/tables?lang=sv&pageSize=50&query=${encodeURIComponent(search)}`,
          ),
          match,
        );
        if (!id) throw new Error(`no SCB table "${name}"`);
        return {
          id,
          meta: await getJson(`${SCB_API}/tables/${id}/metadata?lang=sv`),
        };
      })().catch((error) => {
        further.delete(name);
        throw error;
      });
      further.set(name, load);
    }
    return further.get(name);
  };

  /** The region variable and the town's code in it, or nulls. */
  const regionIn = (meta, code, labelTest = () => true) => {
    const id = findDimension(
      meta,
      (label, values) => labelTest(label) && regionCode(values, code) !== null,
    );
    return id
      ? { id, value: regionCode(dimensionValues(meta, id), code) }
      : { id: null, value: null };
  };

  const contentsOf = (meta, pattern) =>
    codeByText(dimensionValues(meta, 'ContentsCode'), pattern) ??
    dimensionValues(meta, 'ContentsCode').values[0];

  /** Births, deaths and net moves in the latest month. */
  async function changes(code) {
    const { id, meta } = await furtherTable('changes');
    const region = regionIn(meta, code);
    const kind = findDimension(meta, (_, values) =>
      values.valueTexts.some((text) => fold(text) === 'födda'),
    );
    const sex = findDimension(meta, (label) => label.startsWith('kön'));
    if (!region.id || !kind) return null;
    const kinds = dimensionValues(meta, kind);
    const picks = {
      births: codeByText(kinds, /^födda$/),
      deaths: codeByText(kinds, /^döda$/),
      moves: codeByText(kinds, /^flyttningsöverskott totalt$/),
    };
    const selections = [
      [region.id, [region.value]],
      [kind, Object.values(picks).filter(Boolean)],
      ['ContentsCode', [contentsOf(meta, /./)]],
      ['Tid', ['top(1)']],
    ];
    if (sex)
      selections.push([
        sex,
        [codeByText(dimensionValues(meta, sex), /^totalt/)],
      ]);
    const answer = await getJson(dataUrl(id, selections));
    const cells = jsonStatCells(answer);
    const read = (pick) =>
      cells.find((cell) => cell.coords[kind] === pick)?.value ?? null;
    const when = monthOf(periodOf(answer));
    if (!when) return null;
    const out = {
      ...when,
      births: read(picks.births),
      deaths: read(picks.deaths),
      netMoves: read(picks.moves),
    };
    return [out.births, out.deaths, out.netMoves].some(Number.isFinite)
      ? out
      : null;
  }

  /** Permanent detached houses sold in the latest year, and the mean price. */
  async function houses(code) {
    const { id, meta } = await furtherTable('houses');
    const region = regionIn(meta, code);
    const type = findDimension(meta, (label) => label.startsWith('fastighet'));
    if (!region.id || !type) return null;
    const count = contentsOf(meta, /^antal/);
    const price = contentsOf(meta, /^köpeskilling, medelvärde/);
    const answer = await getJson(
      dataUrl(id, [
        [region.id, [region.value]],
        [type, [codeByText(dimensionValues(meta, type), /^permanentbostad/)]],
        ['ContentsCode', [count, price]],
        ['Tid', ['top(1)']],
      ]),
    );
    const cells = jsonStatCells(answer);
    const read = (content) =>
      cells.find((cell) => cell.coords.ContentsCode === content)?.value ?? null;
    const year = Number(periodOf(answer));
    const sold = read(count);
    const meanTkr = read(price);
    return Number.isFinite(year) && Number.isFinite(meanTkr)
      ? { year, sold, meanPrice: Math.round(meanTkr * 1000) }
      : null;
  }

  /** Dwellings started in new buildings in the latest four quarters. */
  async function starts(code) {
    const { id, meta } = await furtherTable('starts');
    const region = regionIn(meta, code);
    const type = findDimension(meta, (label) => label.startsWith('hustyp'));
    if (!region.id) return null;
    const selections = [
      [region.id, [region.value]],
      ['ContentsCode', [contentsOf(meta, /^påbörjade/)]],
      ['Tid', ['top(4)']],
    ];
    if (type) selections.push([type, dimensionValues(meta, type).values]);
    const answer = await getJson(dataUrl(id, selections));
    const cells = jsonStatCells(answer);
    const quarters = dimensionValues(answer, 'Tid').values;
    if (!quarters.length) return null;
    return {
      from: quarters[0],
      to: quarters.at(-1),
      started: cells.reduce((sum, cell) => sum + cell.value, 0),
    };
  }

  /** New cars in the latest twelve months, and how many were electric. */
  async function cars(code) {
    const { id, meta } = await furtherTable('cars');
    const region = regionIn(meta, code);
    const fuel = findDimension(meta, (_, values) =>
      values.valueTexts.some((text) => fold(text) === 'el'),
    );
    if (!region.id || !fuel) return null;
    const fuels = dimensionValues(meta, fuel);
    const electric = codeByText(fuels, /^el$/);
    const answer = await getJson(
      dataUrl(id, [
        [region.id, [region.value]],
        [fuel, fuels.values],
        ['ContentsCode', [contentsOf(meta, /./)]],
        ['Tid', ['top(12)']],
      ]),
    );
    const cells = jsonStatCells(answer);
    const months = dimensionValues(answer, 'Tid').values;
    const total = cells.reduce((sum, cell) => sum + cell.value, 0);
    const el = cells
      .filter((cell) => cell.coords[fuel] === electric)
      .reduce((sum, cell) => sum + cell.value, 0);
    const from = monthOf(months[0]);
    const to = monthOf(months.at(-1));
    return total > 0 && from && to
      ? { from, to, total, electric: el, share: (el / total) * 100 }
      : null;
  }

  /**
   * Who commutes in and out in the latest year, and the largest flow each
   * way. Two reads: the town as home, and the town as workplace.
   */
  async function commuting(code) {
    const { id, meta } = await furtherTable('commuting');
    const home = regionIn(meta, code, (label) => label.includes('bostad'));
    const work = regionIn(meta, code, (label) =>
      label.includes('arbetsställe'),
    );
    const sex = findDimension(meta, (label) => label.startsWith('kön'));
    if (!home.id || !work.id) return null;
    const total = sex
      ? [[sex, [codeByText(dimensionValues(meta, sex), /^totalt/)]]]
      : [];
    const read = (selections) =>
      getJson(
        dataUrl(id, [
          ...selections,
          ...total,
          ['ContentsCode', [contentsOf(meta, /./)]],
          ['Tid', ['top(1)']],
        ]),
      );
    const [out, inn] = await Promise.all([
      read([
        [home.id, [home.value]],
        [work.id, ['*']],
      ]),
      read([
        [home.id, ['*']],
        [work.id, [work.value]],
      ]),
    ]);
    const year = Number(periodOf(out));
    const flows = (answer, other, self) => {
      const names = dimensionValues(answer, other);
      return jsonStatCells(answer)
        .filter((cell) => cell.coords[other] !== self)
        .map((cell) => ({
          name: placeName(
            names.valueTexts[names.values.indexOf(cell.coords[other])],
          ),
          count: cell.value,
        }))
        .sort((a, b) => b.count - a.count);
    };
    const outFlows = flows(out, work.id, work.value);
    const inFlows = flows(inn, home.id, home.value);
    const sum = (list) => list.reduce((n, flow) => n + flow.count, 0);
    const local = jsonStatCells(out).find(
      (cell) => cell.coords[work.id] === work.value,
    )?.value;
    return Number.isFinite(year)
      ? {
          year,
          local: local ?? null,
          out: sum(outFlows),
          in: sum(inFlows),
          topOut: outFlows[0] ?? null,
          topIn: inFlows[0] ?? null,
        }
      : null;
  }

  /**
   * The further figures of one municipality; each may fail alone and is then
   * null, with the failure named for the log.
   */
  async function municipalityFigures(code) {
    const parts = { changes, houses, starts, cars, commuting };
    const figures = {};
    const failed = [];
    // One table at a time: SCB allows 30 requests per 10 seconds, and the
    // first town also reads every table's metadata.
    for (const [name, read] of Object.entries(parts)) {
      try {
        figures[name] = await read(code);
      } catch (error) {
        figures[name] = null;
        failed.push(`${name}: ${error?.message || error}`);
      }
    }
    return { figures, failed };
  }

  return { townPopulation, municipalityPopulation, municipalityFigures };
}

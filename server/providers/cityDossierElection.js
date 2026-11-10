import { inflateRawSync } from 'node:zlib';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultSourceRoot } from './common/source-root.js';

// The latest municipal election for the city dossier, from Valmyndigheten's
// final results (open data, no key). Valmyndigheten publishes them as one
// workbook per election type; the "Antal_kommun" sheet holds every party's
// votes per municipality and "Valdeltagande_kommun" the turnout. The link
// is read from the raw-data page, the workbook (about 11 MB) is fetched
// once, and only those two sheets are unpacked. Final results do not
// change, so the parsed table is kept on disk.

export const VAL_RAW_DATA_PAGE =
  'https://www.val.se/valresultat-och-statistik/statistik-och-data/radata-val-2026';
export const ELECTION_YEAR = 2026;
const WORKBOOK_LINK =
  /href="([^"]*\/download\/[^"]*slutligt[^"]*kommunvalen-2026\.xlsx)"/;
/** val.se is waited for this long; the workbook is about 11 MB. */
const FETCH_TIMEOUT_MS = 60_000;
const MAX_WORKBOOK_BYTES = 64 * 1024 * 1024;
/** Sweden has 290 municipalities: far fewer is not the country's result. */
const MIN_MUNICIPALITIES = 250;
const wholeCountry = (table) =>
  Boolean(table) &&
  typeof table === 'object' &&
  Object.keys(table).length >= MIN_MUNICIPALITIES;
/** A share cell as percent; NaN for an empty cell, never 0 %. */
const percent = (cell) =>
  cell == null || String(cell).trim() === '' ? NaN : Number(cell) * 100;

const CACHE_FILE = path.join(
  defaultSourceRoot,
  '.gev-cache',
  'city-dossier',
  `kommunval-${ELECTION_YEAR}.json`,
);
/** The parties of the Riksdag, by the names Valmyndigheten gives them. */
export const RIKSDAG_PARTIES = Object.freeze({
  'Arbetarepartiet-Socialdemokraterna': 'S',
  Moderaterna: 'M',
  Sverigedemokraterna: 'SD',
  Vänsterpartiet: 'V',
  Centerpartiet: 'C',
  'Miljöpartiet de gröna': 'MP',
  Kristdemokraterna: 'KD',
  'Liberalerna (tidigare Folkpartiet)': 'L',
});
/** A local party at least this large is named; smaller ones join "other". */
const NAMED_LOCAL_SHARE = 3;
const MAX_ZIP_ENTRY_BYTES = 120 * 1024 * 1024;

/**
 * The named entries of a zip archive (stored or deflated, no ZIP64).
 * @param {Uint8Array} bytes
 * @param {Set<string>} wanted
 * @returns {Map<string, string>} Entry path → UTF-8 text.
 */
export function readZipText(bytes, wanted) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--)
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out = new Map();
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(at, true) !== 0x02014b50)
      throw new Error('damaged zip directory');
    const method = view.getUint16(at + 10, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const skip =
      nameLength +
      view.getUint16(at + 30, true) +
      view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at += 46 + skip;
    if (!wanted.has(name)) continue;
    if (size > MAX_ZIP_ENTRY_BYTES) throw new Error(`${name} is too large`);
    const start =
      local +
      30 +
      view.getUint16(local + 26, true) +
      view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + compressed);
    out.set(
      name,
      decoder.decode(
        method === 0
          ? data
          : inflateRawSync(data, { maxOutputLength: MAX_ZIP_ENTRY_BYTES }),
      ),
    );
  }
  return out;
}

const unescapeXml = (value) =>
  String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

/** The workbook's shared strings, in order. */
export function sharedStrings(xml) {
  return [...String(xml).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((match) =>
    unescapeXml(
      [...match[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((t) => t[1]).join(''),
    ),
  );
}

/** Sheet name → part path ("xl/worksheets/sheet3.xml"). */
export function sheetPaths(workbookXml, relsXml) {
  const targets = new Map(
    [
      ...String(relsXml).matchAll(
        /<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g,
      ),
    ].map(([, id, target]) => [id, `xl/${target.replace(/^\/?xl\//, '')}`]),
  );
  return new Map(
    [
      ...String(workbookXml).matchAll(
        /<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g,
      ),
    ].map(([, name, id]) => [unescapeXml(name), targets.get(id)]),
  );
}

/** A sheet's rows as objects keyed by the header row's text. */
export function sheetRows(xml, strings) {
  const rows = [...String(xml).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map(
    (row) =>
      new Map(
        [
          ...row[1].matchAll(
            /<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>(?:<f>[^<]*<\/f>)?(?:<v>([^<]*)<\/v>)?)/g,
          ),
        ].map(([, column, attrs, value]) => [
          column,
          value === undefined
            ? null
            : /t="s"/.test(attrs)
              ? strings[Number(value)]
              : unescapeXml(value),
        ]),
      ),
  );
  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((cells) => {
    const row = {};
    for (const [column, name] of header) row[name] = cells.get(column) ?? null;
    return row;
  });
}

/**
 * Votes and turnout per municipality code: the Riksdag parties by their
 * letters, local parties of at least 3 % by name, the rest as "other".
 * @param {object[]} voteRows "Antal_kommun" rows.
 * @param {object[]} turnoutRows "Valdeltagande_kommun" rows.
 */
export function electionByMunicipality(voteRows, turnoutRows) {
  const turnout = new Map(
    turnoutRows.map((row) => [
      String(row.Kommunkod),
      percent(row['Valdeltagande (%)']),
    ]),
  );
  const out = {};
  for (const row of voteRows) {
    const code = String(row.Kommunkod ?? '');
    if (!/^\d{4}$/.test(code)) continue;
    const votes = Object.entries(row)
      .filter(
        ([name, value]) =>
          !['Valtyp', 'Kommun', 'Kommunkod', 'Län', 'Länskod'].includes(name) &&
          Number(value) > 0,
      )
      .map(([name, value]) => [name, Number(value)]);
    const total = votes.reduce((sum, [, value]) => sum + value, 0);
    if (!total) continue;
    const parties = [];
    let other = 0;
    for (const [name, value] of votes) {
      const share = (value / total) * 100;
      const letters = RIKSDAG_PARTIES[name];
      if (letters) parties.push({ party: letters, share });
      else if (share >= NAMED_LOCAL_SHARE)
        parties.push({ party: 'local', name, share });
      else other += value;
    }
    const order = Object.values(RIKSDAG_PARTIES);
    parties.sort(
      (a, b) =>
        (order.includes(a.party) ? order.indexOf(a.party) : 99) -
          (order.includes(b.party) ? order.indexOf(b.party) : 99) ||
        b.share - a.share,
    );
    if (other) parties.push({ party: 'other', share: (other / total) * 100 });
    const round = (value) => Math.round(value * 100) / 100;
    out[code] = {
      year: ELECTION_YEAR,
      turnout: Number.isFinite(turnout.get(code))
        ? round(turnout.get(code))
        : null,
      parties: parties.map((row) => ({ ...row, share: round(row.share) })),
    };
  }
  return out;
}

/** Parse Valmyndigheten's municipal-election workbook. */
export function parseElectionWorkbook(bytes) {
  const base = readZipText(
    bytes,
    new Set([
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/sharedStrings.xml',
    ]),
  );
  const sheets = sheetPaths(
    base.get('xl/workbook.xml'),
    base.get('xl/_rels/workbook.xml.rels'),
  );
  const votesPath = sheets.get('Antal_kommun');
  const turnoutPath = sheets.get('Valdeltagande_kommun');
  if (!votesPath || !turnoutPath)
    throw new Error('workbook lacks the municipality sheets');
  const parts = readZipText(bytes, new Set([votesPath, turnoutPath]));
  const strings = sharedStrings(base.get('xl/sharedStrings.xml'));
  return electionByMunicipality(
    sheetRows(parts.get(votesPath), strings),
    sheetRows(parts.get(turnoutPath), strings),
  );
}

/**
 * The 2026 municipal election per municipality code, read once: from the
 * disk cache when present, else from Valmyndigheten.
 * @param {{fetchImpl: Function, cacheFile?: string|null}} options
 */
export function createElectionResults({
  fetchImpl,
  cacheFile = CACHE_FILE,
  timeoutMs = FETCH_TIMEOUT_MS,
}) {
  let results = null;

  async function load() {
    if (cacheFile) {
      try {
        const kept = JSON.parse(await readFile(cacheFile, 'utf8'));
        // A file that is not the whole country's result is read again.
        if (wholeCountry(kept)) return kept;
      } catch {
        /* not cached yet */
      }
    }
    // val.se may stall: the dossier waits this long for it, not for ever.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let parsed;
    try {
      const page = await fetchImpl(VAL_RAW_DATA_PAGE, {
        signal: controller.signal,
      });
      if (!page.ok) throw new Error(`val.se HTTP ${page.status}`);
      const link = WORKBOOK_LINK.exec(await page.text())?.[1];
      if (!link) throw new Error('no final municipal results on val.se');
      const workbook = await fetchImpl(new URL(link, VAL_RAW_DATA_PAGE).href, {
        signal: controller.signal,
      });
      if (!workbook.ok) throw new Error(`val.se HTTP ${workbook.status}`);
      if (
        Number(workbook.headers?.get?.('content-length')) > MAX_WORKBOOK_BYTES
      )
        throw new Error('the val.se workbook is too large');
      const bytes = new Uint8Array(await workbook.arrayBuffer());
      if (bytes.byteLength > MAX_WORKBOOK_BYTES)
        throw new Error('the val.se workbook is too large');
      parsed = parseElectionWorkbook(bytes);
    } finally {
      clearTimeout(timer);
    }
    // Only the whole country's result is worth keeping on disk.
    if (cacheFile && wholeCountry(parsed)) {
      await mkdir(path.dirname(cacheFile), { recursive: true });
      await writeFile(cacheFile, JSON.stringify(parsed));
    }
    return parsed;
  }

  return {
    /** The election for one municipality code, or null. */
    async forMunicipality(code) {
      results ||= load().catch((error) => {
        results = null;
        throw error;
      });
      return (await results)[code] ?? null;
    },
  };
}

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readResponseTextCapped } from './common/http.js';
import { defaultSourceRoot } from './common/source-root.js';

// Airport positions by IATA code (Swedish fork), for drawing the airport
// board's routes: OurAirports' open airport list (public domain), read at
// most once a week and kept in .gev-cache as only the airports with an IATA
// code — about a tenth of the 12 MB list.

export const OURAIRPORTS_URL =
  'https://davidmegginson.github.io/ourairports-data/airports.csv';
const DEFAULT_CACHE_FILE = path.join(
  defaultSourceRoot,
  '.gev-cache',
  'ourairports',
  'airports-iata.json',
);
const INDEX_TTL_MS = 7 * 24 * 60 * 60_000;
const FETCH_TIMEOUT_MS = 60_000;
const MAX_CSV_BYTES = 40 * 1024 * 1024;
const KEPT_TYPES = new Set([
  'large_airport',
  'medium_airport',
  'small_airport',
]);

/** One CSV line's fields; quoted fields may hold commas and "". */
export function csvFields(line) {
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      fields.push(field);
      field = '';
    } else field += ch;
  }
  fields.push(field);
  return fields;
}

/**
 * OurAirports' airports.csv as IATA code → [lat, lon, name, municipality,
 * country]; open airports with a three-letter IATA code only, the larger
 * kind winning a shared code.
 */
export function parseAirports(csv) {
  const lines = String(csv ?? '').split(/\r?\n/);
  const header = csvFields(lines[0] ?? '');
  const col = (name) => header.indexOf(name);
  const at = {
    type: col('type'),
    name: col('name'),
    lat: col('latitude_deg'),
    lon: col('longitude_deg'),
    country: col('iso_country'),
    town: col('municipality'),
    iata: col('iata_code'),
  };
  if (Object.values(at).some((index) => index < 0)) return {};
  const rank = (type) =>
    ['small_airport', 'medium_airport', 'large_airport'].indexOf(type);
  const out = {};
  const ranks = {};
  for (let i = 1; i < lines.length; i += 1) {
    if (!lines[i]) continue;
    const row = csvFields(lines[i]);
    const iata = String(row[at.iata] ?? '')
      .trim()
      .toUpperCase();
    if (!/^[A-Z]{3}$/.test(iata) || !KEPT_TYPES.has(row[at.type])) continue;
    const lat = Number(row[at.lat]);
    const lon = Number(row[at.lon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (out[iata] && ranks[iata] >= rank(row[at.type])) continue;
    out[iata] = [
      +lat.toFixed(4),
      +lon.toFixed(4),
      String(row[at.name] ?? '').slice(0, 80),
      String(row[at.town] ?? '').slice(0, 60),
      String(row[at.country] ?? '').slice(0, 2),
    ];
    ranks[iata] = rank(row[at.type]);
  }
  return out;
}

/**
 * The airport index, read from memory, the week-old cache file, or
 * OurAirports; a failed download falls back on an older cache file.
 */
export function createAirportIndex({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  cacheFile = DEFAULT_CACHE_FILE,
} = {}) {
  let index = null;
  let loading = null;

  async function readCache() {
    if (!cacheFile) return null;
    try {
      const kept = JSON.parse(await readFile(cacheFile, 'utf8'));
      return kept?.airports ? kept : null;
    } catch {
      return null;
    }
  }

  async function download() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(OURAIRPORTS_URL, {
        signal: controller.signal,
        redirect: 'follow',
        headers: { 'User-Agent': 'gods-eye-view (airport routes)' },
      });
      if (!response.ok) throw new Error(`upstream HTTP ${response.status}`);
      const airports = parseAirports(
        await readResponseTextCapped(response, MAX_CSV_BYTES),
      );
      if (Object.keys(airports).length < 1000)
        throw new Error('airport list too short');
      return { at: now(), airports };
    } finally {
      clearTimeout(timer);
    }
  }

  async function load() {
    if (index && now() - index.at < INDEX_TTL_MS) return index;
    const kept = index ?? (await readCache());
    if (kept && now() - kept.at < INDEX_TTL_MS) return (index = kept);
    try {
      index = await download();
      if (cacheFile) {
        await mkdir(path.dirname(cacheFile), { recursive: true });
        await writeFile(cacheFile, JSON.stringify(index));
      }
    } catch (error) {
      console.warn(`[ourairports] ${error?.message}`);
      if (!kept) throw error;
      index = kept;
    }
    return index;
  }

  return {
    /** Positions for IATA codes: code → { lat, lon, name, town, country }. */
    async lookup(codes) {
      loading ??= load().finally(() => (loading = null));
      const { airports } = await loading;
      const out = {};
      for (const code of codes) {
        const row = airports[String(code).toUpperCase()];
        if (row)
          out[code] = {
            lat: row[0],
            lon: row[1],
            name: row[2],
            town: row[3],
            country: row[4],
          };
      }
      return out;
    },
  };
}

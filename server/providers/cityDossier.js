import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';
import { nearestSeat } from './regional/sweden.js';
import { createScbPopulation } from './cityDossierScb.js';
import { createElectionResults } from './cityDossierElection.js';

// The city dossier: facts about the Swedish town nearest a point, from three
// open sources without keys. Kolada (RKA) has the municipality's key figures
// year by year; Wikidata (CC0) the town itself — its own population, founding
// and height — and the municipality's coat of arms; Swedish Wikipedia
// (CC BY-SA 4.0, credited with a link) the introduction and a photo. SCB's
// newer counts replace the town's and municipality's population where they
// answer, and Valmyndigheten's final results the latest election. Facts
// change yearly, so a municipality's answer is kept for a day.

export const KOLADA_URL = 'https://api.kolada.se/v3/data/kpi';
export const WIKIDATA_SPARQL_URL = 'https://query.wikidata.org/sparql';
export const WIKIPEDIA_SUMMARY_URL =
  'https://sv.wikipedia.org/api/rest_v1/page/summary/';
const USER_AGENT =
  'GodsEyeView-Sweden/0.1 (https://github.com/Kajjan7610/Gods-view-sweden)';
/** Within this distance of a seat the view is visiting that town. */
export const VISIT_RADIUS_KM = 20;
const FACTS_TTL_MS = 24 * 60 * 60_000;
const PARTIAL_FACTS_TTL_MS = 10 * 60_000;
const FACTS_CACHE_MAX = 120;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Years of population history shown as a curve. */
const HISTORY_YEARS = 11;

/** Kolada key figures, by the name the dossier gives them. */
export const KOLADA_KPIS = Object.freeze({
  population: 'N01951',
  taxRate: 'N00900',
  medianIncome: 'N00906',
  meanAge: 'N00959',
  unemployment: 'N03937',
  turnout: 'N05401',
});
/** Party shares in the latest municipal election, in Kolada's order. */
export const PARTY_KPIS = Object.freeze([
  ['S', 'N05801'],
  ['V', 'N05802'],
  ['MP', 'N05803'],
  ['SD', 'N05804'],
  ['M', 'N05805'],
  ['L', 'N05806'],
  ['C', 'N05807'],
  ['KD', 'N05808'],
  ['other', 'N05809'],
]);

const finite = (value) =>
  value == null || value === '' || !Number.isFinite(Number(value))
    ? null
    : Number(value);

/**
 * Kolada's answer as the dossier's figures: each key figure's latest year,
 * the population year by year and the election shares.
 * @param {object} payload Kolada v3 data answer.
 */
export function normalizeKolada(payload) {
  const rows = Array.isArray(payload?.values) ? payload.values : [];
  const byKpi = new Map();
  for (const row of rows) {
    const period = finite(row?.period);
    if (!row?.kpi || period == null) continue;
    const values = Array.isArray(row.values) ? row.values : [];
    const pick = (gender) =>
      finite(values.find((value) => value?.gender === gender)?.value);
    const entry = {
      year: period,
      value: pick('T'),
      men: pick('M'),
      women: pick('K'),
    };
    if (entry.value == null) continue;
    if (!byKpi.has(row.kpi)) byKpi.set(row.kpi, []);
    byKpi.get(row.kpi).push(entry);
  }
  for (const list of byKpi.values()) list.sort((a, b) => a.year - b.year);
  const latest = (kpi) => byKpi.get(kpi)?.at(-1) ?? null;
  const figure = (kpi) => {
    const entry = latest(kpi);
    return entry ? { value: entry.value, year: entry.year } : null;
  };
  const population = byKpi.get(KOLADA_KPIS.population) ?? [];
  const lastPopulation = population.at(-1) ?? null;
  const parties = PARTY_KPIS.map(([party, kpi]) => ({
    party,
    share: latest(kpi)?.value ?? null,
  })).filter((row) => row.share != null);
  return {
    population: lastPopulation
      ? {
          value: lastPopulation.value,
          year: lastPopulation.year,
          men: lastPopulation.men,
          women: lastPopulation.women,
        }
      : null,
    populationHistory: population.map(({ year, value }) => ({ year, value })),
    taxRate: figure(KOLADA_KPIS.taxRate),
    medianIncome: figure(KOLADA_KPIS.medianIncome),
    meanAge: figure(KOLADA_KPIS.meanAge),
    unemployment: figure(KOLADA_KPIS.unemployment),
    turnout: figure(KOLADA_KPIS.turnout),
    election: parties.length
      ? {
          // Kolada repeats the latest result every year until the next one.
          dataYear: latest(PARTY_KPIS[0][1])?.year ?? null,
          parties,
        }
      : null,
  };
}

const sparqlString = (value) =>
  `"${String(value).replace(/["\\\n\r]/g, ' ')}"@sv`;

/**
 * The Wikidata query for a municipality (by its code) and its seat town (by
 * any of the names it may carry). The town's population is the preferred
 * statement, newest first: Stockholm lists one per municipality part.
 */
export function wikidataQuery(code, names) {
  const labels = [...new Set(names.filter(Boolean))]
    .map(sparqlString)
    .join(' ');
  return `SELECT ?coa ?town ?pop ?popDate ?inception ?elev ?article WHERE {
  ?muni wdt:P525 "${String(code).replace(/\D/g, '')}" .
  OPTIONAL { ?muni wdt:P94 ?coa }
  OPTIONAL {
    VALUES ?label { ${labels} }
    ?town wdt:P31 wd:Q12813115 ; wdt:P131 ?muni ; rdfs:label ?label .
    OPTIONAL {
      ?town p:P1082 ?ps . ?ps ps:P1082 ?pop ; wikibase:rank ?rank .
      OPTIONAL { ?ps pq:P585 ?popDate }
      BIND(IF(?rank = wikibase:PreferredRank, 1, 0) AS ?preferred)
    }
    OPTIONAL { ?town wdt:P571 ?inception }
    OPTIONAL { ?town wdt:P2044 ?elev }
    OPTIONAL { ?article schema:about ?town ; schema:isPartOf <https://sv.wikipedia.org/> }
  }
} ORDER BY DESC(?preferred) DESC(?popDate) LIMIT 1`;
}

/** The first answer row as the town's facts. */
export function normalizeWikidata(payload) {
  const row = payload?.results?.bindings?.[0];
  if (!row) return null;
  const value = (key) => row[key]?.value ?? null;
  const year = (iso) => {
    const match = /^(-?\d{1,4})-/.exec(String(iso ?? ''));
    return match ? Number(match[1]) : null;
  };
  const article = value('article');
  const coa = value('coa');
  return {
    town: value('town')?.split('/').pop() ?? null,
    population: finite(value('pop')),
    populationYear: year(value('popDate')),
    founded: year(value('inception')),
    elevation: finite(value('elev')),
    articleTitle: article
      ? decodeURIComponent(article.split('/wiki/').pop()).replace(/_/g, ' ')
      : null,
    // Special:FilePath serves the file; ?width asks for a small rendering.
    coatOfArms:
      coa && /^https?:\/\/commons\.wikimedia\.org\//.test(coa)
        ? `${coa.replace(/^http:/, 'https:')}?width=120`
        : null,
  };
}

/** Wikipedia's summary as the dossier's introduction, or null. */
export function normalizeWikipedia(payload) {
  if (!payload || payload.type === 'disambiguation') return null;
  // The pronunciation's audio is stripped from the summary, leaving "( )".
  const extract = String(payload.extract ?? '')
    .replace(/\s*\(\s*[,;]?\s*\)/g, '')
    .trim();
  if (!extract) return null;
  const https = (url) =>
    typeof url === 'string' && /^https:\/\//.test(url) ? url : null;
  return {
    title: String(payload.title ?? '').slice(0, 120),
    extract: extract.slice(0, 900),
    image: https(payload.thumbnail?.source),
    url: https(payload.content_urls?.desktop?.page),
  };
}

/** Names the seat town may carry: "Salemstaden", "Salem", "Salems". */
export function townNames(seat) {
  const names = [seat.locality, seat.municipality];
  if (/s$/.test(seat.municipality))
    names.push(seat.municipality.replace(/s$/, ''));
  return names;
}

/**
 * The town's facts with SCB's yearly population when there is one: SCB
 * counts the town every year inside its latest boundary, Wikidata only at
 * each delimitation.
 */
export function mergeTown(wikidata, scbTown) {
  if (!scbTown) return wikidata;
  return {
    ...(wikidata || {
      town: null,
      founded: null,
      elevation: null,
      articleTitle: null,
      coatOfArms: null,
    }),
    population: scbTown.value,
    populationYear: scbTown.year,
    populationSource: 'SCB',
  };
}

/**
 * Kolada's figures with the municipality's population from SCB's latest
 * month and the latest election from Valmyndigheten, where those answered.
 */
export function mergeMunicipality(kolada, monthly, election) {
  if (!kolada && !monthly && !election) return null;
  const base = kolada || {
    population: null,
    populationHistory: [],
    taxRate: null,
    medianIncome: null,
    meanAge: null,
    unemployment: null,
    turnout: null,
    election: null,
  };
  return {
    ...base,
    population: monthly
      ? {
          value: monthly.value,
          year: monthly.year,
          month: monthly.month,
          men: monthly.men,
          women: monthly.women,
          source: 'SCB',
        }
      : base.population,
    turnout:
      election && Number.isFinite(election.turnout)
        ? { value: election.turnout, year: election.year }
        : base.turnout,
    election: election
      ? {
          year: election.year,
          parties: election.parties,
          source: 'Valmyndigheten',
        }
      : base.election,
  };
}

/** Bounded city dossier route for dev and preview. */
export function cityDossierProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  scb = null,
  election = null,
} = {}) {
  const facts = new Map();
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 300 });

  /** One bounded JSON read; `body` makes it a JSON POST (SCB's queries). */
  async function getJson(url, { headers = {}, method = 'GET', body } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(url, {
        method,
        signal: controller.signal,
        redirect: 'follow',
        headers: {
          Accept: 'application/json',
          'User-Agent': USER_AGENT,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw new Error(
          `upstream HTTP ${response.status} (${new URL(url).host})`,
        );
      }
      return await readResponseJsonCapped(response, MAX_BODY_BYTES);
    } finally {
      clearTimeout(timer);
    }
  }

  const population = scb || createScbPopulation(getJson);
  const results = election || createElectionResults({ fetchImpl });

  async function loadFacts(seat) {
    const thisYear = new Date(now()).getUTCFullYear();
    const years = Array.from(
      { length: HISTORY_YEARS },
      (_, i) => thisYear - HISTORY_YEARS + 1 + i,
    );
    const kpis = [
      ...Object.values(KOLADA_KPIS),
      ...PARTY_KPIS.map(([, id]) => id),
    ];
    const value = (result) =>
      result.status === 'fulfilled' ? result.value : null;
    const [kolada, wikidata, scbTown, scbMonthly, latestElection] =
      await Promise.allSettled([
        getJson(
          `${KOLADA_URL}/${kpis.join(',')}/municipality/${seat.code}/year/${years.join(',')}`,
        ).then(normalizeKolada),
        getJson(
          `${WIKIDATA_SPARQL_URL}?format=json&query=${encodeURIComponent(
            wikidataQuery(seat.code, townNames(seat)),
          )}`,
          { headers: { Accept: 'application/sparql-results+json' } },
        ).then(normalizeWikidata),
        population.townPopulation(seat.code, townNames(seat)),
        population.municipalityPopulation(seat.code),
        results.forMunicipality(seat.code),
      ]);
    // Each source may fail alone; say which, so a quiet gap is explained.
    for (const [label, result] of [
      ['kolada', kolada],
      ['wikidata', wikidata],
      ['scb town', scbTown],
      ['scb month', scbMonthly],
      ['election', latestElection],
    ])
      if (result.status === 'rejected')
        console.warn(
          `[city-dossier] ${seat.locality} ${label}: ${result.reason?.message || result.reason}`,
        );
    const town = mergeTown(value(wikidata), value(scbTown));
    let wikipedia = null;
    try {
      const title = town?.articleTitle || seat.locality;
      wikipedia = normalizeWikipedia(
        await getJson(
          `${WIKIPEDIA_SUMMARY_URL}${encodeURIComponent(title.replace(/ /g, '_'))}`,
        ),
      );
    } catch {
      wikipedia = null;
    }
    const municipality = mergeMunicipality(
      value(kolada),
      value(scbMonthly),
      value(latestElection),
    );
    if (!municipality && !town && !wikipedia)
      throw new Error('no dossier source answered');
    // A source that failed is asked again soon instead of after a day.
    const partial = [
      kolada,
      wikidata,
      scbTown,
      scbMonthly,
      latestElection,
    ].some((result) => result.status === 'rejected');
    return { municipality, town, wikipedia, partial, fetchedAt: now() };
  }

  async function handler(req, res) {
    const json = (status, value, headers = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...headers,
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET')
      return json(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
    const url = new URL(req.url || '/', 'http://local');
    if (url.pathname !== '/' && url.pathname !== '')
      return json(404, { error: 'unknown_route' });
    const latitude = Number(url.searchParams.get('lat'));
    const longitude = Number(url.searchParams.get('lon'));
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude))
      return json(400, { error: 'lat_lon_required' });
    const seat = nearestSeat({ latitude, longitude }, VISIT_RADIUS_KM);
    if (!seat) return json(200, { city: null });
    const city = {
      code: seat.code,
      municipality: seat.municipality,
      name: seat.locality,
      county: seat.county,
      point: seat.point,
    };
    const hit = facts.get(seat.code);
    if (
      hit &&
      now() - hit.savedAt <
        (hit.value.partial ? PARTIAL_FACTS_TTL_MS : FACTS_TTL_MS)
    )
      return json(200, { city, ...hit.value });
    if (!allow(clientKey(req)))
      return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
    try {
      const { promise } = coalesceProxyRequest(inFlight, seat.code, () =>
        loadFacts(seat),
      );
      const value = await promise;
      facts.delete(seat.code);
      facts.set(seat.code, { value, savedAt: now() });
      if (facts.size > FACTS_CACHE_MAX) facts.delete(facts.keys().next().value);
      return json(200, { city, ...value });
    } catch (error) {
      console.warn(
        `[city-dossier] ${seat.locality}: ${error?.message || error}`,
      );
      if (hit) return json(200, { city, ...hit.value, stale: true });
      return json(502, { city, error: 'city_dossier_unavailable' });
    }
  }

  return {
    name: 'city-dossier',
    configureServer({ middlewares }) {
      middlewares.use('/api/city-dossier', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/city-dossier', handler);
    },
  };
}

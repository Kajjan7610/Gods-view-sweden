// The city dossier route: Kolada, Wikidata and Wikipedia answers shaped into
// one dossier per municipality, cached for a day.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KOLADA_URL,
  WIKIDATA_SPARQL_URL,
  WIKIPEDIA_SUMMARY_URL,
  cityDossierProxy,
  normalizeKolada,
  normalizeWikidata,
  normalizeWikipedia,
  townNames,
  wikidataQuery,
} from './cityDossier.js';

const kolada = {
  values: [
    { kpi: 'N01951', period: 2024, values: [{ gender: 'T', value: 103838 }] },
    {
      kpi: 'N01951',
      period: 2025,
      values: [
        { gender: 'T', value: 104108 },
        { gender: 'M', value: 52110 },
        { gender: 'K', value: 52000 },
      ],
    },
    { kpi: 'N00900', period: 2026, values: [{ gender: 'T', value: 33.77 }] },
    { kpi: 'N05801', period: 2025, values: [{ gender: 'T', value: 32.08 }] },
    { kpi: 'N05804', period: 2025, values: [{ gender: 'T', value: 19.49 }] },
    { kpi: 'N00959', period: 2025, values: [{ gender: 'T', value: null }] },
  ],
};

test("Kolada's key figures: the latest year of each, the history, the election", () => {
  const figures = normalizeKolada(kolada);
  assert.deepEqual(figures.population, {
    value: 104108,
    year: 2025,
    men: 52110,
    women: 52000,
  });
  assert.deepEqual(figures.populationHistory, [
    { year: 2024, value: 103838 },
    { year: 2025, value: 104108 },
  ]);
  assert.deepEqual(figures.taxRate, { value: 33.77, year: 2026 });
  assert.equal(figures.meanAge, null, 'a missing value is no figure');
  assert.deepEqual(figures.election, {
    dataYear: 2025,
    parties: [
      { party: 'S', share: 32.08 },
      { party: 'SD', share: 19.49 },
    ],
  });
  assert.equal(normalizeKolada({}).population, null);
});

test('the Wikidata query looks the town up by any of its names', () => {
  assert.deepEqual(
    townNames({ locality: 'Salemstaden', municipality: 'Salems' }),
    ['Salemstaden', 'Salems', 'Salem'],
  );
  const query = wikidataQuery('0128', ['Salemstaden', 'Salem', 'Salem', '']);
  assert.match(query, /wdt:P525 "0128"/);
  assert.match(query, /VALUES \?label \{ "Salemstaden"@sv "Salem"@sv \}/);
  assert.match(query, /ORDER BY DESC\(\?preferred\) DESC\(\?popDate\)/);
  assert.doesNotMatch(wikidataQuery('01"28', ['x"y']), /"x"y"/);
});

test('Wikidata and Wikipedia answers become the town facts and introduction', () => {
  const town = normalizeWikidata({
    results: {
      bindings: [
        {
          town: { value: 'http://www.wikidata.org/entity/Q25748' },
          pop: { value: '86533' },
          popDate: { value: '2023-12-31T00:00:00Z' },
          inception: { value: '1446-01-01T00:00:00Z' },
          elev: { value: '8' },
          article: {
            value: 'https://sv.wikipedia.org/wiki/Stockholm_(t%C3%A4tort)',
          },
          coa: {
            value:
              'http://commons.wikimedia.org/wiki/Special:FilePath/G%C3%A4vle%20vapen.png',
          },
        },
      ],
    },
  });
  assert.deepEqual(town, {
    town: 'Q25748',
    population: 86533,
    populationYear: 2023,
    founded: 1446,
    elevation: 8,
    articleTitle: 'Stockholm (tätort)',
    coatOfArms:
      'https://commons.wikimedia.org/wiki/Special:FilePath/G%C3%A4vle%20vapen.png?width=120',
  });
  assert.equal(normalizeWikidata({ results: { bindings: [] } }), null);
  assert.deepEqual(
    normalizeWikipedia({
      title: 'Gävle',
      extract: 'Gävle ( ) är en tätort i Gästrikland.',
      thumbnail: { source: 'https://upload.wikimedia.org/g.jpg' },
      content_urls: {
        desktop: { page: 'https://sv.wikipedia.org/wiki/G%C3%A4vle' },
      },
    }),
    {
      title: 'Gävle',
      extract: 'Gävle är en tätort i Gästrikland.',
      image: 'https://upload.wikimedia.org/g.jpg',
      url: 'https://sv.wikipedia.org/wiki/G%C3%A4vle',
    },
  );
  assert.equal(
    normalizeWikipedia({ type: 'disambiguation', extract: 'x' }),
    null,
  );
});

function route(options) {
  let handler = null;
  cityDossierProxy(options).configureServer({
    middlewares: { use: (path, fn) => (handler = fn) },
  });
  return async (url) => {
    const res = {
      destroyed: false,
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ method: 'GET', url, headers: {}, socket: {} }, res);
    return res;
  };
}

test('the route answers the town near a point and caches its facts', async () => {
  const calls = [];
  const get = route({
    now: () => Date.parse('2026-11-05T18:00:00Z'),
    fetchImpl: async (url) => {
      calls.push(url);
      if (url.startsWith(KOLADA_URL))
        return new Response(JSON.stringify(kolada));
      if (url.startsWith(WIKIDATA_SPARQL_URL))
        return new Response(JSON.stringify({ results: { bindings: [] } }));
      if (url.startsWith(WIKIPEDIA_SUMMARY_URL))
        return new Response(
          JSON.stringify({ title: 'Gävle', extract: 'Gävle är en stad.' }),
        );
      return new Response('', { status: 404 });
    },
  });
  const first = await get('/?lat=60.67&lon=17.14');
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.city, {
    code: '2180',
    municipality: 'Gävle',
    name: 'Gävle',
    county: 'Gävleborgs län',
    point: first.body.city.point,
  });
  assert.equal(first.body.municipality.population.value, 104108);
  assert.equal(first.body.wikipedia.extract, 'Gävle är en stad.');
  assert.match(
    calls[0],
    /\/N01951,.*\/municipality\/2180\/year\/2016,.*,2026$/,
  );
  const count = calls.length;
  await get('/?lat=60.68&lon=17.15');
  assert.equal(calls.length, count, 'served from the day cache');
  assert.deepEqual((await get('/?lat=57&lon=20')).body, { city: null });
  assert.equal((await get('/?lat=x')).status, 400);
});

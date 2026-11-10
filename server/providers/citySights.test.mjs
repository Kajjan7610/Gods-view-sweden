// Sights around a town: Wikidata's rows as one sight each, ranked, capped
// per kind; and the query asks the kinds within reach.
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeSights, sightsQuery } from './citySights.js';

const row = (qid, name, kind, lon, lat, extra = {}) => ({
  item: { value: `http://www.wikidata.org/entity/${qid}` },
  itemLabel: { value: name },
  kind: { value: kind },
  coord: { value: `Point(${lon} ${lat})` },
  ...extra,
});
const ART = (title) => ({
  article: { value: `https://sv.wikipedia.org/wiki/${title}` },
});
const IMG = {
  image: { value: 'http://commons.wikimedia.org/wiki/Special:FilePath/X.jpg' },
};

test('one sight per item, its first kind, its article and image', () => {
  const sights = normalizeSights(
    {
      results: {
        bindings: [
          row(
            'Q1',
            'Uppsala slott',
            'manor',
            17.635,
            59.854,
            ART('Uppsala_slott'),
          ),
          row('Q1', 'Uppsala slott', 'castle', 17.635, 59.854, IMG),
          row('Q2', 'Gamla Uppsala', 'ancient', 17.63, 59.898, {
            ...ART('Gamla_Uppsala'),
            ...IMG,
          }),
          row('Q3', 'Q3', 'church', 17.6, 59.8),
          row('Q4', 'Fyr utan text', 'lighthouse', 17.64, 59.86),
          { item: { value: 'x' } },
        ],
      },
    },
    59.858,
    17.639,
  );
  assert.deepEqual(
    sights.map((s) => [s.id, s.kind, Boolean(s.article), Boolean(s.image)]),
    // Equal scores: the nearer first.
    [
      ['Q1', 'castle', true, true],
      ['Q2', 'ancient', true, true],
      ['Q4', 'lighthouse', false, false],
    ],
  );
  assert.equal(
    sights[0].image.startsWith('https://commons.wikimedia.org/'),
    true,
  );
  assert.ok(sights[1].km > 4 && sights[1].km < 5);
});

test('at most eight of a kind', () => {
  const bindings = Array.from({ length: 12 }, (_, i) =>
    row(
      `Q${i + 10}`,
      `Kyrka ${i}`,
      'church',
      17.6 + i / 1000,
      59.8,
      ART(`K${i}`),
    ),
  );
  bindings.push(row('Q99', 'Museet', 'museum', 17.7, 59.9));
  const sights = normalizeSights({ results: { bindings } }, 59.8, 17.6);
  assert.equal(sights.filter((s) => s.kind === 'church').length, 8);
  assert.ok(sights.some((s) => s.id === 'Q99'));
});

test('the query: within reach of the point, every kind asked for', () => {
  const query = sightsQuery(59.858, 17.639);
  assert.match(query, /Point\(17\.63900 59\.85800\)/);
  assert.match(query, /wikibase:radius "12"/);
  assert.match(query, /wd:Q170980 "runestone"/);
  assert.match(query, /wdt:P31\/wdt:P279\?/);
});

import { citySightsProxy as sightsProxy } from './citySights.js';

test('the nearest sights are the ones asked for', () => {
  const query = sightsQuery(59.33, 18.07);
  assert.ok(query.includes('bd:serviceParam wikibase:distance ?dist .'));
  assert.match(query, /ORDER BY \?dist\s+LIMIT 1500/);
});

test('after a failure Wikidata is left alone for a minute for that place', async (t) => {
  t.mock.method(console, 'warn', () => {});
  let clock = Date.parse('2026-11-05T18:00:00Z');
  let calls = 0;
  let handler;
  sightsProxy({
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      return new Response('', { status: 503 });
    },
  }).configureServer({ middlewares: { use: (path, fn) => (handler = fn) } });
  const get = async () => {
    const res = {
      destroyed: false,
      writeHead(status) {
        this.status = status;
      },
      end() {},
    };
    await handler(
      { method: 'GET', url: '/?lat=59.33&lon=18.07', headers: {}, socket: {} },
      res,
    );
    return res.status;
  };
  assert.equal(await get(), 502);
  assert.equal(calls, 1);
  clock += 30_000;
  assert.equal(await get(), 502);
  assert.equal(calls, 1);
  clock += 31_000;
  await get();
  assert.equal(calls, 2);
});

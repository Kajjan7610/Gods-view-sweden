import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KOLADA_DATA_URL,
  MIN_MUNICIPALITIES,
  STAT_KPIS,
  createKoladaStats,
  statsFor,
  statsTable,
  statsUrls,
} from './cityDossierStats.js';
import { cityDossierProxy } from './cityDossier.js';

const NOW = Date.parse('2026-11-12T10:00:00Z');
/** Kolada rows: one value per municipality code for a figure and year. */
const rows = (kpi, period, byCode, gender = 'T') =>
  Object.entries(byCode).map(([municipality, value]) => ({
    kpi,
    period,
    municipality,
    values: [{ gender, count: 1, status: null, value, isdeleted: false }],
  }));
/** `count` municipalities 0001…, valued 1…count. */
const many = (count, extra = {}) => ({
  ...Object.fromEntries(
    Array.from({ length: count }, (_, i) => [
      String(i + 1).padStart(4, '0'),
      i + 1,
    ]),
  ),
  ...extra,
});

test('one read asks for every figure, every municipality and Sweden', () => {
  const urls = statsUrls(2026);
  const ids = STAT_KPIS.map(([, id]) => id).join(',');
  assert.equal(
    urls.municipalities,
    `${KOLADA_DATA_URL}/${ids}/year/2023,2024,2025,2026?region_type=municipality&per_page=5000`,
  );
  assert.equal(
    urls.sweden,
    `${KOLADA_DATA_URL}/${ids}/municipality/0000/year/2023,2024,2025,2026`,
  );
  assert.ok(STAT_KPIS.length <= 25, "Kolada's limit on ids per request");
});

test('a town gets the newest year most municipalities have, its place and Sweden', () => {
  const table = statsTable([
    // 2025 is complete; 2026 has only a few early values and is not used.
    ...rows('N07540', 2025, many(MIN_MUNICIPALITIES, { '1880': 150.5 })),
    ...rows('N07540', 2026, { '1880': 999, '0001': 1 }),
    ...rows('N07540', 2025, { '0000': 120 }),
    // Ties share a place; a figure split by gender uses the total.
    ...rows('N15504', 2025, many(MIN_MUNICIPALITIES, { '1880': 100 })),
    ...rows('N15504', 2025, { '1880': 1 }, 'K'),
    // Too few municipalities in every year: left out.
    ...rows('N45850', 2025, { '1880': 4, '0001': 3 }),
  ]);
  const stats = statsFor(table, '1880');
  assert.deepEqual(
    stats.map(({ key, year, value, sweden, rank, count }) => [
      key,
      year,
      value,
      sweden,
      rank,
      count,
    ]),
    [
      ['meritValue', 2025, 100, null, MIN_MUNICIPALITIES - 99, MIN_MUNICIPALITIES + 1],
      ['reportedCrimes', 2025, 150.5, 120, MIN_MUNICIPALITIES - 149, MIN_MUNICIPALITIES + 1],
    ],
  );
  // Sweden is never a town of its own.
  assert.deepEqual(statsFor(table, '0000'), []);
});

test('the table is read page by page once a day, only from Kolada', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  let clock = NOW;
  const urls = [];
  const pages = {
    first: {
      values: rows('N07540', 2025, many(150)),
      next_url: `${KOLADA_DATA_URL}/N07540/year/2025?page=2`,
    },
    second: {
      values: rows('N07540', 2025, {
        ...Object.fromEntries(
          Array.from({ length: 100 }, (_, i) => [
            String(i + 500).padStart(4, '0'),
            7,
          ]),
        ),
        1880: 9,
      }),
      next_url: 'https://elsewhere.example/steal',
    },
  };
  const stats = createKoladaStats({
    now: () => clock,
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (String(url).includes('page=2')) return Response.json(pages.second);
      if (String(url).includes('/municipality/0000/'))
        return Response.json({ values: rows('N07540', 2025, { '0000': 8 }) });
      return Response.json(pages.first);
    },
  });
  const answer = await stats.forMunicipality('1880');
  assert.equal(answer.stats[0].value, 9);
  assert.equal(answer.stats[0].sweden, 8);
  assert.equal(urls.length, 3, 'two pages and Sweden; the foreign link is not followed');
  clock += 23 * 60 * 60_000;
  await stats.forMunicipality('0114');
  assert.equal(urls.length, 3, 'one table serves every town for a day');
  clock += 2 * 60 * 60_000;
  await stats.forMunicipality('1880');
  assert.equal(urls.length, 6);
});

test('a failed read keeps the last table, and leaves Kolada alone for a while', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  let clock = NOW;
  let down = false;
  let calls = 0;
  const stats = createKoladaStats({
    now: () => clock,
    fetchImpl: async () => {
      calls += 1;
      if (down) return new Response('down', { status: 503 });
      return Response.json({
        values: rows('N07540', 2025, many(MIN_MUNICIPALITIES, { '1880': 5 })),
      });
    },
  });
  await stats.forMunicipality('1880');
  down = true;
  clock += 25 * 60 * 60_000;
  assert.equal((await stats.forMunicipality('1880')).stats[0].value, 5);
  const asked = calls;
  clock += 60_000;
  await stats.forMunicipality('1880');
  assert.equal(calls, asked, 'left alone after the failure');
  const fresh = createKoladaStats({
    now: () => NOW,
    fetchImpl: async () => new Response('down', { status: 503 }),
  });
  assert.equal(await fresh.forMunicipality('1880'), null);
});

test('the dossier route answers a municipality code, and only one', async () => {
  let handler;
  cityDossierProxy({
    statistics: {
      forMunicipality: async (code) =>
        code === '1880' ? { stats: [{ key: 'meritValue' }], fetchedAt: NOW } : null,
    },
  }).configureServer({ middlewares: { use: (_path, fn) => (handler = fn) } });
  const request = async (url) => {
    const res = {
      destroyed: false,
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ method: 'GET', url, headers: {}, socket: {} }, res);
    return { status: res.status, json: JSON.parse(res.body) };
  };
  const ok = await request('/stats?code=1880');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, {
    code: '1880',
    stats: [{ key: 'meritValue' }],
    fetchedAt: NOW,
  });
  assert.equal((await request('/stats?code=0114')).status, 502);
  for (const bad of ['/stats', '/stats?code=0000', '/stats?code=18800', '/stats?code=../x'])
    assert.equal((await request(bad)).status, 400, bad);
});

// Krisinformation.se: a message as read (either field casing), its areas'
// points, and the route's two-minute cache with its fallback.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KRISINFORMATION_URL,
  firstPoint,
  krisinformationProxy,
  normalizeMessage,
} from './krisinformation.js';

const news = {
  identifier: 'n1',
  headline: 'Sverige förlänger inre gränskontroller',
  preamble: '<p>Regeringen har beslutat …</p>',
  published: '2026-11-05T10:00:00+01:00',
  web: 'https://www.krisinformation.se/aktuellt/nyheter/x/',
  senderName: 'Polisen',
  area: [{ type: 'Country', description: 'Sverige', coordinate: null }],
};

test('a message: plain text, link, sender, areas', () => {
  const row = normalizeMessage(news, 'news');
  assert.equal(row.headline, 'Sverige förlänger inre gränskontroller');
  assert.equal(row.preamble, 'Regeringen har beslutat …');
  assert.equal(row.published, Date.parse('2026-11-05T09:00:00Z'));
  assert.deepEqual(row.areas, [
    { type: 'Country', name: 'Sverige', point: null },
  ]);
  const vma = normalizeMessage(
    {
      Identifier: 'v1',
      Headline: 'VMA: Brand i industribyggnad',
      Web: 'javascript:alert(1)',
      Area: [
        {
          Type: 'Municipality',
          Description: 'Västerås kommun',
          CoordinateObject: { Latitude: 59.61, Longitude: 16.55 },
        },
      ],
    },
    'vma',
  );
  assert.equal(vma.kind, 'vma');
  assert.equal(vma.web, null, 'only https links');
  assert.deepEqual(vma.areas[0].point, { lat: 59.61, lon: 16.55 });
  assert.equal(normalizeMessage({}, 'news'), null);
});

test('an area point from a coordinate string, in either order', () => {
  assert.deepEqual(firstPoint({ coordinate: '16.55 59.61' }), {
    lat: 59.61,
    lon: 16.55,
  });
  assert.deepEqual(firstPoint({ coordinate: '59.61,16.55 59.7,16.6' }), {
    lat: 59.61,
    lon: 16.55,
  });
  assert.equal(firstPoint({ coordinate: null }), null);
});

test('the route keeps two minutes and falls back on the last read', async () => {
  const urls = [];
  let clock = 0;
  let fail = false;
  const proxy = krisinformationProxy({
    fetchImpl: async (url) => {
      urls.push(url);
      if (fail) return new Response('', { status: 503 });
      return new Response(JSON.stringify(url.includes('/news') ? [news] : []));
    },
    now: () => clock,
  });
  let handler = null;
  proxy.configureServer({ middlewares: { use: (path, fn) => (handler = fn) } });
  const get = async () => {
    const res = {
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ method: 'GET', url: '/', headers: {}, socket: {} }, res);
    return res;
  };
  const first = await get();
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.vmas, []);
  assert.equal(first.body.news[0].headline, news.headline);
  assert.ok(urls.includes(`${KRISINFORMATION_URL}/vmas`));
  await get();
  assert.equal(urls.length, 2, 'kept');
  clock += 3 * 60_000;
  fail = true;
  const stale = await get();
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.news.length, 1);
});

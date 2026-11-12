import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
  MAX_AREAS,
  PROTECTED_NATURE_FILE,
  protectedNatureProxy,
} from './protectedNature.js';
import { decodeLine } from '../../src/layers/protectedNature/records.js';

function harness(options) {
  let route;
  let handler;
  protectedNatureProxy(options).configureServer({
    middlewares: { use: (path, fn) => ((route = path), (handler = fn)) },
  });
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
  return Object.assign(request, { route: () => route });
}

const box = (w, s, e, n) => `/?west=${w}&south=${s}&east=${e}&north=${n}`;
const area = (i, t, lon, lat) => ({
  i,
  t,
  b: [lon - 0.01, lat - 0.01, lon + 0.01, lat + 0.01],
});

test('a view gets its areas from the snapshot, read once', async (t) => {
  t.mock.method(console, 'log', () => {});
  let reads = 0;
  const request = harness({
    read: async () => {
      reads += 1;
      return JSON.stringify({
        source: 'Naturvårdsverket',
        built: '2026-11-12',
        areas: [
          area('tyresta', 'np', 18.27, 59.18),
          area('reserve', 'nr', 18.05, 59.3),
          area('fulufjallet', 'np', 12.7, 61.55),
        ],
      });
    },
  });
  assert.equal(request.route(), '/api/protected-nature');
  const close = await request(box(17.9, 59.1, 18.4, 59.4));
  assert.equal(close.status, 200);
  assert.deepEqual(close.json.areas.map(({ i }) => i).sort(), [
    'reserve',
    'tyresta',
  ]);
  assert.equal(close.json.wide, false);
  assert.equal(close.json.capped, false);
  assert.equal(close.json.source, 'Naturvårdsverket');
  // All of Sweden: the national parks alone.
  const wide = await request(box(10, 55, 24.5, 69.2));
  assert.equal(wide.json.wide, true);
  assert.deepEqual(wide.json.areas.map(({ i }) => i).sort(), [
    'fulufjallet',
    'tyresta',
  ]);
  assert.equal(reads, 1);
});

test('a view must be a box', async () => {
  const request = harness({ read: async () => '{"areas":[]}' });
  for (const url of ['/', box('x', 59, 18, 60), box(18, 59, 17, 60)])
    assert.equal((await request(url)).status, 400, url);
});

test('an unreadable snapshot answers 502', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const request = harness({ read: async () => '{"nothing":true}' });
  const answer = await request(box(17.9, 59.1, 18.4, 59.4));
  assert.equal(answer.status, 502);
  assert.equal(answer.json.error, 'protected_nature_unavailable');
});

test('the bundled snapshot holds the national parks and reserves in Sweden', () => {
  const snapshot = JSON.parse(readFileSync(PROTECTED_NATURE_FILE, 'utf8'));
  assert.equal(snapshot.source, 'Naturvårdsverket');
  const count = (kind) => snapshot.areas.filter(({ t }) => t === kind).length;
  assert.ok(count('np') >= 25, `${count('np')} national parks`);
  assert.ok(count('nr') >= 5000, `${count('nr')} nature reserves`);
  assert.ok(count('kr') >= 30, `${count('kr')} culture reserves`);
  for (const { b } of snapshot.areas)
    assert.ok(b[0] > 10 && b[2] < 24.5 && b[1] > 55 && b[3] < 69.2, b.join());
  // Fulufjället's outer ring, not just its enclaves: it spans some 20 km.
  const fulufjallet = snapshot.areas.find(({ n }) => n === 'Fulufjället');
  assert.equal(fulufjallet.t, 'np');
  const [w, s, e, n] = fulufjallet.b;
  assert.ok(w < 12.6 && e > 12.85 && s < 61.45 && n > 61.6, fulufjallet.b.join());
  const outer = decodeLine(fulufjallet.g[0][0]);
  assert.ok(outer.length > 20);
  assert.ok(MAX_AREAS >= 1000);
});

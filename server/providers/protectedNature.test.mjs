import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import {
  ACCESS_BANS_FILE,
  CLOSE_BELOW_DEG,
  MAX_AREAS,
  NATURA_2000_FILE,
  PROTECTED_NATURE_FILE,
  WIDE_ABOVE_DEG,
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
const snapshot = (...areas) =>
  JSON.stringify({ source: 'Naturvårdsverket', built: '2026-11-12', areas });
/** Each bundled file's areas, and the files read, in order. */
function files() {
  const reads = [];
  const read = async (file) => {
    reads.push(path.basename(file));
    if (file === NATURA_2000_FILE)
      return snapshot(area('SE0110001', 'n2k', 18.1, 59.3));
    if (file === ACCESS_BANS_FILE)
      return snapshot(area('tf1', 'ban', 18.2, 59.25));
    return snapshot(
      area('tyresta', 'np', 18.27, 59.18),
      area('reserve', 'nr', 18.05, 59.3),
      area('fulufjallet', 'np', 12.7, 61.55),
    );
  };
  return { read, reads };
}
const ids = (answer) => answer.json.areas.map(({ i }) => i).sort();

test('a view gets its areas from the snapshots, each read once', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { read, reads } = files();
  const request = harness({ read });
  assert.equal(request.route(), '/api/protected-nature');
  // All of Sweden: the national parks alone, the files kept apart unread.
  const wide = await request(box(10, 55, 24.5, 69.2));
  assert.equal(wide.status, 200);
  assert.equal(wide.json.wide, true);
  assert.equal(wide.json.close, false);
  assert.deepEqual(ids(wide), ['fulufjallet', 'tyresta']);
  assert.deepEqual(reads, ['protected-nature.json']);
  // A county: the reserves too, still no Natura 2000 areas or bans.
  const middle = await request(box(16.9, 58.5, 19.4, 60));
  assert.deepEqual([middle.json.wide, middle.json.close], [false, false]);
  assert.deepEqual(ids(middle), ['reserve', 'tyresta']);
  assert.deepEqual(reads, ['protected-nature.json']);
  // Close: everything in the view.
  const close = await request(box(17.9, 59.1, 18.4, 59.4));
  assert.equal(close.status, 200);
  assert.deepEqual(ids(close), ['SE0110001', 'reserve', 'tf1', 'tyresta']);
  assert.deepEqual([close.json.wide, close.json.close], [false, true]);
  assert.equal(close.json.capped, false);
  assert.equal(close.json.source, 'Naturvårdsverket');
  assert.equal(close.json.built, '2026-11-12');
  await request(box(17.9, 59.1, 18.4, 59.4));
  assert.deepEqual(reads, [
    'protected-nature.json',
    'natura2000.json',
    'access-bans.json',
  ]);
  assert.ok(CLOSE_BELOW_DEG < WIDE_ABOVE_DEG);
});

test('a kind the layer switched off is left out, and its file unread', async (t) => {
  t.mock.method(console, 'log', () => {});
  const { read, reads } = files();
  const request = harness({ read });
  const noNatura = await request(`${box(17.9, 59.1, 18.4, 59.4)}&skip=n2k`);
  assert.deepEqual(ids(noNatura), ['reserve', 'tf1', 'tyresta']);
  assert.deepEqual(reads, ['protected-nature.json', 'access-bans.json']);
  const neither = await request(`${box(17.9, 59.1, 18.4, 59.4)}&skip=n2k,ban`);
  assert.deepEqual(ids(neither), ['reserve', 'tyresta']);
  // Switched on again: the files already read are not read again.
  const both = await request(box(17.9, 59.1, 18.4, 59.4));
  assert.deepEqual(ids(both), ['SE0110001', 'reserve', 'tf1', 'tyresta']);
  assert.deepEqual(reads, [
    'protected-nature.json',
    'access-bans.json',
    'natura2000.json',
  ]);
});

test('a view must be a box', async () => {
  const request = harness({ read: async () => '{"areas":[]}' });
  for (const url of ['/', box('x', 59, 18, 60), box(18, 59, 17, 60)])
    assert.equal((await request(url)).status, 400, url);
});

test('an unreadable snapshot answers 502, and is read again next time', async (t) => {
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  let good = false;
  const request = harness({
    read: async () => (good ? snapshot() : '{"nothing":true}'),
  });
  const answer = await request(box(17.9, 59.1, 18.4, 59.4));
  assert.equal(answer.status, 502);
  assert.equal(answer.json.error, 'protected_nature_unavailable');
  good = true;
  assert.equal((await request(box(17.9, 59.1, 18.4, 59.4))).status, 200);
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
  assert.ok(
    w < 12.6 && e > 12.85 && s < 61.45 && n > 61.6,
    fulufjallet.b.join(),
  );
  const outer = decodeLine(fulufjallet.g[0][0]);
  assert.ok(outer.length > 20);
  assert.ok(MAX_AREAS >= 1000);
});

/** The fields an area may carry: never species, habitats or descriptions. */
const FIELDS = new Set([
  'i',
  'r',
  'n',
  't',
  'd',
  's',
  'p',
  'y',
  'k',
  'h',
  'b',
  'g',
]);

test('the bundled Natura 2000 file holds every site once, small and plain', () => {
  const text = readFileSync(NATURA_2000_FILE, 'utf8');
  assert.ok(text.length < 4e6, `${text.length} bytes`);
  const { source, areas } = JSON.parse(text);
  assert.equal(source, 'Naturvårdsverket');
  assert.ok(areas.length >= 4000, `${areas.length} sites`);
  assert.equal(new Set(areas.map(({ i }) => i)).size, areas.length);
  const designations = new Set(areas.map(({ d }) => d));
  assert.deepEqual([...designations].sort(), ['sci', 'spa', 'spa-sci']);
  for (const site of areas) {
    assert.equal(site.t, 'n2k');
    assert.match(site.i, /^SE\d{7}$/);
    for (const key of Object.keys(site)) assert.ok(FIELDS.has(key), key);
    const [w, s, e, n] = site.b;
    assert.ok(w > 10 && e < 24.5 && s > 55 && n < 69.2, site.b.join());
    // No site drawn with more points than the build allows.
    const points = site.g
      .flat()
      .reduce((sum, ring) => sum + ring.length / 2, 0);
    assert.ok(points <= 8000, `${site.n}: ${points} points`);
  }
});

test('the bundled bans are in force, by reason and period, with no description', () => {
  const text = readFileSync(ACCESS_BANS_FILE, 'utf8');
  assert.ok(text.length < 1.5e6, `${text.length} bytes`);
  const { areas } = JSON.parse(text);
  assert.ok(areas.length >= 1000, `${areas.length} bans`);
  for (const ban of areas) {
    assert.equal(ban.t, 'ban');
    assert.match(ban.i, /^tf\d+$/);
    assert.ok(['bird', 'seal', 'birdSeal', 'other'].includes(ban.s), ban.s);
    for (const key of Object.keys(ban)) assert.ok(FIELDS.has(key), key);
    if (ban.p) assert.equal(ban.p.length, 4);
  }
  assert.ok(areas.filter(({ p }) => p).length > areas.length * 0.95);
  assert.ok(!/beträda|landa med båt/i.test(text), 'no ban description');
  // A small ban for another reason (a cliff, a raptor's nest) is left out.
  const smallOther = areas.filter(({ s, h }) => s === 'other' && !(h >= 5));
  assert.deepEqual(
    smallOther.map(({ n }) => n),
    [],
  );
});

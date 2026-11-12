import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ELECTION_DISTRICTS_FILE,
  MAX_DISTRICTS,
  electionDistrictsProxy,
} from './electionDistricts.js';
import { readFileSync } from 'node:fs';

function harness(options) {
  let route;
  let handler;
  electionDistrictsProxy(options).configureServer({
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

test('a view gets its districts from the snapshot, read once', async (t) => {
  t.mock.method(console, 'log', () => {});
  let reads = 0;
  const district = (c, lon, lat) => ({
    c,
    b: [lon - 0.01, lat - 0.01, lon + 0.01, lat + 0.01],
  });
  const request = harness({
    read: async () => {
      reads += 1;
      return JSON.stringify({
        source: 'Valmyndigheten',
        election: 'Riksdag 2026',
        built: '2026-11-12',
        districts: [district('a', 18.06, 59.33), district('b', 11.97, 57.7)],
      });
    },
  });
  assert.equal(request.route(), '/api/election-districts');
  const answer = await request(box(17.9, 59.2, 18.2, 59.5));
  assert.equal(answer.status, 200);
  assert.deepEqual(
    answer.json.districts.map(({ c }) => c),
    ['a'],
  );
  assert.equal(answer.json.capped, false);
  assert.equal(answer.json.source, 'Valmyndigheten');
  await request(box(11.8, 57.6, 12.1, 57.8));
  assert.equal(reads, 1);
});

test('a view must be a small box: the whole country is not sent at once', async () => {
  const request = harness({ read: async () => '{"districts":[]}' });
  for (const url of [
    '/',
    box('x', 59, 18, 60),
    box(18, 59, 17, 60),
    box(10, 55, 24, 69),
  ])
    assert.equal((await request(url)).status, 400, url);
});

test('the bundled snapshot holds every district with its votes', () => {
  const snapshot = JSON.parse(readFileSync(ELECTION_DISTRICTS_FILE, 'utf8'));
  assert.equal(snapshot.source, 'Valmyndigheten');
  assert.ok(snapshot.districts.length > 6000);
  const withVotes = snapshot.districts.filter((d) => Number.isFinite(d.v));
  assert.equal(withVotes.length, snapshot.districts.length);
  // Every box lies in Sweden.
  for (const { b } of snapshot.districts)
    assert.ok(b[0] > 10 && b[2] < 24.5 && b[1] > 55 && b[3] < 69.2, b.join());
  assert.ok(MAX_DISTRICTS >= 1000);
});

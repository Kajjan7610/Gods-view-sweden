// The Kiruna all-sky camera route: one picture a minute from the IRF, served
// as a JPEG, never older than ten minutes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { KIRUNA_ALLSKY_URL, kirunaAllskyProxy } from './kirunaAllsky.js';

async function call(plugin) {
  let handler;
  plugin.configureServer({
    middlewares: { use: (_path, fn) => (handler = fn) },
  });
  return new Promise((resolve) => {
    const res = {
      destroyed: false,
      writeHead(status, headers = {}) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        resolve({ status: this.status, headers: this.headers, body });
      },
    };
    handler(
      { method: 'GET', url: '/', headers: { 'sec-fetch-site': 'same-origin' } },
      res,
      () => resolve({ status: 404 }),
    );
  });
}

const jpeg = () =>
  new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {
    headers: { 'content-type': 'image/jpeg' },
  });

test('one picture a minute however many ask; older than ten minutes is none', async () => {
  let clock = 0;
  const asked = [];
  let down = false;
  const proxy = kirunaAllskyProxy({
    now: () => clock,
    fetchImpl: async (url) => {
      asked.push(url);
      return down ? new Response('', { status: 503 }) : jpeg();
    },
  });
  const first = await call(proxy);
  assert.equal(first.status, 200);
  assert.equal(first.headers['Content-Type'], 'image/jpeg');
  assert.equal(first.body.length, 4);
  await call(proxy);
  assert.deepEqual(asked, [KIRUNA_ALLSKY_URL]);
  clock += 61_000;
  down = true;
  assert.equal((await call(proxy)).status, 200, 'the last picture stands in');
  clock += 10 * 60_000;
  assert.equal((await call(proxy)).status, 502);
});

test('an answer that is not a JPEG is refused', async () => {
  const proxy = kirunaAllskyProxy({
    fetchImpl: async () =>
      new Response('<html>', { headers: { 'content-type': 'text/html' } }),
  });
  assert.equal((await call(proxy)).status, 502);
});

test('a picture the camera took long ago is not shown, however newly fetched', async () => {
  const clock = Date.parse('2026-11-19T15:00:00Z');
  const proxy = kirunaAllskyProxy({
    now: () => clock,
    fetchImpl: async () =>
      new Response(new Uint8Array([0xff, 0xd8]), {
        headers: {
          'content-type': 'image/jpeg',
          // The camera paused by day: the file is from the morning.
          'last-modified': 'Thu, 19 Nov 2026 07:13:00 GMT',
        },
      }),
  });
  assert.equal((await call(proxy)).status, 502);
});

// The hospital route serves the bundled snapshot and never fetches.
import assert from 'node:assert/strict';
import test from 'node:test';
import { hospitalsProxy } from './hospitals.js';

function route(options) {
  let handler = null;
  hospitalsProxy(options).configureServer({
    middlewares: { use: (path, fn) => (handler = fn) },
  });
  return async (url = '/', method = 'GET') => {
    const res = {
      destroyed: false,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ method, url, headers: {}, socket: {} }, res);
    return res;
  };
}

test('the route reads the snapshot once and serves it', async () => {
  let reads = 0;
  const get = route({
    read: async () => {
      reads++;
      return JSON.stringify({ hospitals: [{ id: 'n1' }] });
    },
  });
  const first = await get();
  assert.equal(first.status, 200);
  assert.deepEqual(first.body.hospitals, [{ id: 'n1' }]);
  await get();
  assert.equal(reads, 1);
  assert.equal((await get('/x')).status, 404);
  assert.equal((await get('/', 'POST')).status, 405);
});

test('a missing or malformed snapshot is unavailable, not a crash', async () => {
  const missing = route({
    read: async () => {
      throw new Error('ENOENT');
    },
  });
  assert.equal((await missing()).status, 502);
  const malformed = route({ read: async () => '{"hospitals":5}' });
  assert.equal((await malformed()).body.error, 'hospitals_unavailable');
});

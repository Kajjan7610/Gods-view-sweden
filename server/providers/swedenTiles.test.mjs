// Inside Sweden the traffic layer never asks TomTom: the proxy answers the
// tiles that touch Sweden with an empty tile, and fetches nothing.
import assert from 'node:assert/strict';
import test from 'node:test';
import { boxTouchesSweden, tileTouchesSweden } from './swedenTiles.js';
import { tomtomProxy } from './traffic.js';

/** The z12 tile over a place. */
const tileAt = (lon, lat, z = 12) => {
  const n = 2 ** z;
  const r = (lat * Math.PI) / 180;
  return [
    z,
    Math.floor(((lon + 180) / 360) * n),
    Math.floor(
      ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n,
    ),
  ];
};

test('the tiles over Swedish towns touch Sweden, the neighbours’ do not', () => {
  for (const [lon, lat] of [
    [18.06, 59.33], // Stockholm
    [11.97, 57.71], // Göteborg
    [20.22, 67.85], // Kiruna
    [24.14, 65.83], // Haparanda
  ])
    assert.equal(tileTouchesSweden(...tileAt(lon, lat)), true, `${lon},${lat}`);
  for (const [lon, lat] of [
    [10.75, 59.91], // Oslo
    [24.94, 60.17], // Helsingfors
    [12.57, 55.68], // Köpenhamn
    [17.43, 68.44], // Narvik
    [-0.12, 51.5], // London
  ])
    assert.equal(
      tileTouchesSweden(...tileAt(lon, lat)),
      false,
      `${lon},${lat}`,
    );
  // A box around the whole of Scandinavia touches Sweden too.
  assert.equal(
    boxTouchesSweden({ west: 4, east: 32, south: 54, north: 72 }),
    true,
  );
});

/** Call the proxy as the dev server would. */
function request(url) {
  let handler;
  tomtomProxy().configureServer({
    middlewares: { use: (_path, fn) => (handler = fn) },
  });
  return new Promise((resolve) => {
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        this.status = status;
        this.headers = headers;
      },
      end(body) {
        resolve({ status: this.status, headers: this.headers, body });
      },
    };
    handler(
      {
        method: 'GET',
        url,
        headers: { host: 'localhost:4173', 'sec-fetch-site': 'same-origin' },
        socket: {},
      },
      res,
    );
  });
}

test('a tile over Sweden is answered empty without asking TomTom', async (t) => {
  const key = process.env.TOMTOM_API_KEY;
  const fetch = globalThis.fetch;
  const asked = [];
  process.env.TOMTOM_API_KEY = 'test-key';
  globalThis.fetch = async (url) => {
    asked.push(String(url));
    throw new Error('offline');
  };
  t.after(() => {
    globalThis.fetch = fetch;
    if (key === undefined) delete process.env.TOMTOM_API_KEY;
    else process.env.TOMTOM_API_KEY = key;
  });
  const [z, x, y] = tileAt(18.06, 59.33);
  const answer = await request(`/flow/${z}/${x}/${y}.pbf`);
  assert.equal(answer.status, 200);
  assert.equal(answer.headers['x-tomtom-cache'], 'SKIP-SWEDEN');
  assert.equal(answer.body.length, 0);
  assert.deepEqual(asked, [], 'TomTom is never asked for Sweden');
});

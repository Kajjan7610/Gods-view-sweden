// The road ferry route: one Trafikverket request with three queries, the key
// in the body only, and the time window from the server's clock.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  trafikverketFerriesProxy,
  trafikverketFerriesQuery,
} from './trafikverketFerries.js';
import { TRAFIKVERKET_API_URL } from './trafikverketProxy.js';

test('the query asks for routes, the next three hours and ferry messages', () => {
  const body = trafikverketFerriesQuery('k&"', Date.parse('2026-11-13T13:00:00Z'));
  assert.match(body, /authenticationkey="k&amp;&quot;"/);
  assert.match(body, /objecttype="FerryRoute"/);
  assert.match(body, /objecttype="FerryAnnouncement"/);
  assert.match(body, /value="Färjor"/);
  assert.match(body, /<GT name="DepartureTime" value="2026-11-13T12:55:00.000Z" \/>/);
  assert.match(body, /<LT name="DepartureTime" value="2026-11-13T16:00:00.000Z" \/>/);
});

/** Call the route's handler as the dev server would. */
async function call(plugin, url = '/') {
  let handler;
  plugin.configureServer({
    middlewares: { use: (_path, fn) => (handler = fn) },
  });
  return new Promise((resolve) => {
    const res = {
      destroyed: false,
      status: 0,
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        resolve({ status: this.status, body: JSON.parse(body) });
      },
    };
    handler(
      { method: 'GET', url, headers: { 'sec-fetch-site': 'same-origin' } },
      res,
      () => resolve({ status: 404 }),
    );
  });
}

test('the route answers routes with the key and not_configured without', async () => {
  const bodies = [];
  const fetchImpl = async (url, init) => {
    assert.equal(url, TRAFIKVERKET_API_URL);
    bodies.push(init.body);
    return new Response(
      JSON.stringify({
        RESPONSE: {
          RESULT: [
            {
              FerryRoute: [
                {
                  Id: 1,
                  Name: 'Vaxholmsleden',
                  Geometry: { WGS84: 'POINT (18.359 59.4)' },
                },
              ],
            },
            { FerryAnnouncement: [] },
            { Situation: [] },
          ],
        },
      }),
    );
  };
  const keyed = await call(
    trafikverketFerriesProxy({ fetchImpl, env: { TRAFIKVERKET_API_KEY: 'k' } }),
  );
  assert.equal(keyed.status, 200);
  assert.equal(keyed.body.routes[0].name, 'Vaxholmsleden');
  assert.equal(keyed.body.routes[0].status, 'idle');
  assert.equal(bodies.length, 1);
  const keyless = await call(trafikverketFerriesProxy({ fetchImpl, env: {} }));
  assert.equal(keyless.status, 503);
  assert.equal(bodies.length, 1, 'no request without the key');
});

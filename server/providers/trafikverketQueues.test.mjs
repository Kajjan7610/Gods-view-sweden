// The queues route: one Trafikverket request with two queries, the key in
// the body only, and one snapshot shared with the city dossier.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  trafikverketQueuesProxy,
  trafikverketQueuesQuery,
} from './trafikverketQueues.js';
import { TRAFIKVERKET_API_URL } from './trafikverketProxy.js';

test('the query asks for travel times and the last 20 minutes of detectors with their normals', () => {
  const body = trafikverketQueuesQuery(
    'k&"',
    Date.parse('2026-11-18T10:20:00Z'),
  );
  assert.match(body, /authenticationkey="k&amp;&quot;"/);
  assert.match(
    body,
    /objecttype="TravelTimeRoute" namespace="Road.TrafficInfo" schemaversion="1.6"/,
  );
  assert.match(
    body,
    /objecttype="TrafficFlow" namespace="Road.TrafficInfo" schemaversion="1.6"/,
  );
  assert.match(body, /<INCLUDE>BaselineTraffic.Speed.Mean<\/INCLUDE>/);
  assert.match(
    body,
    /<GT name="MeasurementTime" value="2026-11-18T10:00:00.000Z" \/>/,
  );
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

test('the route and the dossier share one snapshot; nothing is asked without the key', async () => {
  const now = Date.parse('2026-11-18T10:20:00Z');
  const bodies = [];
  const fetchImpl = async (url, init) => {
    assert.equal(url, TRAFIKVERKET_API_URL);
    bodies.push(init.body);
    return new Response(
      JSON.stringify({
        RESPONSE: {
          RESULT: [
            {
              TravelTimeRoute: [
                {
                  Id: '674',
                  Name: 'Sotartunneln',
                  TrafficStatus: 'heavy',
                  TravelTime: 80,
                  FreeFlowTravelTime: 31,
                  MeasureTime: '2026-11-18T11:18:00.000+01:00',
                  Geometry: { WGS84: 'LINESTRING (18.05 59.31, 18.06 59.312)' },
                },
              ],
            },
            { TrafficFlow: [] },
          ],
        },
      }),
    );
  };
  const proxy = trafikverketQueuesProxy({
    fetchImpl,
    now: () => now,
    env: { TRAFIKVERKET_API_KEY: 'k' },
  });
  const keyed = await call(proxy);
  assert.equal(keyed.status, 200);
  assert.equal(keyed.body.routes[0].status, 'heavy');
  assert.deepEqual(keyed.body.points, []);
  const shared = await proxy.read();
  assert.equal(shared.routes[0].name, 'Sotartunneln');
  assert.equal(bodies.length, 1, 'the dossier reads the cached snapshot');
  const keyless = trafikverketQueuesProxy({ fetchImpl, env: {} });
  assert.equal((await call(keyless)).status, 503);
  assert.equal(await keyless.read(), null);
  assert.equal(bodies.length, 1, 'no request without the key');
});

// The historical orthophoto route: Lantmäteriet's WMS behind a same-site,
// cached, budgeted proxy whose Geotorget login never leaves the server. Every
// upstream answer here is a fetch double; nothing is asked of Lantmäteriet.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AUTH_RETRY_MS,
  FAILED_TILE_RETRY_MS,
  HISTORICAL_ORTHO_LAYERS,
  RETRY_AFTER_DEFAULT_MS,
  RETRY_AFTER_MAX_MS,
  WMS_PRODUCTION_URL,
  WMS_VERIFICATION_URL,
  historicalOrthoProxy,
  isPng,
  mercatorTileBBox,
  parseWmsLayerNames,
  tileNearSweden,
} from './historicalOrtho.js';
import { lonLatToTile } from '../../src/data/tomtomTiles.js';

const USER = 'fixture-user';
const PASS = 'fixture-pass-9Zq';
const LOGIN = { GEOTORGET_USERNAME: USER, GEOTORGET_PASSWORD: PASS };
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('fixture-png-body'),
  // The empty IEND chunk every complete PNG ends with.
  Buffer.from([0, 0, 0, 0, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]),
]);
const STOCKHOLM = lonLatToTile(18.07, 59.33, 12);
const UPPSALA = lonLatToTile(17.64, 59.86, 12);
const MADRID = lonLatToTile(-3.7, 40.42, 12);
const BERLIN = lonLatToTile(13.4, 52.52, 12);
const tileUrl = (layer, { x, y }, z = 12) =>
  `/tile/${layer}/${z}/${x}/${y}.png`;
const pngResponse = (body = PNG, type = 'image/png') =>
  new Response(body, { status: 200, headers: { 'content-type': type } });
const CAPABILITIES = `<?xml version="1.0"?>
<WMT_MS_Capabilities version="1.1.1"><Capability>
  <Layer><Title>Historiska ortofoton</Title>
    <Layer queryable="0"><Name>OI.Histortho_60</Name><Title>1960</Title>
      <Style><Name>OI.OrthoimageCoverage.Default</Name></Style></Layer>
    <Layer>
      <Name> OI.Histortho_bw_1993 </Name>
    </Layer>
    <Layer><Title>No name</Title><Style><Name>only-a-style</Name></Style></Layer>
    <Layer><Name>OI.Histortho_60</Name></Layer>
  </Layer>
</Capability></WMT_MS_Capabilities>`;

async function harness(
  t,
  { env = {}, fetchImpl, at = Date.UTC(2026, 10, 21, 12) } = {},
) {
  const cacheDir = await mkdtemp(
    path.join(os.tmpdir(), 'gev-historical-ortho-'),
  );
  // A budget write may still be landing: let it, and retry the removal.
  t.after(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    await rm(cacheDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 20,
    });
  });
  const logs = [];
  t.mock.method(console, 'warn', (...args) => logs.push(args.join(' ')));
  t.mock.method(console, 'log', (...args) => logs.push(args.join(' ')));
  const calls = [];
  const clock = { at };
  const environment = { ...env };
  const answer = fetchImpl ?? (async () => pngResponse());
  const build = () => {
    let handler;
    historicalOrthoProxy({
      fetchImpl: async (url, options) => {
        calls.push({ url: new URL(url), options });
        return answer(new URL(url), options, calls.length);
      },
      now: () => clock.at,
      cacheDir,
      env: environment,
    }).configureServer({
      middlewares: {
        use: (mount, fn) => {
          assert.equal(mount, '/api/historiska-ortofoton');
          handler = fn;
        },
      },
    });
    return handler;
  };
  let handler = build();
  const request = async (
    url,
    headers = { host: 'localhost:4173' },
    { onClose } = {},
  ) => {
    const res = {
      statusCode: 0,
      headers: {},
      headersSent: false,
      destroyed: false,
      setHeader(name, value) {
        this.headers[name.toLowerCase()] = value;
      },
      writeHead(status, head = {}) {
        this.statusCode = status;
        for (const [name, value] of Object.entries(head))
          this.headers[name.toLowerCase()] = value;
        this.headersSent = true;
      },
      end(body) {
        this.body = body;
      },
      once(event, fn) {
        if (event === 'close') onClose?.(fn);
      },
    };
    await handler({ method: 'GET', url, headers, socket: {} }, res);
    const text = Buffer.isBuffer(res.body) ? null : String(res.body ?? '');
    return {
      status: res.statusCode,
      headers: res.headers,
      body: res.body,
      json: text ? JSON.parse(text) : null,
    };
  };
  const restart = () => {
    handler = build();
  };
  return { request, calls, logs, clock, environment, cacheDir, restart };
}

/** Wait until `done()` (at most `ms`), letting timers and I/O run. */
async function until(done, ms = 2000) {
  const end = Date.now() + ms;
  while (!done() && Date.now() < end)
    await new Promise((resolve) => setTimeout(resolve, 2));
}

/** No answer, header or log line may carry the login or the upstream URL. */
function assertNothingLeaked({ logs }, ...responses) {
  const basic = Buffer.from(`${USER}:${PASS}`).toString('base64');
  for (const text of [
    ...logs,
    ...responses.map((r) => JSON.stringify(r.json) + JSON.stringify(r.headers)),
  ]) {
    assert.ok(!text.includes(PASS), 'no password');
    assert.ok(!text.includes(basic), 'no Basic header');
    assert.ok(!text.includes('lantmateriet.se'), 'no upstream URL');
  }
}

test('the tile box is the web-mercator box of the XYZ tile', () => {
  const half = Math.PI * 6378137;
  assert.deepEqual(mercatorTileBBox(0, 0, 0), [-half, -half, half, half]);
  const [minX, minY, maxX, maxY] = mercatorTileBBox(1, 1, 0);
  assert.equal(minX, 0);
  assert.equal(minY, 0);
  assert.equal(maxX, half);
  assert.equal(maxY, half);
});

test('the allow-list holds the spec’s layers and nothing else', () => {
  assert.deepEqual(
    Object.keys(HISTORICAL_ORTHO_LAYERS).sort(),
    [
      '1960',
      '1975',
      ...Array.from({ length: 13 }, (_, i) => `bw-${1993 + i}`),
      'color-2002',
      'color-2003',
      'color-2004',
      'color-2005',
      'ir-2003',
      'ir-2004',
      'ir-2005',
      'meta-1960',
      'meta-1975',
      'seams-1960',
      'seams-1975',
    ].sort(),
  );
  assert.equal(HISTORICAL_ORTHO_LAYERS['1975'].name, 'OI.Histortho_75');
  assert.equal(HISTORICAL_ORTHO_LAYERS['bw-1999'].name, 'OI.Histortho_bw_1999');
  assert.equal(
    HISTORICAL_ORTHO_LAYERS['meta-1960'].name,
    'OI.Histortho_60_meta',
  );
  assert.equal(
    HISTORICAL_ORTHO_LAYERS['meta-1960'].style,
    'historiska-ortofoton',
  );
  assert.equal(HISTORICAL_ORTHO_LAYERS['seams-1975'].name, 'OI.Seamline_75');
  assert.equal(
    HISTORICAL_ORTHO_LAYERS['1960'].style,
    'OI.OrthoimageCoverage.Default',
  );
  assert.equal(
    HISTORICAL_ORTHO_LAYERS['ir-2002'],
    undefined,
    'there is no ir_2002',
  );
});

test('without a login: status says so, and tiles 503 without asking upstream', async (t) => {
  const h = await harness(t, { env: { GEOTORGET_USERNAME: USER } });
  const status = await h.request('/status');
  assert.equal(status.status, 200);
  assert.equal(status.headers['cache-control'], 'no-store');
  assert.deepEqual(status.json, {
    hasLogin: false,
    authFailed: false,
    dailyCount: 0,
    budget: 20000,
    date: '2026-11-21',
  });
  const tile = await h.request(tileUrl('1960', STOCKHOLM));
  assert.equal(tile.status, 503);
  assert.deepEqual(tile.json, { error: 'no_login' });
  assert.equal((await h.request('/capabilities')).status, 503);
  assert.equal(h.calls.length, 0);
});

test('bad requests are refused before anything is asked', async (t) => {
  const h = await harness(t, { env: LOGIN });
  const cases = [
    [tileUrl('1961', STOCKHOLM), 404, 'unknown_layer'],
    [tileUrl('constructor', STOCKHOLM), 404, 'unknown_layer'],
    [tileUrl('ir-2002', STOCKHOLM), 404, 'unknown_layer'],
    // Above 17 and off the grid are malformed.
    ['/tile/1960/18/1/1.png', 400, 'invalid_tile'],
    ['/tile/1960/9/512/1.png', 400, 'invalid_tile'],
    ['/tile/1960/0/1/0.png', 400, 'invalid_tile'],
    ['/tile/1960/12/1/1.jpg', 404, 'not_found'],
    ['/elsewhere', 404, 'not_found'],
  ];
  for (const [url, status, error] of cases) {
    const res = await h.request(url);
    assert.equal(res.status, status, url);
    assert.deepEqual(res.json, { error }, url);
    assert.equal(res.headers['cache-control'], 'no-store');
  }
  // Below the client's level 9 (Cesium walks a failed tile's parents down
  // to 0) and away from Sweden: a 404 the browser may keep for a day.
  for (const [url, error] of [
    ['/tile/1960/8/140/72.png', 'below_min_zoom'],
    ['/tile/1960/0/0/0.png', 'below_min_zoom'],
    [tileUrl('1960', MADRID), 'outside'],
    [tileUrl('1960', BERLIN), 'outside'],
  ]) {
    const res = await h.request(url);
    assert.equal(res.status, 404, url);
    assert.deepEqual(res.json, { error }, url);
    assert.equal(res.headers['cache-control'], 'private, max-age=86400', url);
  }
  assert.equal(h.calls.length, 0);
});

test('the coast, its islands and archipelagos count as Sweden at every level', async (t) => {
  const places = {
    Lidingö: [59.366, 18.134],
    Vaxholm: [59.402, 18.351],
    Nynäshamn: [58.903, 17.947],
    Luleå: [65.584, 22.154],
    Ven: [55.908, 12.692],
    Styrsö: [57.616, 11.784],
    Marstrand: [57.886, 11.583],
    Landsort: [58.743, 17.866],
    'Gotska Sandön': [58.383, 19.217],
    'Svenska Högarna': [59.443, 19.505],
    Holmön: [63.79, 20.87],
    Höganäs: [56.2, 12.557],
    Lysekil: [58.275, 11.435],
    Värmdö: [59.326, 18.389],
    'Öland, south tip': [56.198, 16.399],
  };
  for (const [name, [lat, lon]] of Object.entries(places))
    for (const z of [9, 13, 16, 17]) {
      const { x, y } = lonLatToTile(lon, lat, z);
      assert.ok(tileNearSweden(z, x, y), `${name} at ${z}`);
    }
  for (const [lat, lon] of [
    [52.52, 13.4],
    [59.91, 10.75],
    [60.17, 24.94],
  ]) {
    const { x, y } = lonLatToTile(lon, lat, 13);
    assert.equal(tileNearSweden(13, x, y), false);
  }
  // And the route asks for them at z16.
  const h = await harness(t, { env: LOGIN });
  for (const [lat, lon] of [places.Lidingö, places.Luleå, places.Ven]) {
    const res = await h.request(
      tileUrl('1960', lonLatToTile(lon, lat, 16), 16),
    );
    assert.equal(res.status, 200);
  }
  assert.equal(h.calls.length, 3);
});

test('a cross-site page is refused before the budget is touched', async (t) => {
  const h = await harness(t, { env: LOGIN });
  const res = await h.request(tileUrl('1960', STOCKHOLM), {
    host: 'localhost:4173',
    origin: 'https://example.com',
    'sec-fetch-site': 'cross-site',
  });
  assert.equal(res.status, 403);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.request('/status')).json.dailyCount, 0);
});

test('a tile is one Basic-auth GetMap, then kept for good in memory and on disk', async (t) => {
  const h = await harness(t, { env: LOGIN });
  const miss = await h.request(tileUrl('1960', STOCKHOLM));
  assert.equal(miss.status, 200);
  assert.equal(miss.headers['content-type'], 'image/png');
  assert.equal(
    miss.headers['cache-control'],
    'private, max-age=31536000, immutable',
  );
  assert.equal(miss.headers['x-historical-ortho-cache'], 'MISS');
  assert.ok(PNG.equals(miss.body));

  assert.equal(h.calls.length, 1);
  const { url, options } = h.calls[0];
  assert.equal(`${url.origin}${url.pathname}`, WMS_PRODUCTION_URL);
  const q = url.searchParams;
  assert.equal(q.get('SERVICE'), 'WMS');
  assert.equal(q.get('VERSION'), '1.1.1');
  assert.equal(q.get('REQUEST'), 'GetMap');
  assert.equal(q.get('LAYERS'), 'OI.Histortho_60');
  assert.equal(q.get('STYLES'), 'OI.OrthoimageCoverage.Default');
  assert.equal(q.get('SRS'), 'EPSG:3857');
  assert.equal(q.get('WIDTH'), '512');
  assert.equal(q.get('HEIGHT'), '512');
  assert.equal(q.get('TRANSPARENT'), 'TRUE');
  assert.equal(q.get('EXCEPTIONS'), 'application/vnd.ogc.se_xml');
  assert.equal(q.get('FORMAT'), 'image/png; mode=8bit');
  assert.match(url.search, /FORMAT=image%2Fpng%3B%20mode%3D8bit/);
  assert.deepEqual(
    q.get('BBOX').split(',').map(Number),
    mercatorTileBBox(12, STOCKHOLM.x, STOCKHOLM.y),
  );
  assert.equal(
    options.headers.Authorization,
    `Basic ${Buffer.from(`${USER}:${PASS}`).toString('base64')}`,
  );
  assert.equal(options.redirect, 'manual');
  assert.ok(!url.href.includes(PASS), 'the login is never in the URL');

  const hit = await h.request(tileUrl('1960', STOCKHOLM));
  assert.equal(hit.headers['x-historical-ortho-cache'], 'HIT');
  assert.ok(PNG.equals(hit.body));
  const file = path.join(
    h.cacheDir,
    '1960',
    '12',
    String(STOCKHOLM.x),
    `${STOCKHOLM.y}.png`,
  );
  assert.ok(PNG.equals(await readFile(file)));
  // A restart reads the disk; a year later the photo is still the same.
  h.restart();
  h.clock.at += 365 * 24 * 60 * 60_000;
  const disk = await h.request(tileUrl('1960', STOCKHOLM));
  assert.equal(disk.headers['x-historical-ortho-cache'], 'HIT');
  assert.equal(h.calls.length, 1);
  const status = await h.request('/status');
  assert.equal(status.json.hasLogin, true);
  assertNothingLeaked(h, miss, hit, status);
});

test('colour and infrared ask for full PNG, overlays their own style; verification switches host', async (t) => {
  const h = await harness(t, {
    env: { ...LOGIN, GEOTORGET_ENVIRONMENT: 'verification' },
  });
  await h.request(tileUrl('color-2004', STOCKHOLM));
  await h.request(tileUrl('ir-2003', STOCKHOLM));
  await h.request(tileUrl('meta-1975', STOCKHOLM));
  await h.request(tileUrl('seams-1960', STOCKHOLM));
  const [color, ir, meta, seams] = h.calls.map((c) => c.url);
  assert.equal(`${color.origin}${color.pathname}`, WMS_VERIFICATION_URL);
  assert.equal(color.searchParams.get('LAYERS'), 'OI.Histortho_color_2004');
  assert.equal(color.searchParams.get('FORMAT'), 'image/png');
  assert.equal(ir.searchParams.get('LAYERS'), 'OI.Histortho_ir_2003');
  assert.equal(ir.searchParams.get('FORMAT'), 'image/png');
  assert.equal(meta.searchParams.get('LAYERS'), 'OI.Histortho_75_meta');
  assert.equal(meta.searchParams.get('STYLES'), 'historiska-ortofoton');
  assert.equal(meta.searchParams.get('FORMAT'), 'image/png; mode=8bit');
  assert.equal(seams.searchParams.get('LAYERS'), 'OI.Seamline_60');
  assert.equal(seams.searchParams.get('STYLES'), 'historiska-ortofoton');
});

test('verification and production never share a cache', async (t) => {
  const h = await harness(t, {
    env: { ...LOGIN, GEOTORGET_ENVIRONMENT: 'verification' },
  });
  const ver = await h.request(tileUrl('1960', STOCKHOLM));
  assert.equal(ver.status, 200);
  // The test service's tiles may change: the browser keeps none.
  assert.equal(ver.headers['cache-control'], 'no-store');
  const tail = ['1960', '12', String(STOCKHOLM.x), `${STOCKHOLM.y}.png`];
  assert.ok(PNG.equals(await readFile(path.join(h.cacheDir, 'ver', ...tail))));
  await assert.rejects(stat(path.join(h.cacheDir, ...tail)));
  const again = await h.request(tileUrl('1960', STOCKHOLM));
  assert.equal(again.headers['x-historical-ortho-cache'], 'HIT');
  // Production asks its own service for the same tile.
  h.environment.GEOTORGET_ENVIRONMENT = '';
  const prod = await h.request(tileUrl('1960', STOCKHOLM));
  assert.equal(prod.headers['x-historical-ortho-cache'], 'MISS');
  assert.equal(
    prod.headers['cache-control'],
    'private, max-age=31536000, immutable',
  );
  assert.equal(h.calls.length, 2);
  const second = h.calls[1].url;
  assert.equal(`${second.origin}${second.pathname}`, WMS_PRODUCTION_URL);
  assert.ok(PNG.equals(await readFile(path.join(h.cacheDir, ...tail))));
});

test('an unknown GEOTORGET_ENVIRONMENT is production, warned about once', async (t) => {
  const h = await harness(t, {
    env: { ...LOGIN, GEOTORGET_ENVIRONMENT: 'staging' },
  });
  await h.request(tileUrl('1960', STOCKHOLM));
  await h.request(tileUrl('1960', UPPSALA));
  const first = h.calls[0].url;
  assert.equal(`${first.origin}${first.pathname}`, WMS_PRODUCTION_URL);
  const warned = h.logs.filter((line) =>
    line.includes('GEOTORGET_ENVIRONMENT'),
  );
  assert.equal(warned.length, 1);
});

test('the env numbers are read as numbers, bad ones fall back', async (t) => {
  const h = await harness(t, {
    env: { ...LOGIN, HISTORICAL_ORTHO_DAILY_BUDGET: '1e5' },
  });
  assert.equal((await h.request('/status')).json.budget, 100000);
  for (const bad of ['abc', '-3', '0', '20000x']) {
    h.environment.HISTORICAL_ORTHO_DAILY_BUDGET = bad;
    assert.equal((await h.request('/status')).json.budget, 20000, bad);
  }
});

test('a WMS exception (HTTP 200, XML) or a non-PNG is a 502 and never cached', async (t) => {
  const answers = [
    () =>
      new Response(
        '<ServiceExceptionReport><ServiceException>LayerNotDefined</ServiceException></ServiceExceptionReport>',
        {
          status: 200,
          headers: { 'content-type': 'application/vnd.ogc.se_xml' },
        },
      ),
    () => pngResponse(Buffer.from('<html>not a png</html>'), 'image/png'),
    // A PNG cut short: the signature, but no IEND.
    () => pngResponse(PNG.subarray(0, PNG.length - 12)),
    () => new Response('oops', { status: 500 }),
    () => {
      throw new TypeError('fetch failed');
    },
    () => pngResponse(),
  ];
  const h = await harness(t, {
    env: LOGIN,
    fetchImpl: async (_url, _options, n) => answers[n - 1](),
  });
  const failures = [];
  for (let i = 0; i < answers.length - 1; i += 1) {
    const res = await h.request(tileUrl('bw-1999', STOCKHOLM));
    assert.equal(res.status, 502);
    assert.deepEqual(res.json, { error: 'upstream' });
    failures.push(res);
    // Remembered: asked again only after FAILED_TILE_RETRY_MS.
    const again = await h.request(tileUrl('bw-1999', STOCKHOLM));
    assert.deepEqual(again.json, { error: 'upstream' });
    assert.equal(h.calls.length, i + 1);
    h.clock.at += FAILED_TILE_RETRY_MS;
  }
  const ok = await h.request(tileUrl('bw-1999', STOCKHOLM));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers['x-historical-ortho-cache'], 'MISS');
  assert.equal(h.calls.length, answers.length);
  assert.equal((await h.request('/status')).json.authFailed, false);
  assertNothingLeaked(h, ...failures);
});

test('a refused login is 502 auth, held for these credentials, cleared by a success', async (t) => {
  let refuse = true;
  const h = await harness(t, {
    env: LOGIN,
    fetchImpl: async () =>
      refuse ? new Response('denied', { status: 401 }) : pngResponse(),
  });
  const first = await h.request(tileUrl('1975', STOCKHOLM));
  assert.equal(first.status, 502);
  assert.deepEqual(first.json, { error: 'auth' });
  assert.equal((await h.request('/status')).json.authFailed, true);
  // The same login is not tried again at once, on any tile.
  const held = await h.request(tileUrl('1975', UPPSALA));
  assert.deepEqual(held.json, { error: 'auth' });
  assert.equal(h.calls.length, 1);
  // A new password (KOPPLA PÅ sets it live): status clears before any
  // tile is asked, so the client asks again, and it is tried at once.
  refuse = false;
  h.environment.GEOTORGET_PASSWORD = `${PASS}-new`;
  assert.equal((await h.request('/status')).json.authFailed, false);
  h.environment.GEOTORGET_PASSWORD = PASS;
  assert.equal((await h.request('/status')).json.authFailed, true);
  h.environment.GEOTORGET_PASSWORD = `${PASS}-new`;
  const ok = await h.request(tileUrl('1975', UPPSALA));
  assert.equal(ok.status, 200);
  assert.equal(h.calls.length, 2);
  assert.equal((await h.request('/status')).json.authFailed, false);
  // The same credentials refused again: status clears when the hold ends.
  refuse = true;
  h.environment.GEOTORGET_PASSWORD = PASS;
  await h.request(tileUrl('1975', STOCKHOLM));
  assert.equal(h.calls.length, 3);
  assert.equal((await h.request('/status')).json.authFailed, true);
  h.clock.at += AUTH_RETRY_MS + 1;
  assert.equal((await h.request('/status')).json.authFailed, false);
  refuse = false;
  assert.equal((await h.request(tileUrl('1975', STOCKHOLM))).status, 200);
  assert.equal((await h.request('/status')).json.authFailed, false);
  // No login at all is never a refused one.
  delete h.environment.GEOTORGET_USERNAME;
  assert.equal((await h.request('/status')).json.authFailed, false);
  assertNothingLeaked(h, first, held);
});

test('a 403 holds that layer alone, and is not a login failure', async (t) => {
  const h = await harness(t, {
    env: LOGIN,
    fetchImpl: async (url) =>
      url.searchParams.get('LAYERS') === 'OI.Histortho_ir_2004'
        ? new Response('forbidden', { status: 403 })
        : pngResponse(),
  });
  const refused = await h.request(tileUrl('ir-2004', STOCKHOLM));
  assert.equal(refused.status, 502);
  assert.deepEqual(refused.json, { error: 'auth' });
  assert.equal((await h.request('/status')).json.authFailed, false);
  // That layer is left alone; every other layer goes on.
  const held = await h.request(tileUrl('ir-2004', UPPSALA));
  assert.deepEqual(held.json, { error: 'auth' });
  assert.equal(h.calls.length, 1);
  assert.equal((await h.request(tileUrl('1960', UPPSALA))).status, 200);
  assert.equal(h.calls.length, 2);
  h.clock.at += AUTH_RETRY_MS + 1;
  await h.request(tileUrl('ir-2004', UPPSALA));
  assert.equal(h.calls.length, 3, 'asked again after the hold');
  assertNothingLeaked(h, refused);
});

test('a 429 or 503 pauses every upstream request for its Retry-After', async (t) => {
  const answers = [
    () => pngResponse(),
    () =>
      new Response('slow down', {
        status: 429,
        headers: { 'retry-after': '30' },
      }),
    () => pngResponse(),
    () => new Response('busy', { status: 503 }),
    () => pngResponse(),
    () =>
      new Response('busy', {
        status: 503,
        headers: { 'retry-after': '99999' },
      }),
    () => pngResponse(),
  ];
  const h = await harness(t, {
    env: LOGIN,
    fetchImpl: async (_url, _options, n) => answers[n - 1](),
  });
  const tile = (dx) => ({ x: STOCKHOLM.x + dx, y: STOCKHOLM.y });
  const cacheOf = async (dx) =>
    (await h.request(tileUrl('1960', tile(dx)))).headers[
      'x-historical-ortho-cache'
    ];
  assert.equal((await h.request(tileUrl('1960', tile(0)))).status, 200);
  const limited = await h.request(tileUrl('1960', tile(1)));
  assert.deepEqual(limited.json, { error: 'upstream' });
  // Paused: no tile is asked, a cached one is still served.
  const paused = await h.request(tileUrl('1960', tile(2)));
  assert.deepEqual(paused.json, { error: 'upstream' });
  assert.equal(await cacheOf(0), 'HIT');
  assert.equal(h.calls.length, 2);
  h.clock.at += 30_000;
  // The paused tile is not remembered as failed: it is asked at once.
  assert.equal((await h.request(tileUrl('1960', tile(1)))).status, 200);
  // A 503 without Retry-After pauses for the default.
  await h.request(tileUrl('1960', tile(3)));
  h.clock.at += RETRY_AFTER_DEFAULT_MS - 1;
  await h.request(tileUrl('1960', tile(4)));
  assert.equal(h.calls.length, 4);
  h.clock.at += 1;
  assert.equal((await h.request(tileUrl('1960', tile(4)))).status, 200);
  // A huge Retry-After is bounded.
  await h.request(tileUrl('1960', tile(5)));
  h.clock.at += RETRY_AFTER_MAX_MS;
  assert.equal((await h.request(tileUrl('1960', tile(5)))).status, 200);
  assert.equal(h.calls.length, 7);
  assertNothingLeaked(h, limited, paused);
});

test('the daily budget counts upstream attempts, persists, and rolls over at UTC midnight', async (t) => {
  const h = await harness(t, {
    env: { ...LOGIN, HISTORICAL_ORTHO_DAILY_BUDGET: '1' },
  });
  assert.equal((await h.request(tileUrl('1960', STOCKHOLM))).status, 200);
  const over = await h.request(tileUrl('1960', UPPSALA));
  assert.equal(over.status, 429);
  assert.deepEqual(over.json, { error: 'budget' });
  // A cached tile is still served over budget, and does not count.
  const hit = await h.request(tileUrl('1960', STOCKHOLM));
  assert.equal(hit.headers['x-historical-ortho-cache'], 'HIT');
  assert.equal(h.calls.length, 1);
  const status = await h.request('/status');
  assert.deepEqual(
    { dailyCount: status.json.dailyCount, budget: status.json.budget },
    { dailyCount: 1, budget: 1 },
  );
  // Persisted: a restart is still over budget the same day.
  const budgetFile = path.join(h.cacheDir, 'budget.json');
  for (let i = 0; i < 200; i += 1) {
    const written = await readFile(budgetFile, 'utf8').catch(() => '');
    if (written.includes('"count":1')) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const saved = JSON.parse(await readFile(budgetFile, 'utf8'));
  assert.deepEqual(saved, { date: '2026-11-21', count: 1 });
  h.restart();
  assert.equal((await h.request(tileUrl('1960', UPPSALA))).status, 429);
  h.clock.at = Date.UTC(2026, 10, 22, 0, 0, 1);
  assert.equal((await h.request(tileUrl('1960', UPPSALA))).status, 200);
  assert.equal((await h.request('/status')).json.date, '2026-11-22');
});

test('one fetch per tile however many ask, and at most four upstream at a time', async (t) => {
  const pending = [];
  let inFlight = 0;
  let most = 0;
  const h = await harness(t, {
    env: LOGIN,
    fetchImpl: () =>
      new Promise((resolve) => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        pending.push(() => {
          inFlight -= 1;
          resolve(pngResponse());
        });
      }),
  });
  const tiles = Array.from({ length: 6 }, (_, i) => ({
    x: STOCKHOLM.x + (i % 3) - 1,
    y: STOCKHOLM.y + Math.floor(i / 3),
  }));
  const asked = [
    ...tiles.map((tile) => h.request(tileUrl('1960', tile))),
    h.request(tileUrl('1960', tiles[0])),
    h.request(tileUrl('1960', tiles[0])),
  ];
  // Disk reads on a busy machine take their time: wait for what is meant.
  const settle = () => until(() => false, 30);
  await until(() => h.calls.length >= 4);
  await settle();
  assert.equal(h.calls.length, 4, 'four at a time');
  while (pending.length) {
    pending.shift()();
    await settle();
  }
  const results = await Promise.all(asked);
  assert.ok(results.every((r) => r.status === 200));
  assert.equal(h.calls.length, 6, 'the repeated tile was fetched once');
  assert.equal(most, 4);
});

test('a queued tile nobody waits for any more is dropped unasked', async (t) => {
  const pending = [];
  const h = await harness(t, {
    env: LOGIN,
    fetchImpl: () =>
      new Promise((resolve) => pending.push(() => resolve(pngResponse()))),
  });
  // Five distinct tiles: four go upstream, the fifth waits for a slot.
  const tiles = Array.from({ length: 5 }, (_, i) => ({
    x: STOCKHOLM.x + i - 2,
    y: STOCKHOLM.y,
  }));
  // Which tile waits is up to the disk reads' order: find it by the boxes.
  const closers = [];
  const asked = tiles.map((tile, i) =>
    h.request(tileUrl('1960', tile), undefined, {
      onClose: (fn) => {
        closers[i] = fn;
      },
    }),
  );
  // Disk reads on a busy machine take their time: wait for what is meant.
  const settle = () => until(() => false, 30);
  await until(() => h.calls.length >= 4);
  await settle();
  assert.equal(h.calls.length, 4);
  const asking = new Set(h.calls.map((c) => c.url.searchParams.get('BBOX')));
  const queued = tiles.findIndex(
    (tile) => !asking.has(mercatorTileBBox(12, tile.x, tile.y).join(',')),
  );
  assert.ok(queued >= 0);
  // The view moved on: the waiting request's connection closes.
  closers[queued]();
  while (pending.length) {
    pending.shift()();
    await settle();
  }
  const results = await Promise.all(asked);
  assert.deepEqual(
    results.map((r) => r.status),
    tiles.map((_, i) => (i === queued ? 0 : 200)),
  );
  assert.equal(h.calls.length, 4, 'the abandoned tile was never asked');
  assert.equal((await h.request('/status')).json.dailyCount, 4);
  // Asked again later, it is fetched as normal.
  const again = h.request(tileUrl('1960', tiles[queued]));
  await until(() => pending.length > 0);
  pending.shift()();
  assert.equal((await again).status, 200);
  assert.equal(h.calls.length, 5);
});

test('capabilities lists the layer names, cached a day, never a style name', async (t) => {
  const h = await harness(t, {
    env: LOGIN,
    fetchImpl: async () =>
      new Response(CAPABILITIES, {
        status: 200,
        headers: { 'content-type': 'application/vnd.ogc.wms_xml' },
      }),
  });
  const first = await h.request('/capabilities');
  assert.equal(first.status, 200);
  assert.deepEqual(first.json, {
    layers: ['OI.Histortho_60', 'OI.Histortho_bw_1993'],
  });
  const { url, options } = h.calls[0];
  assert.equal(url.searchParams.get('REQUEST'), 'GetCapabilities');
  assert.equal(url.searchParams.get('SERVICE'), 'WMS');
  assert.match(options.headers.Authorization, /^Basic /);
  await h.request('/capabilities');
  assert.equal(h.calls.length, 1, 'cached');
  h.clock.at += 24 * 60 * 60_000 + 1;
  await h.request('/capabilities');
  assert.equal(h.calls.length, 2, 'refreshed after a day');
  assertNothingLeaked(h, first);
});

test('capabilities failures: auth, exception, and the last list kept', async (t) => {
  const answers = [
    () => new Response('denied', { status: 401 }),
    () =>
      new Response('<ServiceExceptionReport/>', {
        status: 200,
        headers: { 'content-type': 'application/vnd.ogc.se_xml' },
      }),
    () => new Response(CAPABILITIES, { status: 200 }),
    () => new Response('down', { status: 503 }),
  ];
  const h = await harness(t, {
    env: LOGIN,
    fetchImpl: async (_url, _options, n) => answers[n - 1](),
  });
  const auth = await h.request('/capabilities');
  assert.equal(auth.status, 502);
  assert.deepEqual(auth.json, { error: 'auth' });
  assert.equal((await h.request('/status')).json.authFailed, true);
  h.environment.GEOTORGET_PASSWORD = `${PASS}-new`;
  const exception = await h.request('/capabilities');
  assert.deepEqual(exception.json, { error: 'upstream' });
  const ok = await h.request('/capabilities');
  assert.equal(ok.json.layers.length, 2);
  assert.equal((await h.request('/status')).json.authFailed, false);
  h.clock.at += 24 * 60 * 60_000 + 1;
  const stale = await h.request('/capabilities');
  assert.equal(stale.status, 200);
  assert.equal(stale.json.layers.length, 2, 'the last list beats none');
  assert.equal(h.calls.length, 4);
  assertNothingLeaked(h, auth, exception, ok, stale);
});

test('the capabilities parser is tolerant of prefixes and nesting', () => {
  assert.deepEqual(
    parseWmsLayerNames(
      '<wms:WMS_Capabilities><wms:Layer><wms:Title>x</wms:Title>' +
        '<wms:Layer queryable="1"><wms:Name>OI.Seamline_60</wms:Name>' +
        '<wms:Style><wms:Name>historiska-ortofoton</wms:Name></wms:Style>' +
        '</wms:Layer><LayerLimit>5</LayerLimit></wms:Layer></wms:WMS_Capabilities>',
    ),
    ['OI.Seamline_60'],
  );
  assert.deepEqual(parseWmsLayerNames(''), []);
});

test('the disk cache only serves real PNGs', async (t) => {
  const h = await harness(t, { env: LOGIN });
  const { mkdir, writeFile } = await import('node:fs/promises');
  const dir = path.join(h.cacheDir, '1960', '12', String(STOCKHOLM.x));
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${STOCKHOLM.y}.png`), 'truncated');
  const res = await h.request(tileUrl('1960', STOCKHOLM));
  assert.equal(res.headers['x-historical-ortho-cache'], 'MISS');
  assert.equal(h.calls.length, 1);
  const saved = await stat(path.join(dir, `${STOCKHOLM.y}.png`));
  assert.equal(saved.size, PNG.length, 'replaced by the real tile');
});

test('PNGs are whole: signature first, IEND last', () => {
  assert.equal(isPng(PNG), true);
  assert.equal(isPng(PNG.subarray(0, PNG.length - 1)), false);
  assert.equal(isPng(PNG.subarray(8)), false);
  assert.equal(isPng(Buffer.alloc(0)), false);
});

test('concurrent first requests count on the persisted budget, not on zero', async (t) => {
  const h = await harness(t, { env: LOGIN });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    path.join(h.cacheDir, 'budget.json'),
    JSON.stringify({ date: '2026-11-21', count: 5 }),
  );
  await Promise.all([
    h.request(tileUrl('1960', STOCKHOLM)),
    h.request(tileUrl('1960', UPPSALA)),
  ]);
  assert.equal((await h.request('/status')).json.dailyCount, 7);
  const budgetFile = path.join(h.cacheDir, 'budget.json');
  let saved = null;
  for (let i = 0; i < 200; i += 1) {
    saved = JSON.parse(await readFile(budgetFile, 'utf8').catch(() => 'null'));
    if (saved?.count === 7) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(saved, { date: '2026-11-21', count: 7 });
});

test('a request gone before its tile is asked costs nothing upstream', async (t) => {
  const h = await harness(t, { env: LOGIN });
  // The connection closes while the disk is still being read.
  const res = await h.request(tileUrl('1960', STOCKHOLM), undefined, {
    onClose: (fn) => fn(),
  });
  assert.equal(res.status, 0);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.request('/status')).json.dailyCount, 0);
});

test('HISTORICAL_ORTHO_CACHE_MAX_MB stops new tiles reaching the disk', async (t) => {
  const h = await harness(t, {
    env: {
      ...LOGIN,
      HISTORICAL_ORTHO_CACHE_MAX_MB: String(PNG.length / 1024 / 1024),
    },
  });
  assert.equal((await h.request(tileUrl('1960', STOCKHOLM))).status, 200);
  assert.equal((await h.request(tileUrl('1960', UPPSALA))).status, 200);
  const file = (tile) =>
    path.join(h.cacheDir, '1960', '12', String(tile.x), `${tile.y}.png`);
  assert.ok(PNG.equals(await readFile(file(STOCKHOLM))));
  await assert.rejects(stat(file(UPPSALA)), 'past the cap: memory only');
  assert.equal(
    (await h.request(tileUrl('1960', UPPSALA))).headers[
      'x-historical-ortho-cache'
    ],
    'HIT',
  );
  h.restart();
  await h.request(tileUrl('1960', UPPSALA));
  assert.equal(h.calls.length, 3, 'not on disk after a restart');
});

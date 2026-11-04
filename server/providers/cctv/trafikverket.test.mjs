import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  _resetTrafikverketBearingsForTest,
  _resetTrafikverketKeyWarningForTest,
  applyTrafikverketRoadBearings,
  orientCameraAlongRoad,
  roadBearingAt,
  loadTrafikverketSourcesFromOpenData,
  trafikverketCameraQuery,
  trafikverketCameraToSource,
} from './sources.js';

// Shaped like a live `Camera` record (schema 1.1), trimmed to the INCLUDE list.
const RECORD = {
  Active: true,
  Deleted: false,
  Id: 'SE_STA_CAMERA_VViS_2353_K1',
  Name: 'Bålsta',
  Type: 'Väglagskamera',
  Status: 'videoOrImagesAvailable',
  Geometry: { WGS84: 'POINT (17.4869976 59.592)' },
  PhotoUrl:
    'https://api.trafikinfo.trafikverket.se/v2/Images/data/road.infrastructure.camera/RoadConditionCamera_VViS_2353_K1.jpg',
  HasFullSizePhoto: true,
};

const payload = (cameras) => ({ RESPONSE: { RESULT: [{ Camera: cameras }] } });

function captureConsole(t) {
  const lines = [];
  const capture = (...args) => lines.push(args.join(' '));
  t.mock.method(console, 'warn', capture);
  t.mock.method(console, 'log', capture);
  return lines;
}

test.beforeEach(() => _resetTrafikverketKeyWarningForTest());

test('without TRAFIKVERKET_API_KEY the pack is skipped, logged once', async (t) => {
  const lines = captureConsole(t);
  let fetches = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetches += 1;
    return Response.json(payload([RECORD]));
  });
  assert.deepEqual(await loadTrafikverketSourcesFromOpenData({}, {}), []);
  assert.deepEqual(
    await loadTrafikverketSourcesFromOpenData(
      {},
      { CCTV_TRAFIKVERKET_ROAD_BEARINGS: '0', TRAFIKVERKET_API_KEY: '  ' },
    ),
    [],
  );
  assert.equal(fetches, 0);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /TRAFIKVERKET_API_KEY/);
});

test('with a key the catalog is POSTed as an XML query and parsed', async (t) => {
  captureConsole(t);
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    requests.push({ url: String(url), init });
    return Response.json(payload([RECORD]));
  });
  const cameras = await loadTrafikverketSourcesFromOpenData(
    {},
    {
      CCTV_TRAFIKVERKET_ROAD_BEARINGS: '0',
      TRAFIKVERKET_API_KEY: ' test-key ',
    },
  );
  assert.equal(requests.length, 1);
  assert.equal(
    requests[0].url,
    'https://api.trafikinfo.trafikverket.se/v2/data.json',
  );
  assert.equal(requests[0].init.method, 'POST');
  assert.equal(requests[0].init.redirect, 'manual');
  assert.match(requests[0].init.body, /authenticationkey="test-key"/);
  assert.match(requests[0].init.body, /objecttype="Camera"/);
  assert.equal(cameras.length, 1);
  const [camera] = cameras;
  assert.equal(camera.id, 'se-trafikverket-se_sta_camera_vvis_2353_k1');
  assert.equal(camera.name, 'Bålsta');
  assert.equal(camera.city, 'Sweden');
  assert.equal(camera.provider, 'Trafikverket');
  assert.equal(camera.lat, 59.592);
  assert.equal(camera.lon, 17.4869976);
  assert.equal(camera.feedType, 'image');
  assert.equal(
    camera.snapshotUrl,
    'https://api.trafikinfo.trafikverket.se/v2/Images/data/road.infrastructure.camera/RoadConditionCamera_VViS_2353_K1.jpg?type=fullsize',
  );
  assert.equal(camera.headingConfidence, 'low');
});

test('the key is escaped inside the XML attribute', () => {
  const body = trafikverketCameraQuery('a"b<c&d');
  assert.match(body, /authenticationkey="a&quot;b&lt;c&amp;d"/);
  assert.doesNotMatch(body, /a"b/);
});

test('a compass Direction gives a high-confidence heading', () => {
  const flow = trafikverketCameraToSource({
    ...RECORD,
    Type: 'Trafikflödeskamera',
    Direction: 370,
  });
  assert.equal(flow.headingDeg, 10);
  assert.equal(flow.headingConfidence, 'high');
  const north = trafikverketCameraToSource({ ...RECORD, Direction: 0 });
  assert.equal(north.headingDeg, 0);
  assert.equal(north.headingConfidence, 'high');
});

test('inactive, deleted, faulty and out-of-country cameras are dropped', () => {
  for (const patch of [
    { Active: false },
    { Deleted: true },
    { Status: 'videoOrImagesUnavailableDueToCameraFault' },
    { Geometry: { WGS84: 'POINT (10.75 59.91)' } }, // Oslo
    { Geometry: { WGS84: 'POINT (24.94 60.17)' } }, // Helsinki
    { Geometry: { WGS84: 'not a point' } },
    { Id: 'bad id/with slash' },
  ]) {
    assert.equal(
      trafikverketCameraToSource({ ...RECORD, ...patch }),
      null,
      JSON.stringify(patch),
    );
  }
});

test('frame URLs are pinned to the Trafikverket image directory', () => {
  for (const PhotoUrl of [
    'https://evil.example/v2/Images/RoadConditionCamera_1.Jpeg',
    'https://api.trafikinfo.trafikverket.se/v2/data.json',
    'https://api.trafikinfo.trafikverket.se/v2/Images/..%2fdata.json',
    'https://user:pw@api.trafikinfo.trafikverket.se/v2/Images/X_1.Jpeg',
    'https://api.trafikinfo.trafikverket.se/v2/Images/not-an-image.html',
    'https://api.trafikinfo.trafikverket.se/v2/Images/data/other/TrafficFlowCamera_1.jpg',
  ]) {
    assert.equal(
      trafikverketCameraToSource({ ...RECORD, PhotoUrl }),
      null,
      PhotoUrl,
    );
  }
  const small = trafikverketCameraToSource({
    ...RECORD,
    HasFullSizePhoto: false,
    PhotoUrl:
      'https://api.trafikinfo.trafikverket.se/v2/Images/TrafficFlowCamera_42.Jpeg?junk=1',
  });
  assert.equal(
    small.snapshotUrl,
    'https://api.trafikinfo.trafikverket.se/v2/Images/TrafficFlowCamera_42.Jpeg',
  );
});

for (const status of [401, 500]) {
  test(`a ${status} answer yields no cameras and never logs the key`, async (t) => {
    const lines = captureConsole(t);
    t.mock.method(
      globalThis,
      'fetch',
      async () => new Response('nope', { status }),
    );
    const cameras = await loadTrafikverketSourcesFromOpenData(
      {},
      {
        CCTV_TRAFIKVERKET_ROAD_BEARINGS: '0',
        TRAFIKVERKET_API_KEY: 'secret-key-value',
      },
    );
    assert.deepEqual(cameras, []);
    assert.equal(lines.length, 1);
    assert.equal(lines[0].includes('secret-key-value'), false);
    if (status === 401) assert.match(lines[0], /check TRAFIKVERKET_API_KEY/);
  });
}

test('an ERROR result (e.g. a refused key) yields no cameras', async (t) => {
  const lines = captureConsole(t);
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json({
      RESPONSE: {
        RESULT: [
          {
            ERROR: { SOURCE: 'Security', MESSAGE: 'Invalid authentication' },
          },
        ],
      },
    }),
  );
  const cameras = await loadTrafikverketSourcesFromOpenData(
    {},
    { CCTV_TRAFIKVERKET_ROAD_BEARINGS: '0', TRAFIKVERKET_API_KEY: 'k' },
  );
  assert.deepEqual(cameras, []);
  assert.match(lines[0], /Invalid authentication/);
});

test('duplicates collapse and the pack cap applies', async (t) => {
  captureConsole(t);
  const records = Array.from({ length: 20 }, (_, i) => ({
    ...RECORD,
    Id: `SE_STA_CAMERA_${i % 15}`,
    PhotoUrl: `https://api.trafikinfo.trafikverket.se/v2/Images/RoadConditionCamera_${i}.Jpeg`,
  }));
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(payload(records)),
  );
  const all = await loadTrafikverketSourcesFromOpenData(
    {},
    { CCTV_TRAFIKVERKET_ROAD_BEARINGS: '0', TRAFIKVERKET_API_KEY: 'k' },
  );
  assert.equal(all.length, 15);
  const capped = await loadTrafikverketSourcesFromOpenData(
    {},
    {
      CCTV_TRAFIKVERKET_ROAD_BEARINGS: '0',
      TRAFIKVERKET_API_KEY: 'k',
      CCTV_TRAFIKVERKET_MAX_SOURCES: '8',
    },
  );
  assert.equal(capped.length, 8);
});

test('the nearest road segment gives a compass bearing and a distance', () => {
  // Road 56 over Mellansundet runs south to north; the mast stands ~19 m east.
  const line =
    'LINESTRING Z (16.305083 59.481642 3.1, 16.305121 59.481674 3.1, 16.305129 59.482782 3.0, 16.305150 59.484500 3.0)';
  const found = roadBearingAt(line, 16.305429, 59.483349);
  assert.ok(found);
  assert.ok(found.bearing < 3 || found.bearing > 357, `${found.bearing}`);
  assert.ok(found.distanceM > 10 && found.distanceM < 25, `${found.distanceM}`);
  const east = roadBearingAt('LINESTRING (17 59, 17.01 59)', 17.005, 59.0001);
  assert.ok(Math.abs(east.bearing - 90) < 0.5);
  assert.equal(roadBearingAt('POINT (17 59)', 17, 59), null);
});

test('station cameras face apart along the road; a compass suffix decides', () => {
  const at = (id) => ({ id, headingDeg: 1, headingConfidence: 'low' });
  const k1 = orientCameraAlongRoad(
    at('se-trafikverket-se_sta_camera_vvis_1903_k1'),
    10,
  );
  const k2 = orientCameraAlongRoad(
    at('se-trafikverket-se_sta_camera_vvis_1903_k2'),
    10,
  );
  assert.equal(k1.headingDeg, 10);
  assert.equal(k2.headingDeg, 190);
  assert.equal(
    k1.headingConfidence,
    'low',
    'direction along the axis is a guess',
  );
  const north = orientCameraAlongRoad(
    at('se-trafikverket-se_sta_camera_vvis_77_norr'),
    175,
  );
  assert.equal(north.headingDeg, 355);
  assert.equal(north.headingConfidence, 'medium');
});

test('road bearings are looked up once, cached on disk and applied', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', (...args) => lines.push(args.join(' ')));
  _resetTrafikverketBearingsForTest();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-tv-bearing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cacheFile = path.join(dir, 'bearings.json');
  const camera = () =>
    trafikverketCameraToSource({
      ...RECORD,
      Id: 'SE_STA_CAMERA_VViS_1903_K2',
      Geometry: { WGS84: 'POINT (16.305429 59.483349)' },
    });
  const flow = () =>
    trafikverketCameraToSource({ ...RECORD, Id: 'FLOW_1', Direction: 45 });
  const requests = [];
  const fetchImpl = async (_url, init) => {
    requests.push(init.body);
    return Response.json({
      RESPONSE: {
        RESULT: [
          {
            Vägnummer: [
              {
                Huvudnummer: 56,
                Geometry: {
                  'WKT-WGS84-3D':
                    'LINESTRING Z (16.30512 59.48167 3, 16.30515 59.48450 3)',
                },
              },
            ],
          },
        ],
      },
    });
  };
  const first = [camera(), flow()];
  const env = { TRAFIKVERKET_API_KEY: 'secret-key' };
  assert.equal(
    await applyTrafikverketRoadBearings(first, {
      key: 'secret-key',
      env,
      fetchImpl,
      cacheFile,
    }),
    1,
  );
  assert.equal(requests.length, 1);
  assert.match(requests[0], /objecttype="Vägnummer"/);
  assert.match(
    requests[0],
    /<NEAR name="Geometry.WKT-WGS84-3D" value="16.305429 59.483349"/,
  );
  // K2 faces against the road's drawing direction (north), so south.
  assert.ok(Math.abs(first[0].headingDeg - 180) < 2, `${first[0].headingDeg}`);
  assert.equal(first[1].headingDeg, 45, 'a published facing is left alone');
  const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  assert.equal(saved.points['16.30543,59.48335'].road, 56);

  const second = [camera()];
  await applyTrafikverketRoadBearings(second, {
    key: 'secret-key',
    env,
    fetchImpl,
    cacheFile,
  });
  assert.equal(requests.length, 1, 'served from the disk cache');
  assert.equal(second[0].headingDeg, first[0].headingDeg);
  assert.equal(
    lines.some((line) => line.includes('secret-key')),
    false,
  );
});

test('a malformed answer is not cached as "no road"', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  _resetTrafikverketBearingsForTest();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gev-tv-bearing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cacheFile = path.join(dir, 'bearings.json');
  const cameras = [trafikverketCameraToSource(RECORD)];
  const before = cameras[0].headingDeg;
  await applyTrafikverketRoadBearings(cameras, {
    key: 'k',
    fetchImpl: async () => Response.json(payload([RECORD])),
    cacheFile,
  });
  assert.equal(cameras[0].headingDeg, before);
  assert.equal(fs.existsSync(cacheFile), false);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  SMHI_GRID,
  SMHI_RADAR_BOUNDS,
  createSmhiRadar,
  decodePng,
  encodePng,
  renderSmhiWindow,
  smhiFrameUrl,
  smhiListingTimes,
  smhiWindowMapping,
  sweref99tm,
} from './smhiRadar.js';

test('SWEREF 99 TM matches the projection reference on the central meridian', () => {
  const [easting, northing] = sweref99tm(60, 15);
  assert.ok(Math.abs(easting - 500000) < 0.01, `${easting}`);
  assert.ok(Math.abs(northing - 6651411.19) < 0.5, `${northing}`);
  // East of the meridian, eastings grow; Stockholm sits near 674 km E.
  const [e] = sweref99tm(59.3326, 18.0649);
  assert.ok(e > 673000 && e < 676000, `${e}`);
});

test('PNG encode/decode round-trips RGBA pixels', () => {
  const rgba = new Uint8Array(3 * 2 * 4).map((_, i) => (i * 37) % 256);
  const decoded = decodePng(encodePng(3, 2, rgba));
  assert.equal(decoded.width, 3);
  assert.equal(decoded.height, 2);
  assert.deepEqual([...decoded.data], [...rgba]);
  assert.throws(() => decodePng(new Uint8Array(40)), /not a PNG/);
});

test('day listings yield 5-minute PNG frame times, ascending', () => {
  const listing = {
    files: [
      {
        key: 'radar_2611041045',
        valid: '2026-11-04 10:45',
        formats: [{ key: 'png' }, { key: 'tif' }],
      },
      {
        key: 'radar_sweden_comp_202611041045',
        valid: '2026-11-04 10:45',
        formats: [{ key: 'h5' }],
      },
      {
        key: 'radar_2611041040',
        valid: '2026-11-04 10:40',
        formats: [{ key: 'png' }],
      },
      {
        key: 'radar_2611041041',
        valid: '2026-11-04 10:41',
        formats: [{ key: 'png' }],
      },
    ],
  };
  assert.deepEqual(smhiListingTimes(listing), [
    '2026-11-04T10:40:00.000Z',
    '2026-11-04T10:45:00.000Z',
  ]);
  assert.equal(
    smhiFrameUrl('2026-11-04T10:45:00.000Z'),
    'https://opendata-download-radar.smhi.se/api/version/latest/area/sweden/product/comp/2026/11/04/radar_2611041045.png',
  );
});

/** A frame the size of SMHI's grid with one precipitation pixel at a point. */
function frameWith(lat, lon, rgba) {
  const { width, height, x0, y0, pixel } = SMHI_GRID;
  const data = new Uint8Array(width * height * 4);
  // The outside-coverage veil everywhere, as SMHI draws it.
  for (let i = 3; i < data.length; i += 4) data[i] = 15;
  const [e, n] = sweref99tm(lat, lon);
  const col = Math.floor((e - x0) / pixel);
  const row = Math.floor((y0 - n) / pixel);
  data.set(rgba, (row * width + col) * 4);
  return { width, height, data };
}

test('a window keeps precipitation where it fell and drops the veil', () => {
  // A yellow (25 dBZ) pixel over Västerås.
  const frame = frameWith(59.61, 16.545, [255, 255, 15, 255]);
  const bbox = [16.4, 59.5, 16.7, 59.7];
  const png = renderSmhiWindow(frame, smhiWindowMapping(bbox, 60, 40), 60, 40);
  const { data } = decodePng(png);
  const lit = [];
  for (let p = 0; p < data.length / 4; p++)
    if (data[p * 4 + 3]) lit.push([p % 60, Math.floor(p / 60)]);
  assert.ok(lit.length > 0, 'the precipitation pixel survives');
  for (const [x, y] of lit) {
    const lon = 16.4 + ((x + 0.5) * 0.3) / 60;
    const lat = 59.7 - ((y + 0.5) * 0.2) / 40;
    // One SMHI pixel is ~2 km: within ~0.04° of the source point.
    assert.ok(Math.abs(lon - 16.545) < 0.05 && Math.abs(lat - 59.61) < 0.03);
  }
});

test('metadata reads today, then yesterday after midnight; frames decode once', async (t) => {
  const clock = Date.parse('2026-11-04T00:20:00Z');
  const requested = [];
  const listing = (day, times) => ({
    files: times.map((hm) => ({
      key: `radar_26${day.slice(5, 7)}${day.slice(8, 10)}${hm.replace(':', '')}`,
      valid: `${day} ${hm}`,
      formats: [{ key: 'png' }],
    })),
  });
  const pngBytes = encodePng(
    SMHI_GRID.width,
    SMHI_GRID.height,
    frameWith(59.61, 16.545, [10, 238, 10, 255]).data,
  );
  const fetchImpl = async (url) => {
    requested.push(String(url));
    if (String(url).endsWith('/2026/11/04.json'))
      return Response.json(listing('2026-11-04', ['00:05', '00:10', '00:15']));
    if (String(url).endsWith('/2026/11/03.json'))
      return Response.json(
        listing(
          '2026-11-03',
          Array.from(
            { length: 12 },
            (_, i) => `23:${String(i * 5).padStart(2, '0')}`,
          ),
        ),
      );
    if (String(url).endsWith('.png'))
      return new Response(pngBytes, {
        headers: { 'content-type': 'image/png' },
      });
    return new Response('nope', { status: 404 });
  };
  const radar = createSmhiRadar({ fetchImpl, now: () => clock });
  const meta = await radar.metadata();
  assert.equal(meta.times.length, 13);
  assert.equal(meta.times.at(-1), '2026-11-04T00:15:00.000Z');
  assert.equal(meta.times[0], '2026-11-03T23:10:00.000Z');
  assert.deepEqual(meta.bounds, { ...SMHI_RADAR_BOUNDS });
  const bbox = [
    SMHI_RADAR_BOUNDS.west,
    SMHI_RADAR_BOUNDS.south,
    SMHI_RADAR_BOUNDS.east,
    SMHI_RADAR_BOUNDS.north,
  ];
  await radar.render(meta.times.at(-1), bbox, 256, 128);
  await radar.render(meta.times.at(-1), bbox, 256, 128);
  assert.equal(
    requested.filter((u) => u.endsWith('.png')).length,
    1,
    'frame cached',
  );
});

test('the legend is in the shape the weather display accepts', async () => {
  const { SMHI_RADAR_LEGEND } = await import('./smhiRadar.js');
  const { weatherDisplay } =
    await import('../../src/layers/weather/display.js');
  const shown = weatherDisplay({
    display: { units: 'dBZ', legend: SMHI_RADAR_LEGEND },
  });
  assert.equal(shown.units, 'dBZ');
  assert.deepEqual(shown.legend.at(0), ['5', '#0032ff']);
  assert.deepEqual(shown.legend.at(-1), ['55+', '#33ffff']);
});

test('a thin line marks the edge of radar coverage; the logo draws nothing', () => {
  const { width, height } = SMHI_GRID;
  // East of column 235 measured (clear), west of it SMHI's veil.
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < height; row++)
    for (let col = 0; col < 235; col++) data[(row * width + col) * 4 + 3] = 15;
  // Grey logo pixels in the top-left corner, inside the veil.
  for (let row = 10; row < 40; row++)
    for (let col = 10; col < 100; col++)
      data.set([96, 96, 96, 255], (row * width + col) * 4);
  const bbox = [
    SMHI_RADAR_BOUNDS.west,
    SMHI_RADAR_BOUNDS.south,
    SMHI_RADAR_BOUNDS.east,
    SMHI_RADAR_BOUNDS.north,
  ];
  const w = 512;
  const h = 256;
  const out = decodePng(
    renderSmhiWindow({ data }, smhiWindowMapping(bbox, w, h), w, h),
  ).data;
  const lit = [];
  for (let p = 0; p < w * h; p++) if (out[p * 4 + 3]) lit.push(p);
  const lonOf = (p) => bbox[0] + ((p % w) + 0.5) * ((bbox[2] - bbox[0]) / w);
  for (const p of lit)
    assert.deepEqual([...out.subarray(p * 4, p * 4 + 4)], [230, 238, 245, 235]);
  // Grid column 235 is easting x0 + 235 px (~600 km E): ~16.5°E at 54°N,
  // ~17.6°E at 70°N. The edge runs there; the veil and logo to its west
  // draw nothing. (Synthetic coverage also reaches the grid's own edges,
  // which are drawn too: data ends there.)
  assert.ok(
    lit.filter((p) => lonOf(p) > 16 && lonOf(p) < 18.5).length > 50,
    'the coverage edge is drawn along column 235',
  );
  assert.equal(lit.filter((p) => lonOf(p) < 15.5).length, 0);
});

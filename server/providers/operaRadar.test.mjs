import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';

import {
  NO_COVERAGE,
  NO_ECHO,
  OPERA_GRID,
  OPERA_RADAR_BOUNDS,
  OPERA_REDUCED,
  codeDbz,
  createOperaRadar,
  decodeOperaTiff,
  echoCode,
  laeaProjection,
  operaFrameUrl,
  operaLaea,
  operaListingTimes,
  operaListingUrl,
  operaWindowMapping,
  renderOperaWindow,
} from './operaRadar.js';
import { decodePng } from './smhiRadar.js';

test('LAEA matches the EPSG example and centres OPERA on 55°N 10°E', () => {
  // EPSG Guidance Note 7-2, EPSG:3035 (LAEA Europe): 50°N 5°E.
  const [e, n] = laeaProjection({
    lat0: 52,
    lon0: 10,
    falseEasting: 4_321_000,
    falseNorthing: 3_210_000,
  }).forward(50, 5);
  assert.ok(Math.abs(e - 3_962_799.45) < 0.01, `${e}`);
  assert.ok(Math.abs(n - 2_999_718.85) < 0.01, `${n}`);
  const [x, y] = operaLaea(55, 10);
  assert.ok(Math.abs(x - 1_950_000) < 1e-6 && Math.abs(y + 2_100_000) < 1e-6);
});

/** Grid coordinates [col, row] of the full-resolution pixel under a point. */
function cellOf(lat, lon) {
  const [e, n] = operaLaea(lat, lon);
  return [
    Math.floor((e - OPERA_GRID.x0) / OPERA_GRID.pixel),
    Math.floor((OPERA_GRID.y0 - n) / OPERA_GRID.pixel),
  ];
}

const FILL = -9_999_000;

/**
 * A GeoTIFF shaped like OPERA's DBZH files: 3800×4400, two float32 samples,
 * deflated 512 px tiles. `value(col, row)` gives band 1; band 2 is quality.
 */
function operaTiff(value, { tie = [OPERA_GRID.x0, OPERA_GRID.y0] } = {}) {
  const { width, height } = OPERA_GRID;
  const tile = 512;
  const across = Math.ceil(width / tile);
  const down = Math.ceil(height / tile);
  const tiles = [];
  for (let ty = 0; ty < down; ty++)
    for (let tx = 0; tx < across; tx++) {
      const raw = Buffer.alloc(tile * tile * 8);
      for (let r = 0; r < tile; r++)
        for (let c = 0; c < tile; c++) {
          const col = tx * tile + c;
          const row = ty * tile + r;
          const v = col < width && row < height ? value(col, row) : FILL;
          raw.writeFloatLE(v, (r * tile + c) * 8);
          raw.writeFloatLE(1, (r * tile + c) * 8 + 4);
        }
      tiles.push(zlib.deflateSync(raw, { level: 1 }));
    }
  const description =
    '<GDALMetadata><Item name="DESCRIPTION" sample="0" role="description">DBZH</Item></GDALMetadata>\0';
  // [tag, type, values]
  const entries = [
    [256, 4, [width]],
    [257, 4, [height]],
    [258, 3, [32, 32]],
    [259, 3, [8]],
    [262, 3, [1]],
    [277, 3, [2]],
    [284, 3, [1]],
    [317, 3, [1]],
    [322, 3, [tile]],
    [323, 3, [tile]],
    [324, 4, tiles.map(() => 0)],
    [325, 4, tiles.map((t) => t.length)],
    [339, 3, [3, 3]],
    [33550, 12, [OPERA_GRID.pixel, OPERA_GRID.pixel, 0]],
    [33922, 12, [0, 0, 0, tie[0], tie[1], 0]],
    [34735, 3, [1, 1, 0, 2, 1024, 0, 1, 1, 3075, 0, 1, 10]],
    [34736, 12, [55, 10, 1_950_000, -2_100_000, 298.257223563, 6378137, 0]],
    [42112, 2, description],
  ];
  const size = { 2: 1, 3: 2, 4: 4, 12: 8 };
  const count = (type, values) =>
    type === 2 ? Buffer.byteLength(values, 'latin1') : values.length;
  const ifdBytes = 2 + entries.length * 12 + 4;
  let extra = 8 + ifdBytes;
  const blobs = [];
  const directory = Buffer.alloc(ifdBytes);
  directory.writeUInt16LE(entries.length, 0);
  let tilesAt = 0;
  entries.forEach(([tag, type, values], i) => {
    const at = 2 + i * 12;
    const n = count(type, values);
    directory.writeUInt16LE(tag, at);
    directory.writeUInt16LE(type, at + 2);
    directory.writeUInt32LE(n, at + 4);
    const body = Buffer.alloc(size[type] * n);
    if (type === 2) body.write(values, 'latin1');
    else
      values.forEach((v, k) => {
        if (type === 3) body.writeUInt16LE(v, k * 2);
        else if (type === 4) body.writeUInt32LE(v, k * 4);
        else body.writeDoubleLE(v, k * 8);
      });
    if (body.length <= 4) body.copy(directory, at + 8);
    else {
      directory.writeUInt32LE(extra, at + 8);
      if (tag === 324) tilesAt = extra;
      blobs.push(body);
      extra += body.length;
    }
  });
  const header = Buffer.from([0x49, 0x49, 42, 0, 8, 0, 0, 0]);
  const file = Buffer.concat([header, directory, ...blobs, ...tiles]);
  let at = extra;
  tiles.forEach((t, k) => {
    file.writeUInt32LE(at, tilesAt + k * 4);
    at += t.length;
  });
  return new Uint8Array(file.buffer, file.byteOffset, file.length);
}

// Built once: 3800×4400 synthetic frames take a moment to deflate.
const STORM = cellOf(59.61, 16.545); // over Västerås
const COAST_COL = 2600; // no coverage east of this column
const FRAME = operaTiff((col, row) => {
  if (col >= COAST_COL) return FILL;
  if (Math.abs(col - STORM[0]) <= 3 && Math.abs(row - STORM[1]) <= 3)
    return col === STORM[0] && row === STORM[1] ? 41.5 : 27;
  return NaN;
});

test('frames reduce to 2 km: strongest echo per block, no echo, no coverage', () => {
  const frame = decodeOperaTiff(FRAME);
  assert.equal(frame.width, OPERA_REDUCED.width);
  assert.equal(frame.height, OPERA_REDUCED.height);
  const at = (col, row) => frame.data[(row >> 1) * frame.width + (col >> 1)];
  assert.equal(codeDbz(at(...STORM)), 41.5, 'the peak survives reduction');
  assert.equal(codeDbz(at(STORM[0] + 3, STORM[1])), 27);
  assert.equal(at(100, 100), NO_ECHO);
  assert.equal(at(COAST_COL + 10, 100), NO_COVERAGE);
  assert.equal(codeDbz(echoCode(-40)), -32, 'echo codes clamp');
  assert.ok(echoCode(-32) > NO_ECHO);
});

test('a moved grid is refused rather than drawn in the wrong place', () => {
  const shifted = operaTiff(() => NaN, { tie: [-400, 500] });
  assert.throws(() => decodeOperaTiff(shifted), /OPERA grid changed/);
  assert.throws(() => decodeOperaTiff(new Uint8Array(16)), /TIFF/);
});

test('a window keeps echoes where they fell and draws the coverage edge', () => {
  const frame = decodeOperaTiff(FRAME);
  const bbox = [16.4, 59.5, 16.7, 59.65];
  const png = renderOperaWindow(
    frame,
    operaWindowMapping(bbox, 64, 32),
    64,
    32,
  );
  const { data } = decodePng(png);
  const lit = [];
  for (let p = 0; p < 64 * 32; p++)
    if (data[p * 4 + 3]) lit.push([p % 64, Math.floor(p / 64), p]);
  assert.ok(lit.length > 0, 'the storm survives');
  for (const [x, y, p] of lit) {
    const lon = 16.4 + ((x + 0.5) * 0.3) / 64;
    const lat = 59.65 - ((y + 0.5) * 0.15) / 32;
    // ±3 km storm reduced to 2 km pixels: within ~0.1° of its centre.
    assert.ok(Math.abs(lon - 16.545) < 0.1 && Math.abs(lat - 59.61) < 0.05);
    const rgb = [...data.subarray(p * 4, p * 4 + 3)].join(',');
    // 27 dBZ is in the 25 class (yellow), the 41.5 dBZ peak in 35 (red).
    assert.ok(['255,255,15', '255,35,35'].includes(rgb), rgb);
  }
  // The whole extent shows the eastern coverage edge as a light line.
  const { west, south, east, north } = OPERA_RADAR_BOUNDS;
  const whole = decodePng(
    renderOperaWindow(
      frame,
      operaWindowMapping([west, south, east, north], 512, 256),
      512,
      256,
    ),
  ).data;
  let edge = 0;
  for (let p = 0; p < 512 * 256; p++)
    if (whole[p * 4] === 230 && whole[p * 4 + 1] === 238) edge++;
  assert.ok(edge > 100, `${edge}`);
});

test('listings yield DBZH GeoTIFF times; URLs are built from times', () => {
  const xml = [
    'OPERA@20261104T1225@0@DBZH.tiff',
    'OPERA@20261104T1225@0@DBZH.h5',
    'OPERA@20261104T1215@0@RATE.tiff',
    'OPERA@20261104T1220@0@DBZH.tiff',
    'OPERA@20261104T1221@0@DBZH.tiff',
  ]
    .map(
      (name) => `<Contents><Key>2026/11/04/OPERA/COMP/${name}</Key></Contents>`,
    )
    .join('');
  assert.deepEqual(
    operaListingTimes(`<ListBucketResult>${xml}</ListBucketResult>`),
    ['2026-11-04T12:20:00.000Z', '2026-11-04T12:25:00.000Z'],
  );
  assert.equal(
    operaFrameUrl('2026-11-04T12:25:00.000Z'),
    'https://s3.waw3-1.cloudferro.com/openradar-24h/2026/11/04/OPERA/COMP/OPERA@20261104T1225@0@DBZH.tiff',
  );
  const listing = new URL(
    operaListingUrl(
      new Date('2026-11-04T12:30:00Z'),
      new Date('2026-11-04T09:30:00Z'),
    ),
  );
  assert.equal(listing.searchParams.get('list-type'), '2');
  assert.equal(listing.searchParams.get('prefix'), '2026/11/04/OPERA/COMP/');
  assert.equal(
    listing.searchParams.get('start-after'),
    '2026/11/04/OPERA/COMP/OPERA@20261104T0930',
  );
});

test('metadata lists yesterday too after midnight; frames download once', async () => {
  const clock = Date.parse('2026-11-04T00:20:00Z');
  const requested = [];
  const keys = (day, times) =>
    times
      .map(
        (hm) =>
          `<Key>${day.replaceAll('-', '/')}/OPERA/COMP/OPERA@${day.replaceAll('-', '')}T${hm}@0@DBZH.tiff</Key>`,
      )
      .join('');
  const fetchImpl = async (url) => {
    const href = String(url);
    requested.push(href);
    const u = new URL(href);
    if (u.searchParams.get('prefix') === '2026/11/04/OPERA/COMP/')
      return new Response(keys('2026-11-04', ['0005', '0010', '0015']));
    if (u.searchParams.get('prefix') === '2026/11/03/OPERA/COMP/')
      return new Response(
        keys(
          '2026-11-03',
          Array.from(
            { length: 12 },
            (_, i) => `23${String(i * 5).padStart(2, '0')}`,
          ),
        ),
      );
    if (href.endsWith('.tiff')) return new Response(FRAME);
    return new Response('nope', { status: 404 });
  };
  const radar = createOperaRadar({ fetchImpl, now: () => clock });
  const meta = await radar.metadata();
  assert.equal(meta.times.length, 13);
  assert.equal(meta.times[0], '2026-11-03T23:10:00.000Z');
  assert.equal(meta.times.at(-1), '2026-11-04T00:15:00.000Z');
  assert.deepEqual(meta.bounds, { ...OPERA_RADAR_BOUNDS });
  const yesterday = new URL(requested[0]);
  assert.equal(
    yesterday.searchParams.get('start-after'),
    '2026/11/03/OPERA/COMP/OPERA@20261103T2120',
  );
  const today = new URL(requested[1]);
  assert.equal(
    today.searchParams.get('start-after'),
    '2026/11/04/OPERA/COMP/OPERA@20261104T0000',
  );
  const bbox = [16, 59, 17, 59.5];
  await radar.render(meta.times.at(-1), bbox, 64, 32);
  await radar.render(meta.times.at(-1), bbox, 64, 32);
  assert.equal(requested.filter((u) => u.endsWith('.tiff')).length, 1);
});

test('the legend is in the shape the weather display accepts', async () => {
  const { OPERA_RADAR_LEGEND } = await import('./operaRadar.js');
  const { weatherDisplay } =
    await import('../../src/layers/weather/display.js');
  const shown = weatherDisplay({
    display: { units: 'dBZ', legend: OPERA_RADAR_LEGEND },
  });
  assert.deepEqual(shown.legend.at(0), ['5', '#0032ff']);
  assert.deepEqual(shown.legend.at(-1), ['55+', '#33ffff']);
});

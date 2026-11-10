// The northern lights outlook route: NOAA's Kp rows in either shape, SMHI's
// cloud steps, and the route's checks.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KP_FORECAST_URL,
  auroraOutlookProxy,
  normalizeClouds,
  normalizeKp,
} from './auroraOutlook.js';

test('Kp rows as objects or as arrays with a header, oldest first', () => {
  const objects = normalizeKp([
    {
      time_tag: '2026-11-09T21:00:00',
      kp: 4.67,
      observed: 'predicted',
      noaa_scale: 'G1',
    },
    {
      time_tag: '2026-11-07T12:00:00',
      kp: '3.33',
      observed: 'observed',
      noaa_scale: null,
    },
  ]);
  assert.deepEqual(objects, [
    {
      time: Date.parse('2026-11-07T12:00:00Z'),
      kp: 3.33,
      observed: true,
      scale: null,
    },
    {
      time: Date.parse('2026-11-09T21:00:00Z'),
      kp: 4.67,
      observed: false,
      scale: 'G1',
    },
  ]);
  const arrays = normalizeKp([
    ['time_tag', 'kp', 'observed', 'noaa_scale'],
    ['2026-11-07 12:00:00', '3.33', 'observed', null],
  ]);
  assert.equal(arrays.length, 1);
  assert.equal(arrays[0].kp, 3.33);
});

test('SMHI cloud cover in octas, out-of-range steps dropped', () => {
  assert.deepEqual(
    normalizeClouds({
      timeSeries: [
        { time: '2026-11-07T14:00:00Z', data: { cloud_area_fraction: 7 } },
        { time: '2026-11-07T15:00:00Z', data: { cloud_area_fraction: 9 } },
        { time: 'x', data: { cloud_area_fraction: 2 } },
      ],
    }),
    [{ time: Date.parse('2026-11-07T14:00:00Z'), octas: 7 }],
  );
});

test('the route: a Swedish point, Kp kept half an hour', async () => {
  const urls = [];
  const proxy = auroraOutlookProxy({
    fetchImpl: async (url) => {
      urls.push(url);
      return new Response(
        JSON.stringify(url === KP_FORECAST_URL ? [] : { timeSeries: [] }),
      );
    },
    now: () => Date.parse('2026-11-07T14:00:00Z'),
  });
  let handler = null;
  proxy.configureServer({ middlewares: { use: (path, fn) => (handler = fn) } });
  const get = async (url) => {
    const res = {
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ method: 'GET', url, headers: {}, socket: {} }, res);
    return res;
  };
  const kiruna = await get('/?lat=67.85&lon=20.22');
  assert.equal(kiruna.status, 200);
  assert.equal(kiruna.body.level, 'none', 'no Kp known: no chance claimed');
  await get('/?lat=59.6&lon=16.5');
  assert.equal(urls.filter((u) => u === KP_FORECAST_URL).length, 1);
  assert.equal((await get('/?lat=40&lon=16')).status, 400);
});

import {
  normalizeClouds as cloudsOf,
  normalizeKp as kpOf,
} from './auroraOutlook.js';

test('a Kp or a cloud cover that is missing is unknown, never 0', () => {
  assert.deepEqual(
    kpOf([
      { time_tag: '2026-11-05T18:00:00', kp: null, observed: 'predicted' },
      { time_tag: '2026-11-05T21:00:00', kp: '', observed: 'predicted' },
      { time_tag: '2026-11-06T00:00:00', kp: '4.33', observed: 'predicted' },
    ]).map((row) => row.kp),
    [4.33],
  );
  assert.deepEqual(
    cloudsOf({
      timeSeries: [
        { time: '2026-11-05T18:00:00Z', data: { cloud_area_fraction: null } },
        { time: '2026-11-05T19:00:00Z', data: {} },
        { time: '2026-11-05T20:00:00Z', data: { cloud_area_fraction: 0 } },
        { time: '2026-11-05T21:00:00Z', data: { cloud_area_fraction: 6 } },
      ],
    }).map((row) => row.octas),
    [0, 6],
  );
});

// Tonight's northern lights: the sun, the darkness, what a latitude needs,
// and how Kp and clouds make the chance.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  auroraOutlook,
  darkSpell,
  requiredKp,
  solarElevation,
} from './auroraModel.js';

const KIRUNA = { lat: 67.855, lon: 20.225 };
const NOV7 = Date.parse('2026-11-07T14:00:00Z');
const H = 3_600_000;

test('the sun: high at a Stockholm June noon, under the horizon at midnight', () => {
  const june = Date.parse('2026-06-21T11:00:00Z');
  assert.ok(solarElevation(59.33, 18.07, june) > 50);
  assert.ok(
    solarElevation(59.33, 18.07, Date.parse('2026-12-21T23:00:00Z')) < -40,
  );
});

test('darkness: a November evening in Kiruna, none at midsummer', () => {
  const spell = darkSpell(KIRUNA.lat, KIRUNA.lon, NOV7);
  assert.ok(spell, 'a dark spell tonight');
  const fromHour = new Date(spell.from).getUTCHours();
  assert.ok(fromHour >= 14 && fromHour <= 16, `dark from ${fromHour} UTC`);
  assert.ok(spell.to - spell.from > 10 * H);
  assert.equal(
    darkSpell(KIRUNA.lat, KIRUNA.lon, Date.parse('2026-06-21T12:00:00Z')),
    null,
  );
});

test('the Kp a latitude needs: Kiruna little, Malmö a storm', () => {
  assert.equal(requiredKp(67.9), 1);
  assert.equal(requiredKp(63.8), 3);
  assert.equal(requiredKp(59.6), 5);
  assert.equal(requiredKp(55.6), 7);
});

const kpSeries = (value, scale = null) =>
  Array.from({ length: 16 }, (_, i) => ({
    time: Date.parse('2026-11-07T00:00:00Z') + i * 3 * H,
    kp: value,
    observed: false,
    scale,
  }));
const sky = (octas) =>
  Array.from({ length: 30 }, (_, i) => ({ time: NOV7 + i * H, octas }));

test('the chance: activity over the need under a clear sky is high; cloud takes it', () => {
  const clear = auroraOutlook({
    kp: kpSeries(4.7, 'G1'),
    clouds: sky(1),
    ...KIRUNA,
    now: NOV7,
  });
  assert.equal(clear.level, 'high');
  assert.equal(clear.maxKp, 4.7);
  assert.equal(clear.requiredKp, 1);
  assert.equal(clear.cloudPct, 13);
  assert.equal(clear.scale, 'G1');
  assert.ok(clear.best >= clear.dark.from && clear.best < clear.dark.to);
  assert.equal(
    auroraOutlook({ kp: kpSeries(4.7), clouds: sky(8), ...KIRUNA, now: NOV7 })
      .level,
    'low',
  );
  const south = { lat: 55.6, lon: 13.0 };
  assert.equal(
    auroraOutlook({ kp: kpSeries(3), clouds: sky(0), ...south, now: NOV7 })
      .level,
    'low',
  );
  assert.equal(
    auroraOutlook({ kp: kpSeries(6.3), clouds: sky(2), ...south, now: NOV7 })
      .level,
    'possible',
  );
  assert.equal(
    auroraOutlook({
      kp: kpSeries(5),
      clouds: sky(0),
      ...KIRUNA,
      now: Date.parse('2026-06-21T12:00:00Z'),
    }).level,
    'none',
  );
});

import { auroraOutlook as outlookFor } from './auroraModel.js';

test("the storm level shown is the dark hours' strongest, not their first", () => {
  const slot = (time, kp, scale) => ({
    time: Date.parse(time),
    kp,
    observed: false,
    scale,
  });
  const outlook = outlookFor({
    kp: [
      slot('2026-11-07T18:00:00Z', 4, null),
      slot('2026-11-07T21:00:00Z', 5, 'G1'),
      slot('2026-11-08T00:00:00Z', 7, 'G3'),
      slot('2026-11-08T03:00:00Z', 6, 'G2'),
    ],
    clouds: [],
    lat: 67.86,
    lon: 20.23,
    now: Date.parse('2026-11-07T12:00:00Z'),
  });
  assert.equal(outlook.maxKp, 7);
  assert.equal(outlook.scale, 'G3');
});

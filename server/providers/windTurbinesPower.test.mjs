// The wind turbines route keeps the built power to a kilowatt and says how
// many built turbines the register gives no power for, so the layer never
// rounds a view of small turbines, or of turbines without power, to "0 MW".
import assert from 'node:assert/strict';
import test from 'node:test';

import { windTurbinesProxy } from './windTurbines.js';
import {
  normalizeTurbines,
  packTurbines,
} from '../../src/layers/windTurbines/records.js';

const row = (VERKID, MAXEFFEKT, x) => ({
  VERKID,
  STATUS: 'Uppfört',
  MAXEFFEKT,
  KOMNAMN: 'Timrå',
  _xy: [x, 6930000],
});
// A 40 kW farm turbine and one the register gives no power for.
const ROWS = [row('S-1', 0.04, 620000), row('S-2', '', 620500)];
const SNAPSHOT = {
  exported: '2026-11-20',
  ...packTurbines(
    normalizeTurbines(
      ROWS,
      ROWS.map((r) => r._xy),
    ),
  ),
};

test('a view of small turbines keeps their power and counts the unknown', async (t) => {
  t.mock.method(console, 'log', () => {});
  let handler;
  windTurbinesProxy({
    read: async () => JSON.stringify(SNAPSHOT),
  }).configureServer({ middlewares: { use: (path, fn) => (handler = fn) } });
  const res = {
    destroyed: false,
    writeHead(code) {
      this.status = code;
    },
    end(body) {
      this.body = body;
    },
  };
  await handler(
    {
      method: 'GET',
      url: '/?bbox=16.5,61.5,18.5,63&center=17.3,62.45',
      headers: {},
    },
    res,
  );
  const json = JSON.parse(res.body);
  assert.equal(res.status, 200);
  assert.equal(json.counts.built, 2);
  assert.equal(json.builtMW, 0.04, 'not rounded to 0');
  assert.equal(json.builtPowerUnknown, 1);
});

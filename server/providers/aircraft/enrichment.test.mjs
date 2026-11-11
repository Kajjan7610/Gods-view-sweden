// adsbdb's flight routes stay out unless ADSBDB_ROUTES=on.
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { adsbdbProxy, adsbdbRoutesAllowed } from './enrichment.js';

function route(t, env) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'gev-adsbdb-'));
  const cwd = process.cwd();
  process.chdir(dir);
  const before = process.env.ADSBDB_ROUTES;
  if (env === undefined) delete process.env.ADSBDB_ROUTES;
  else process.env.ADSBDB_ROUTES = env;
  t.after(() => {
    process.chdir(cwd);
    if (before === undefined) delete process.env.ADSBDB_ROUTES;
    else process.env.ADSBDB_ROUTES = before;
  });
  mkdirSync(path.join(dir, '.gev-cache'));
  const cacheFile = path.join(dir, '.gev-cache', 'adsbdb.json');
  writeFileSync(
    cacheFile,
    JSON.stringify({
      routes: { SAS123: { at: Date.now(), data: { airline: 'SAS' } } },
      aircraft: { abc123: { at: Date.now(), data: { typeCode: 'A20N' } } },
    }),
  );
  let handler;
  adsbdbProxy().configureServer({
    middlewares: { use: (at, fn) => (handler = fn) },
  });
  const request = async (url) => {
    const res = {
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ url }, res);
    return { status: res.status, json: JSON.parse(res.body) };
  };
  return { request, cacheFile };
}

test('adsbdb routes are left out by default, and those on disk are deleted', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url));
    return new Response('{}', { status: 404 });
  });
  const { request, cacheFile } = route(t, undefined);
  assert.deepEqual((await request('/route/SAS123')).json, { found: false });
  assert.equal(calls.length, 0, 'adsbdb is not asked for a route');
  const kept = JSON.parse(readFileSync(cacheFile, 'utf8'));
  assert.deepEqual(kept.routes, {});
  // Aircraft type and registration carry no such restriction.
  assert.equal(kept.aircraft.abc123.data.typeCode, 'A20N');
  assert.equal((await request('/type/abc123')).json.typeCode, 'A20N');
  // Validation still answers first.
  assert.equal((await request('/route/!')).status, 400);
});

test('ADSBDB_ROUTES=on brings the routes back', async (t) => {
  const { request } = route(t, 'on');
  assert.deepEqual((await request('/route/SAS123')).json, {
    found: true,
    airline: 'SAS',
  });
  assert.equal(adsbdbRoutesAllowed({ ADSBDB_ROUTES: ' ON ' }), true);
  assert.equal(adsbdbRoutesAllowed({}), false);
});

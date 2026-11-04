import assert from 'node:assert/strict';
import test from 'node:test';

import { encodeAlerts } from '../../src/layers/transitAlerts/alertFeedFixture.mjs';
import {
  ALERTS_URL,
  TRAFIKLAB_ALERT_OPERATORS,
  transitAlertsProxy,
} from './transitAlerts.js';

const NOW = Date.parse('2026-11-04T23:00:00Z');
const STOPS = new Map([['s1', [16.19, 58.59, 'Hagaskolan', '']]]);
const FEED = encodeAlerts([
  { id: 'a1', header: 'Spårvagn 2 delinställd', stops: ['s1'] },
]);

function harness({ env = { TRAFIKLAB_GTFS_RT_KEY: 'test-key' }, ...options }) {
  let handler;
  transitAlertsProxy({ now: () => NOW, env, ...options }).configureServer({
    middlewares: { use: (_path, fn) => (handler = fn) },
  });
  return async (url = '/') => {
    const res = {
      destroyed: false,
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.body = body;
      },
    };
    await handler({ method: 'GET', url, headers: {}, socket: {} }, res);
    return { ...res, json: () => JSON.parse(res.body) };
  };
}

test('every Trafiklab operator is asked for alerts', () => {
  assert.ok(TRAFIKLAB_ALERT_OPERATORS.length >= 16);
  assert.ok(
    TRAFIKLAB_ALERT_OPERATORS.some(
      ({ operator, name }) => operator === 'sl' && name === 'SL',
    ),
  );
});

test('alerts are placed by stop; operators without stops wait', async (t) => {
  t.mock.method(console, 'log', () => {});
  const urls = [];
  const request = harness({
    operators: [
      { operator: 'otraf', name: 'Östgötatrafiken' },
      { operator: 'sl', name: 'SL' },
    ],
    stopsFor: (operator) => (operator === 'otraf' ? STOPS : null),
    fetchImpl: async (url) => {
      urls.push(String(url));
      return new Response(FEED);
    },
  });
  const body = (await request()).json();
  assert.equal(body.stops.length, 1);
  assert.equal(body.stops[0].name, 'Hagaskolan');
  assert.equal(body.stops[0].kind, 'closed');
  assert.deepEqual(body.pending, ['sl']);
  assert.ok(urls[0].startsWith(`${ALERTS_URL('otraf')}?key=`));
  await request();
  assert.equal(urls.length, 2, 'cached, if only for a minute while waiting');
});

test('no key is "not configured"; failures never show the key', async (t) => {
  assert.equal((await harness({ env: {} })()).status, 503);
  const warnings = [];
  t.mock.method(console, 'warn', (...args) => warnings.push(args.join(' ')));
  const request = harness({
    operators: [{ operator: 'sl', name: 'SL' }],
    stopsFor: () => STOPS,
    fetchImpl: async () => new Response('denied', { status: 403 }),
  });
  assert.equal((await request()).status, 502);
  assert.ok(warnings.length);
  assert.ok(warnings.every((line) => !line.includes('test-key')));
});

test('an operator without an alert feed (404) has no alerts', async (t) => {
  t.mock.method(console, 'log', () => {});
  const request = harness({
    operators: [{ operator: 'halland', name: 'Hallandstrafiken' }],
    stopsFor: () => assert.fail('no stops needed without alerts'),
    fetchImpl: async () => new Response('', { status: 404 }),
  });
  const body = (await request()).json();
  assert.deepEqual([body.stops, body.failed], [[], 0]);
});

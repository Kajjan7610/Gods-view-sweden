import { normalizeRoadSnapshot } from '../../src/layers/roadConditions/records.js';
import { readResponseJsonCapped, coalesceProxyRequest } from './common/http.js';
import { makeRateLimiter, clientKey } from './common/rate-limit.js';

// Trafikverket's open traffic API (CC0 1.0). One POST carries two queries:
// RoadCondition (winter road surface) and Situation (incidents). The key is
// server-side only (TRAFIKVERKET_API_KEY) and travels in the request body.
const API_URL = 'https://api.trafikinfo.trafikverket.se/v2/data.json';
const TTL_MS = 3 * 60_000;
/** Longest a failed refresh keeps serving the last snapshot, marked stale. */
const STALE_MAX_MS = 60 * 60_000;
const MAX_BODY_BYTES = 64 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

const CONDITION_FIELDS = [
  'Id',
  'ConditionCode',
  'ConditionText',
  'ConditionInfo',
  'Warning',
  'Measure',
  'Cause',
  'RoadNumber',
  'LocationText',
  'StartTime',
  'EndTime',
  'Deleted',
  'Geometry.WGS84',
];
const DEVIATION_FIELDS = [
  'Id',
  'MessageType',
  'MessageCode',
  'Header',
  'Message',
  'SeverityCode',
  'SeverityText',
  'RoadNumber',
  'LocationDescriptor',
  'TrafficRestrictionType',
  'StartTime',
  'EndTime',
  'ValidUntilFurtherNotice',
  'Suspended',
  'WebLink',
  'Geometry.Point.WGS84',
  'Geometry.Line.WGS84',
];

const xmlAttr = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** The two-query request body. */
export function trafikverketRoadsQuery(key) {
  const include = (fields, prefix = '') =>
    fields.map((f) => `<INCLUDE>${prefix}${f}</INCLUDE>`).join('');
  return (
    '<REQUEST>' +
    `<LOGIN authenticationkey="${xmlAttr(key)}" />` +
    '<QUERY objecttype="RoadCondition" namespace="Road.TrafficInfo" schemaversion="1.3">' +
    '<FILTER><EQ name="Deleted" value="false" /></FILTER>' +
    include(CONDITION_FIELDS) +
    '</QUERY>' +
    '<QUERY objecttype="Situation" namespace="Road.TrafficInfo" schemaversion="1.6">' +
    '<FILTER><EQ name="Deleted" value="false" /></FILTER>' +
    '<INCLUDE>Id</INCLUDE><INCLUDE>Deleted</INCLUDE>' +
    include(DEVIATION_FIELDS, 'Deviation.') +
    '</QUERY>' +
    '</REQUEST>'
  );
}

/** Bounded Trafikverket road-condition and incident route for dev and preview. */
export function trafikverketRoadsProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  env = process.env,
} = {}) {
  let cached = null;
  const inFlight = new Map();
  const allow = makeRateLimiter({ windowMs: 60_000, max: 30, globalMax: 600 });
  let keylessLogged = false;

  async function load(key) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetchImpl(API_URL, {
        method: 'POST',
        signal: controller.signal,
        redirect: 'manual',
        headers: {
          'Content-Type': 'text/xml; charset=utf-8',
          Accept: 'application/json',
        },
        body: trafikverketRoadsQuery(key),
      });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {
          /* no-op */
        }
        throw Object.assign(new Error(`upstream HTTP ${response.status}`), {
          status: response.status,
        });
      }
      const payload = await readResponseJsonCapped(response, MAX_BODY_BYTES);
      const fetchedAt = now();
      return { ...normalizeRoadSnapshot(payload, fetchedAt), fetchedAt };
    } finally {
      clearTimeout(timer);
    }
  }

  async function handler(req, res) {
    const json = (status, value, headers = {}) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...headers,
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET')
      return json(405, { error: 'method_not_allowed' }, { Allow: 'GET' });
    const path = (req.url || '/').split('?')[0];
    if (path !== '/' && path !== '')
      return json(404, { error: 'unknown_route' });
    const key = String(env.TRAFIKVERKET_API_KEY ?? '').trim();
    if (!key) {
      if (!keylessLogged) {
        keylessLogged = true;
        console.warn(
          '[trafikverket-roads] skipped: set TRAFIKVERKET_API_KEY to show Swedish road conditions and incidents',
        );
      }
      return json(
        503,
        { error: 'not_configured' },
        { 'Retry-After': '3600', 'X-Data-Backoff': 'not-configured' },
      );
    }
    if (cached && now() - cached.savedAt < TTL_MS)
      return json(200, cached.value);
    if (!allow(clientKey(req)))
      return json(429, { error: 'rate_limited' }, { 'Retry-After': '60' });
    try {
      const { promise } = coalesceProxyRequest(inFlight, 'roads', () =>
        load(key),
      );
      const value = await promise;
      cached = { value, savedAt: now() };
      console.log(
        `[trafikverket-roads] ${value.conditions.length} road-condition stretches, ${value.incidents.length} incidents`,
      );
      return json(200, value);
    } catch (error) {
      // The message names an HTTP status or Trafikverket's own refusal text,
      // never the request body, so the key stays private.
      console.warn(
        `[trafikverket-roads] refresh failed: ${error?.message || error}`,
      );
      if (cached && now() - cached.savedAt <= STALE_MAX_MS)
        return json(
          200,
          { ...cached.value, stale: true },
          {
            'X-Data-Stale': 'true',
          },
        );
      return json(502, {
        error: 'trafikverket_roads_unavailable',
        keyRefused: error?.status === 401 || error?.status === 403,
      });
    }
  }

  return {
    name: 'trafikverket-roads',
    configureServer({ middlewares }) {
      middlewares.use('/api/trafikverket-roads', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/trafikverket-roads', handler);
    },
  };
}

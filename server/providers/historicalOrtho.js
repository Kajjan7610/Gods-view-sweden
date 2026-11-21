import path from 'node:path';
import { createHash } from 'node:crypto';
import { promises as fsp } from 'node:fs';

import {
  readResponseBytesCapped,
  readResponseTextCapped,
} from './common/http.js';
import { admitSameSite } from './common/same-site.js';
import { boxTouchesSweden } from './swedenTiles.js';
import {
  isValidTileCoord,
  tileToBBox,
  utcDayKey,
  normalizeBudget,
  isOverBudget,
} from '../../src/data/tomtomTiles.js';

/**
 * Lantmäteriet's historical orthophotos ("Ortofoto historiska Visning", CC0,
 * free) for the "Då och nu" layer, as web-mercator XYZ tiles.
 *
 * Upstream: Lantmäteriet's WMS (1.1.1) at
 * maps.lantmateriet.se/historiska-ortofoton/wms/v1, or maps-ver (Lantmäteriet's
 * verification environment) with GEOTORGET_ENVIRONMENT=verification. It wants
 * HTTP Basic with the owner's Geotorget username and password
 * (GEOTORGET_USERNAME, GEOTORGET_PASSWORD). The header is built here, server-
 * side only: the browser fetches same-origin
 * `/api/historiska-ortofoton/tile/{layerId}/{z}/{x}/{y}.png`, and neither the
 * credentials nor the upstream URL are ever logged or answered.
 *
 * Each tile is one GetMap of the tile's EPSG:3857 box at 512×512 px, asked
 * only for tiles within COAST_BUFFER_KM of Sweden's outline (the outline is
 * simplified; the buffer keeps the archipelagos and islands in).
 *
 * Cache: the photos are decades old and never change, so a tile is kept for
 * good — memory (bounded by bytes) and disk under .gev-cache/
 * historiska-ortofoton/ (<layerId>/<z>/<x>/<y>.png; the verification service's
 * tiles under ver/), single-flight per tile. Only complete PNGs are kept: a
 * WMS exception comes back HTTP 200 as XML, and is a 502. The disk keeps
 * every tile that has been viewed and grows with use; delete the
 * .gev-cache/historiska-ortofoton folder to clear it, or set
 * HISTORICAL_ORTHO_CACHE_MAX_MB to stop saving new tiles past that size.
 *
 * Lantmäteriet is spared a zoom burst: at most UPSTREAM_CONCURRENCY GetMaps
 * at a time, the rest queued, and a queued tile nobody waits for any more
 * (the view moved on) is dropped unasked. A failed tile is not asked again
 * for FAILED_TILE_RETRY_MS; a 429 or 503 pauses every upstream request for
 * the Retry-After time (bounded). A persistent daily counter (budget.json,
 * UTC date) caps upstream attempts at HISTORICAL_ORTHO_DAILY_BUDGET (default
 * 20,000); cached tiles never count.
 *
 * A refused login (401) answers 502 {error:'auth'} and sets authFailed in
 * /status until a later success; the same credentials are not tried again
 * for AUTH_RETRY_MS, so a wrong password cannot hammer the account, while new
 * credentials (KOPPLA PÅ sets them live) are tried at once. A 403 is the
 * account lacking one layer: that layer alone is left alone as long.
 *
 * Routes (all same-site only — every uncached tile spends the budget):
 *   GET /status       → {hasLogin, authFailed, dailyCount, budget, date}
 *   GET /tile/…       → image/png, or JSON {error} (no-store)
 *   GET /capabilities → {layers} the WMS lists, cached 24 h
 *
 * @param {object} [options] Injected for tests.
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now]
 * @param {string} [options.cacheDir] Absolute cache directory.
 * @param {Record<string, string|undefined>} [options.env] Read per request,
 *   so credentials saved in KOPPLA PÅ apply without a restart.
 * @returns {import('vite').Plugin}
 */
export function historicalOrthoProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  cacheDir = path.join(process.cwd(), '.gev-cache', 'historiska-ortofoton'),
  env = process.env,
} = {}) {
  const BUDGET_PATH = path.join(cacheDir, 'budget.json');
  /** The photos' tiles are ~50–400 KB; this keeps the hot ones, not all. */
  const MEM_MAX_BYTES = 48 * 1024 * 1024;

  /** @type {Map<string, Buffer>} tile key -> PNG, oldest use first. */
  const mem = new Map();
  let memBytes = 0;
  /**
   * Single-flight per tile; `waiters` counts the requests still open for it.
   * @type {Map<string, {promise: Promise<Buffer>, waiters: number}>}
   */
  const inflight = new Map();
  /** @type {Array<() => void>} upstream jobs waiting for a slot. */
  const queue = [];
  let active = 0;
  /** @type {Map<string, number>} tile key -> when it last failed. */
  const failedTiles = new Map();
  /** Upstream asked to be left alone (429/503) until then. */
  let pausedUntil = -Infinity;

  /** @type {{date:string, count:number}|null} */
  let budget = null;
  /** @type {Promise<void>|null} */
  let budgetLoad = null;
  /** @type {Promise<void>|null} the one budget write running. */
  let budgetWrite = null;
  let budgetDirty = false;

  let authFailed = false;
  /** When the last 401 came, and for which credentials (a hash only). */
  let authFailedAt = -Infinity;
  let authFailedFor = '';
  /** @type {Map<string, {at: number, for: string}>} 403 per layer. */
  const forbidden = new Map();

  /** @type {Map<string, {at:number, layers:string[]}>} per environment. */
  const capabilities = new Map();
  /** @type {Map<string, Promise<string[]>>} */
  const capabilitiesInflight = new Map();

  /** @type {Promise<{bytes: number}>|null} disk use, read once if capped. */
  let diskUse = null;
  let diskFullLogged = false;
  const warnedEnvironments = new Set();

  const login = () => {
    const username = String(env.GEOTORGET_USERNAME ?? '').trim();
    const password = String(env.GEOTORGET_PASSWORD ?? '').trim();
    return username && password ? { username, password } : null;
  };
  const fingerprint = ({ username, password }) =>
    createHash('sha256').update(`${username}\0${password}`).digest('hex');

  /** 'production' or 'verification'; anything else is production, once warned. */
  function environment() {
    const value = String(env.GEOTORGET_ENVIRONMENT ?? '')
      .trim()
      .toLowerCase();
    if (value === 'verification') return 'verification';
    if (value && value !== 'production' && !warnedEnvironments.has(value)) {
      warnedEnvironments.add(value);
      console.warn(
        '[historical-ortho] GEOTORGET_ENVIRONMENT is neither "production" nor "verification"; using production',
      );
    }
    return 'production';
  }
  const serviceUrl = (environmentName) =>
    environmentName === 'verification'
      ? WMS_VERIFICATION_URL
      : WMS_PRODUCTION_URL;

  /** A positive number from env, or the fallback ("1e5" is 100,000). */
  const positiveNumber = (value, fallback) => {
    const text = String(value ?? '').trim();
    const number = Number(text);
    return text && Number.isFinite(number) && number > 0 ? number : fallback;
  };
  const dailyBudgetLimit = () =>
    Math.floor(
      positiveNumber(env.HISTORICAL_ORTHO_DAILY_BUDGET, DEFAULT_DAILY_BUDGET),
    );
  const diskCapBytes = () =>
    positiveNumber(env.HISTORICAL_ORTHO_CACHE_MAX_MB, 0) * 1024 * 1024;

  /** Read the persisted counter once; concurrent first requests share it. */
  function loadBudget() {
    budgetLoad ??= (async () => {
      try {
        const parsed = JSON.parse(await fsp.readFile(BUDGET_PATH, 'utf8'));
        if (
          parsed &&
          typeof parsed.date === 'string' &&
          Number.isFinite(parsed.count)
        )
          budget = parsed;
      } catch {
        /* no budget file yet */
      }
    })();
    return budgetLoad;
  }

  /** One write at a time, the latest count wins; beside, then renamed. */
  function persistBudget() {
    budgetDirty = true;
    budgetWrite ??= (async () => {
      try {
        while (budgetDirty) {
          budgetDirty = false;
          const text = JSON.stringify(budget);
          const temp = `${BUDGET_PATH}.${process.pid}.tmp`;
          try {
            await fsp.mkdir(cacheDir, { recursive: true });
            await fsp.writeFile(temp, text, 'utf8');
            await renameRetrying(temp, BUDGET_PATH);
          } catch (err) {
            await fsp.rm(temp, { force: true }).catch(() => {});
            console.warn(
              '[historical-ortho] budget write failed:',
              err?.message || err,
            );
          }
        }
      } finally {
        budgetWrite = null;
      }
    })();
    return budgetWrite;
  }

  /** Roll the counter to today (UTC) and return it. */
  function currentBudget() {
    budget = normalizeBudget(budget, utcDayKey(now()));
    return budget;
  }

  const overBudget = () => isOverBudget(currentBudget(), dailyBudgetLimit());

  /** Count one upstream attempt against today's budget (async persist). */
  function recordUpstreamFetch() {
    currentBudget().count += 1;
    void persistBudget();
  }

  /** Whether these credentials were refused (401) too recently to retry. */
  function authHeld(credentials) {
    return (
      authFailed &&
      authFailedFor === fingerprint(credentials) &&
      now() - authFailedAt < AUTH_RETRY_MS
    );
  }

  /** Whether this account was refused (403) this scope too recently. */
  function forbiddenHeld(scope, credentials) {
    const hold = forbidden.get(scope);
    return Boolean(
      hold &&
      hold.for === fingerprint(credentials) &&
      now() - hold.at < AUTH_RETRY_MS,
    );
  }

  const paused = () => now() < pausedUntil;

  function noteSuccess() {
    authFailed = false;
    authFailedFor = '';
  }

  /** Byte-bounded LRU: a hit moves to the back, the front goes first. */
  function memGet(key) {
    const buf = mem.get(key);
    if (buf) {
      mem.delete(key);
      mem.set(key, buf);
    }
    return buf;
  }

  function memSet(key, buf) {
    if (buf.length > MEM_MAX_BYTES) return;
    const previous = mem.get(key);
    if (previous) {
      memBytes -= previous.length;
      mem.delete(key);
    }
    while (memBytes + buf.length > MEM_MAX_BYTES && mem.size) {
      const [oldest, old] = mem.entries().next().value;
      mem.delete(oldest);
      memBytes -= old.length;
    }
    mem.set(key, buf);
    memBytes += buf.length;
  }

  // Verification tiles live apart: the two services must never mix.
  const tilePath = (environmentName, layerId, z, x, y) =>
    path.join(
      cacheDir,
      ...(environmentName === 'verification' ? ['ver'] : []),
      layerId,
      String(z),
      String(x),
      `${y}.png`,
    );

  async function readDiskTile(file) {
    try {
      const buf = await fsp.readFile(file);
      return isPng(buf) ? buf : null;
    } catch {
      return null;
    }
  }

  /** The bytes of the tiles on disk, counted once (only with a cap). */
  function diskUsage() {
    diskUse ??= (async () => {
      let bytes = 0;
      try {
        const entries = await fsp.readdir(cacheDir, {
          recursive: true,
          withFileTypes: true,
        });
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith('.png')) continue;
          const dir = entry.parentPath ?? entry.path;
          bytes += (await fsp.stat(path.join(dir, entry.name))).size;
        }
      } catch {
        /* no cache yet */
      }
      return { bytes };
    })();
    return diskUse;
  }

  /** Write beside, then rename: a half-written tile is never kept for good. */
  async function writeDiskTile(file, buf) {
    const cap = diskCapBytes();
    let use = null;
    if (cap > 0) {
      use = await diskUsage();
      if (use.bytes + buf.length > cap) {
        if (!diskFullLogged) {
          diskFullLogged = true;
          console.warn(
            '[historical-ortho] disk cache reached HISTORICAL_ORTHO_CACHE_MAX_MB; new tiles are kept in memory only',
          );
        }
        return;
      }
    }
    const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(temp, buf);
      await fsp.rename(temp, file);
      if (use) use.bytes += buf.length;
    } catch (err) {
      await fsp.rm(temp, { force: true }).catch(() => {});
      console.warn(
        '[historical-ortho] tile cache write failed:',
        err?.message || err,
      );
    }
  }

  /**
   * Run `job` when an upstream slot is free. `wanted` is asked when the slot
   * comes: false drops the job unrun (it rejects with kind 'cancelled').
   */
  function scheduled(job, wanted = () => true) {
    return new Promise((resolve, reject) => {
      queue.push(() => {
        if (!wanted()) {
          reject(failure('cancelled'));
          return;
        }
        active += 1;
        Promise.resolve()
          .then(job)
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            drain();
          });
      });
      drain();
    });
  }

  function drain() {
    while (active < UPSTREAM_CONCURRENCY && queue.length) queue.shift()();
  }

  /** Leave upstream alone for its Retry-After (seconds or a date), bounded. */
  function pauseUpstream(res) {
    const header = String(res.headers.get('retry-after') || '').trim();
    let ms = RETRY_AFTER_DEFAULT_MS;
    if (/^\d+$/.test(header)) ms = Number(header) * 1000;
    else if (header && Number.isFinite(Date.parse(header)))
      ms = Date.parse(header) - now();
    ms = Math.min(RETRY_AFTER_MAX_MS, Math.max(RETRY_AFTER_MIN_MS, ms));
    pausedUntil = Math.max(pausedUntil, now() + ms);
  }

  /**
   * One authenticated GET upstream. Throws kind 'auth' (401, or 403 for
   * `scope`) or 'upstream' (`transient` when upstream asked for a pause).
   */
  async function upstreamGet(params, credentials, environmentName, scope) {
    const query = Object.entries(params)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&');
    const signal = AbortSignal.timeout(UPSTREAM_TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(`${serviceUrl(environmentName)}?${query}`, {
        signal,
        redirect: 'manual',
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${credentials.username}:${credentials.password}`,
            'utf8',
          ).toString('base64')}`,
          Accept: params.REQUEST === 'GetMap' ? 'image/png' : 'application/xml',
        },
      });
    } catch (err) {
      // Never the URL; the message of a network failure is enough.
      throw failure('upstream', err?.name === 'TimeoutError' ? 'timeout' : '');
    }
    if (!res.ok) void res.body?.cancel().catch(() => {});
    if (res.status === 401) {
      authFailed = true;
      authFailedAt = now();
      authFailedFor = fingerprint(credentials);
      throw failure('auth', 'HTTP 401');
    }
    if (res.status === 403) {
      forbidden.set(scope, { at: now(), for: fingerprint(credentials) });
      throw failure('auth', `HTTP 403 (${scope})`);
    }
    if (res.status === 429 || res.status === 503) {
      pauseUpstream(res);
      throw Object.assign(failure('upstream', `HTTP ${res.status}`), {
        transient: true,
      });
    }
    if (!res.ok) throw failure('upstream', `HTTP ${res.status}`);
    return { res, signal };
  }

  /** Whatever has to be true for an upstream call; throws when it is not. */
  function assertMayAsk(scope, credentials) {
    if (authHeld(credentials)) throw failure('auth', 'held');
    if (forbiddenHeld(scope, credentials)) throw failure('auth', 'held 403');
    if (paused())
      throw Object.assign(failure('upstream', 'paused'), { transient: true });
    if (overBudget()) throw failure('budget');
  }

  async function fetchTile(layerId, z, x, y, credentials, environmentName) {
    const layer = HISTORICAL_ORTHO_LAYERS[layerId];
    // Things may have changed while the job waited for its slot.
    assertMayAsk(`${environmentName}:${layerId}`, credentials);
    recordUpstreamFetch(); // attempts count, whatever the answer
    const { res, signal } = await upstreamGet(
      {
        SERVICE: 'WMS',
        VERSION: '1.1.1',
        REQUEST: 'GetMap',
        LAYERS: layer.name,
        STYLES: layer.style,
        SRS: 'EPSG:3857',
        BBOX: mercatorTileBBox(z, x, y).join(','),
        WIDTH: String(TILE_SIZE),
        HEIGHT: String(TILE_SIZE),
        FORMAT: layer.format,
        TRANSPARENT: 'TRUE',
        EXCEPTIONS: 'application/vnd.ogc.se_xml',
      },
      credentials,
      environmentName,
      `${environmentName}:${layerId}`,
    );
    // A WMS exception is HTTP 200 with an XML body: only a PNG is a tile.
    const type = String(res.headers.get('content-type') || '').toLowerCase();
    if (!type.startsWith('image/')) {
      void res.body?.cancel().catch(() => {});
      throw failure('upstream', `not an image (${type.split(';')[0] || '?'})`);
    }
    let bytes;
    try {
      bytes = await readResponseBytesCapped(res, TILE_MAX_BYTES, signal);
    } catch (err) {
      throw failure('upstream', err?.code || err?.name || 'body');
    }
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (!isPng(buf)) throw failure('upstream', 'not a complete PNG');
    noteSuccess();
    return buf;
  }

  async function fetchCapabilities(credentials, environmentName) {
    const scope = `${environmentName}:capabilities`;
    assertMayAsk(scope, credentials);
    recordUpstreamFetch();
    const { res, signal } = await upstreamGet(
      { SERVICE: 'WMS', VERSION: '1.1.1', REQUEST: 'GetCapabilities' },
      credentials,
      environmentName,
      scope,
    );
    let text;
    try {
      text = await readResponseTextCapped(res, CAPABILITIES_MAX_BYTES, signal);
    } catch (err) {
      throw failure('upstream', err?.code || err?.name || 'body');
    }
    if (!/<(?:\w+:)?(?:WMT_MS_Capabilities|WMS_Capabilities)\b/.test(text))
      throw failure('upstream', 'not a capabilities document');
    noteSuccess();
    return parseWmsLayerNames(text);
  }

  /** Remember a failed tile so it is not asked again at once (bounded). */
  function noteFailedTile(key, err) {
    if (err?.kind !== 'upstream' || err.transient) return;
    failedTiles.delete(key);
    failedTiles.set(key, now());
    while (failedTiles.size > FAILED_TILES_MAX)
      failedTiles.delete(failedTiles.keys().next().value);
  }

  function recentlyFailed(key) {
    const at = failedTiles.get(key);
    if (at === undefined) return false;
    if (now() - at < FAILED_TILE_RETRY_MS) return true;
    failedTiles.delete(key);
    return false;
  }

  const installMiddleware = (server) => {
    server.middlewares.use('/api/historiska-ortofoton', async (req, res) => {
      // Gate first: a cross-site <img> must not reach the budget counter.
      if (admitSameSite(req, res)) return;
      let done = false;
      let closed = false;
      /** @type {(() => void)|null} what a close before the answer undoes. */
      let onEarlyClose = null;
      // Early, so a connection gone during the disk read is not missed.
      res.once?.('close', () => {
        if (done) return;
        closed = true;
        onEarlyClose?.();
      });
      const gone = () =>
        closed ||
        res.destroyed === true ||
        res.writableEnded === true ||
        req.aborted === true;
      // Sanitized responses only: no upstream detail, never the URL or login.
      // `cacheable` only for answers that never change: no tile there.
      const sendJson = (status, obj, { cacheable = false } = {}) => {
        done = true;
        if (res.headersSent || res.destroyed) return;
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Cache-Control': cacheable ? 'private, max-age=86400' : 'no-store',
        });
        res.end(JSON.stringify(obj));
      };
      const sendTile = (buf, cacheStatus, environmentName) => {
        done = true;
        if (res.headersSent || res.destroyed) return;
        res.writeHead(200, {
          'Content-Type': 'image/png',
          // Production photos never change; the test service's may.
          'Cache-Control':
            environmentName === 'verification'
              ? 'no-store'
              : 'private, max-age=31536000, immutable',
          'X-Content-Type-Options': 'nosniff',
          'x-historical-ortho-cache': cacheStatus,
        });
        res.end(buf);
      };
      const sendFailure = (err) => {
        const kind = err?.kind;
        if (kind === 'cancelled') return;
        if (kind === 'auth') sendJson(502, { error: 'auth' });
        else if (kind === 'budget') sendJson(429, { error: 'budget' });
        else sendJson(502, { error: 'upstream' });
      };

      try {
        if (req.method !== 'GET') {
          sendJson(405, { error: 'method_not_allowed' });
          return;
        }
        await loadBudget();
        const urlPath = String(req.url || '').split('?')[0];

        if (urlPath === '/status') {
          const b = currentBudget();
          const credentials = login();
          sendJson(200, {
            hasLogin: Boolean(credentials),
            // Only while the hold lasts: it ends after AUTH_RETRY_MS or with
            // new credentials, so the client asks again.
            authFailed: Boolean(credentials) && authHeld(credentials),
            dailyCount: b.count,
            budget: dailyBudgetLimit(),
            date: b.date,
          });
          return;
        }

        if (urlPath === '/capabilities') {
          const credentials = login();
          if (!credentials) {
            sendJson(503, { error: 'no_login' });
            return;
          }
          const environmentName = environment();
          const cached = capabilities.get(environmentName);
          if (cached && now() - cached.at < CAPABILITIES_TTL_MS) {
            sendJson(200, { layers: cached.layers });
            return;
          }
          let pending = capabilitiesInflight.get(environmentName);
          if (!pending) {
            pending = fetchCapabilities(credentials, environmentName)
              .then((layers) => {
                capabilities.set(environmentName, { at: now(), layers });
                return layers;
              })
              .finally(() => capabilitiesInflight.delete(environmentName));
            capabilitiesInflight.set(environmentName, pending);
          }
          try {
            sendJson(200, { layers: await pending });
          } catch (err) {
            console.warn(
              `[historical-ortho] capabilities failed (${describe(err)})`,
            );
            // The last list beats none; it only changes when the service does.
            if (cached) sendJson(200, { layers: cached.layers });
            else sendFailure(err);
          }
          return;
        }

        const m = urlPath.match(
          /^\/tile\/([a-z0-9-]{1,16})\/(\d{1,2})\/(\d{1,6})\/(\d{1,6})\.png$/,
        );
        if (!m) {
          sendJson(404, { error: 'not_found' });
          return;
        }
        const layerId = m[1];
        if (!Object.hasOwn(HISTORICAL_ORTHO_LAYERS, layerId)) {
          sendJson(404, { error: 'unknown_layer' });
          return;
        }
        const z = Number(m[2]);
        const x = Number(m[3]);
        const y = Number(m[4]);
        if (!isValidTileCoord(z, x, y, { minZoom: 0, maxZoom: MAX_ZOOM })) {
          sendJson(400, { error: 'invalid_tile' });
          return;
        }
        // Cesium walks a failed tile's parents down to level 0: below the
        // layer's levels is "nothing here", which the browser may keep.
        if (z < MIN_ZOOM) {
          sendJson(404, { error: 'below_min_zoom' }, { cacheable: true });
          return;
        }
        if (!tileNearSweden(z, x, y)) {
          sendJson(404, { error: 'outside' }, { cacheable: true });
          return;
        }
        const credentials = login();
        if (!credentials) {
          sendJson(503, { error: 'no_login' });
          return;
        }

        const environmentName = environment();
        const key = `${environmentName}:${layerId}/${z}/${x}/${y}`;
        const file = tilePath(environmentName, layerId, z, x, y);
        let buf = memGet(key);
        if (!buf) {
          buf = await readDiskTile(file);
          if (buf) memSet(key, buf);
        }
        if (buf) {
          sendTile(buf, 'HIT', environmentName);
          return;
        }
        // Nobody to answer any more: no upstream work for them.
        if (gone()) {
          done = true;
          return;
        }

        let flight = inflight.get(key);
        if (!flight) {
          // Only a new flight is checked; joining one costs nothing more.
          try {
            assertMayAsk(`${environmentName}:${layerId}`, credentials);
          } catch (err) {
            sendFailure(err);
            return;
          }
          if (recentlyFailed(key)) {
            sendJson(502, { error: 'upstream' });
            return;
          }
          // The waiter is counted before the job is queued: a free slot runs
          // it at once and asks whether anyone wants it.
          const created = { promise: null, waiters: 0 };
          inflight.set(key, created);
          created.waiters += 1;
          created.promise = scheduled(
            () => fetchTile(layerId, z, x, y, credentials, environmentName),
            () => {
              // Nobody waits any more: leave Lantmäteriet unasked.
              if (created.waiters > 0) return true;
              if (inflight.get(key) === created) inflight.delete(key);
              return false;
            },
          )
            .then(async (fresh) => {
              memSet(key, fresh);
              await writeDiskTile(file, fresh);
              return fresh;
            })
            .catch((err) => {
              noteFailedTile(key, err);
              throw err;
            })
            .finally(() => {
              if (inflight.get(key) === created) inflight.delete(key);
            });
          // Every waiter handles the outcome; this keeps an unwaited one quiet.
          created.promise.catch(() => {});
          flight = created;
        } else {
          flight.waiters += 1;
        }
        let counted = true;
        const leave = () => {
          if (!counted) return;
          counted = false;
          flight.waiters -= 1;
        };
        onEarlyClose = leave;
        try {
          sendTile(await flight.promise, 'MISS', environmentName);
        } catch (err) {
          if (err?.kind !== 'cancelled')
            console.warn(
              `[historical-ortho] ${layerId}/${z}/${x}/${y} fetch failed (${describe(err)})`,
            );
          sendFailure(err);
        } finally {
          leave();
        }
      } catch (err) {
        console.warn('[historical-ortho] error:', describe(err));
        sendJson(500, { error: 'proxy' });
      }
    });
  };

  return {
    name: 'historical-ortho',
    configureServer: installMiddleware,
    configurePreviewServer: installMiddleware,
  };
}

export const WMS_PRODUCTION_URL =
  'https://maps.lantmateriet.se/historiska-ortofoton/wms/v1';
export const WMS_VERIFICATION_URL =
  'https://maps-ver.lantmateriet.se/historiska-ortofoton/wms/v1';

const TILE_SIZE = 512;
// The client layer asks from level 9 (src/layers/historicalOrtho/model.js).
const MIN_ZOOM = 9;
const MAX_ZOOM = 17;
const DEFAULT_DAILY_BUDGET = 20000;
const UPSTREAM_CONCURRENCY = 4;
const UPSTREAM_TIMEOUT_MS = 20_000;
/** A 512×512 RGBA PNG is at most ~1 MB; this bounds a runaway body. */
const TILE_MAX_BYTES = 4 * 1024 * 1024;
const CAPABILITIES_MAX_BYTES = 4 * 1024 * 1024;
const CAPABILITIES_TTL_MS = 24 * 60 * 60_000;
/** How long refused credentials (or a refused layer) are left alone. */
export const AUTH_RETRY_MS = 5 * 60_000;
/** How long a failed tile answers 502 before it is asked again. */
export const FAILED_TILE_RETRY_MS = 120_000;
const FAILED_TILES_MAX = 2048;
/** A 429/503 pause: Retry-After, else a minute, within these bounds. */
export const RETRY_AFTER_DEFAULT_MS = 60_000;
const RETRY_AFTER_MIN_MS = 1_000;
export const RETRY_AFTER_MAX_MS = 15 * 60_000;

const PHOTO_STYLE = 'OI.OrthoimageCoverage.Default';
const OVERLAY_STYLE = 'historiska-ortofoton';
// Grey photos and the line overlays fit an 8-bit palette; colour and
// infrared keep full PNG.
const PNG8 = 'image/png; mode=8bit';
const PNG = 'image/png';

const range = (from, to) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/**
 * Short layer ids the client asks for → the WMS layer, style and format.
 * Nothing else is ever sent upstream as a layer name.
 * @type {Readonly<Record<string, {name: string, style: string, format: string}>>}
 */
export const HISTORICAL_ORTHO_LAYERS = Object.freeze(
  Object.fromEntries(
    [
      ['1960', { name: 'OI.Histortho_60', style: PHOTO_STYLE, format: PNG8 }],
      ['1975', { name: 'OI.Histortho_75', style: PHOTO_STYLE, format: PNG8 }],
      ...range(1993, 2005).map((year) => [
        `bw-${year}`,
        { name: `OI.Histortho_bw_${year}`, style: PHOTO_STYLE, format: PNG8 },
      ]),
      ...range(2002, 2005).map((year) => [
        `color-${year}`,
        { name: `OI.Histortho_color_${year}`, style: PHOTO_STYLE, format: PNG },
      ]),
      // There is no infrared 2002.
      ...range(2003, 2005).map((year) => [
        `ir-${year}`,
        { name: `OI.Histortho_ir_${year}`, style: PHOTO_STYLE, format: PNG },
      ]),
      [
        'meta-1960',
        { name: 'OI.Histortho_60_meta', style: OVERLAY_STYLE, format: PNG8 },
      ],
      [
        'meta-1975',
        { name: 'OI.Histortho_75_meta', style: OVERLAY_STYLE, format: PNG8 },
      ],
      [
        'seams-1960',
        { name: 'OI.Seamline_60', style: OVERLAY_STYLE, format: PNG8 },
      ],
      [
        'seams-1975',
        { name: 'OI.Seamline_75', style: OVERLAY_STYLE, format: PNG8 },
      ],
    ].map(([id, layer]) => [id, Object.freeze(layer)]),
  ),
);

/** Half the web-mercator world's width in metres (EPSG:3857). */
const MERCATOR_HALF = Math.PI * 6378137;

/**
 * The EPSG:3857 box of the slippy tile z/x/y, in metres, as
 * [minX, minY, maxX, maxY] (y grows southward in tile rows).
 */
export function mercatorTileBBox(z, x, y) {
  const size = (2 * MERCATOR_HALF) / 2 ** z;
  const minX = -MERCATOR_HALF + x * size;
  const maxY = MERCATOR_HALF - y * size;
  return [minX, maxY - size, minX + size, maxY];
}

/**
 * The layer names a WMS GetCapabilities document lists: each <Layer>'s own
 * <Name>, not its styles' names. Tolerant of namespace prefixes, attributes
 * and whitespace; unnamed (grouping) layers are skipped.
 * @param {string} xml
 * @returns {string[]} In document order, without duplicates.
 */
export function parseWmsLayerNames(xml) {
  const names = [];
  const chunks = String(xml)
    .split(/<(?:\w+:)?Layer\b[^>]*>/)
    .slice(1);
  for (const chunk of chunks) {
    const name = chunk.match(
      /<(?:\w+:)?Name\s*>\s*([^<]*?)\s*<\/(?:\w+:)?Name\s*>/,
    );
    if (!name || !name[1]) continue;
    const style = chunk.search(/<(?:\w+:)?Style\b/);
    if (style >= 0 && style < name.index) continue;
    if (!names.includes(name[1])) names.push(name[1]);
  }
  return names;
}

/** PNG files start with these eight bytes… */
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
/** …and a complete one ends with its empty IEND chunk (length, type, CRC). */
const PNG_IEND = Buffer.from([
  0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);
/** Whether a buffer is a whole PNG: signature first, IEND last. */
export const isPng = (buf) =>
  buf.length >= PNG_SIGNATURE.length + PNG_IEND.length &&
  buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) &&
  buf.subarray(buf.length - PNG_IEND.length).equals(PNG_IEND);

/**
 * How far past Sweden's outline a tile still counts. The outline (Natural
 * Earth) is simplified: without a margin it loses Lidingö, Vaxholm, Ven,
 * Luleå, the west-coast islands and Öland's south tip.
 */
const COAST_BUFFER_KM = 20;
/**
 * Swedish islands farther out than the margin reaches, as
 * {west, south, east, north} in degrees.
 */
const OUTLYING_ISLANDS = Object.freeze([
  // Gotska Sandön, ~38 km north of Fårö.
  { west: 19.13, south: 58.34, east: 19.32, north: 58.43 },
  // Svenska Högarna, the outermost Stockholm archipelago.
  { west: 19.47, south: 59.42, east: 19.53, north: 59.46 },
  // Märket's Swedish half, in the Sea of Åland.
  { west: 19.12, south: 60.29, east: 19.14, north: 60.31 },
]);
const nearVerdicts = new Map();

/** Whether the slippy tile z/x/y lies within COAST_BUFFER_KM of Sweden. */
export function tileNearSweden(z, x, y) {
  const key = `${z}/${x}/${y}`;
  let verdict = nearVerdicts.get(key);
  if (verdict === undefined) {
    const box = tileToBBox(z, x, y);
    const dLat = COAST_BUFFER_KM / 111.32;
    const midLat = ((box.north + box.south) / 2) * (Math.PI / 180);
    const dLon = COAST_BUFFER_KM / (111.32 * Math.cos(midLat));
    const grown = {
      west: box.west - dLon,
      east: box.east + dLon,
      south: box.south - dLat,
      north: box.north + dLat,
    };
    verdict =
      boxTouchesSweden(grown) ||
      OUTLYING_ISLANDS.some(
        (island) =>
          grown.west <= island.east &&
          island.west <= grown.east &&
          grown.south <= island.north &&
          island.south <= grown.north,
      );
    if (nearVerdicts.size >= 4096) nearVerdicts.clear();
    nearVerdicts.set(key, verdict);
  }
  return verdict;
}

const failure = (kind, detail = '') =>
  Object.assign(new Error(detail ? `${kind}: ${detail}` : kind), { kind });

/** A failure for the log: its kind and short detail, never a URL. */
const describe = (err) =>
  err?.kind ? err.message : String(err?.message || err).slice(0, 200);

/**
 * Rename over `to`, retrying briefly: on Windows a file another reader holds
 * open refuses to be replaced for a moment (EPERM/EBUSY/EACCES).
 */
async function renameRetrying(from, to, attempts = 5) {
  for (let i = 1; ; i += 1) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (err) {
      if (i >= attempts || !['EPERM', 'EBUSY', 'EACCES'].includes(err?.code))
        throw err;
      await new Promise((resolve) => setTimeout(resolve, 20 * i));
    }
  }
}

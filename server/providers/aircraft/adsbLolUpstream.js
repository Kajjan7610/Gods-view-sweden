import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Swedish fork: one transport for every adsb.lol call, the flights disc
// (server/providers/aircraft/opensky.js), the GNSS integrity sample
// (server/providers/gnssIntegrity.js) and /v2/mil (adsb-lol.js). adsb.lol
// meters its point and mil endpoints: without a key 500 calls a day per IP, a
// free key 1,000 a day. All three callers share that quota, so they share
// one key, one lockout and one daily budget here.
//
// - The key, ADSBLOL_API_KEY (read on every call), goes in `x-api-key`. It
//   is never logged, saved or echoed: status() says only whether one is set.
//   A key adsb.lol refuses is left out for 15 min: meanwhile every caller
//   asks without one, counted as such, and then the key is tried again. A
//   new key is tried at once, and its warnings come anew.
// - A 429, or a 403 that speaks of quota, locks every adsb.lol path until its
//   Retry-After (delay-seconds or an HTTP date, 5 s to 25 h), else for 15
//   min, for the key state the call was sent with. Any other failed call
//   holds back only its caller: 60 s, doubling with each failure in a row up
//   to 15 min (a server error's longer Retry-After, up to an hour, wins), and
//   15 min when a call without a key is refused. A call that never reached
//   adsb.lol (no address, no connection made) is not counted.
// - Every call counts in a rolling 24 h window, per minute, against 450
//   calls without a key and 950 with one (headroom under adsb.lol's 500 and
//   1,000); ADSBLOL_DAILY_BUDGET overrides. GNSS integrity has 20 % of it to
//   itself; the flights have the rest, and /v2/mil, lowest priority, draws on
//   the flights' part and stops once half the day's budget is used. Calls
//   without a key and with one are counted apart, as adsb.lol counts them:
//   per address, and per key.
// - The same place is asked again only after a gap that spends 90 % of the
//   caller's share evenly over the window (the rest is for new places), and
//   longer while calls already counted would otherwise leave too little of
//   it before they leave the window: the flights within 30 s to 10 min,
//   GNSS within 1 to 30 min. A new place is asked at once only while that
//   10 % is still unspent (roomForNew).
// - The composition's transport keeps this state on globalThis, so a KOPPLA
//   PÅ save, which restarts the dev server in this same process, keeps it,
//   and writes the counts and the lock (never the key) to its file when they
//   change. A transport made without a file (tests, embedders) keeps its own.

export const ADSBLOL_ORIGIN = 'https://api.adsb.lol';
/** Calls a day without a key: adsb.lol allows 500 per IP. */
export const ADSBLOL_BUDGET_KEYLESS = 450;
/** Calls a day with a key: adsb.lol allows 1,000 for a free one. */
export const ADSBLOL_BUDGET_KEYED = 950;
/** While its budget lasts, a place's flights are asked at least this often. */
export const ADSBLOL_FLIGHTS_MAX_GAP_MS = 10 * 60_000;

const WINDOW_MS = 24 * 60 * 60_000;
const BUCKET_MS = 60_000;
const LOCK_DEFAULT_MS = 15 * 60_000;
const LOCK_MIN_MS = 5_000;
const LOCK_MAX_MS = 25 * 60 * 60_000;
/** After a failed call its caller waits this long, doubling in a row… */
const HOLD_FIRST_MS = 60_000;
/** …up to this. */
const HOLD_LONGEST_MS = 15 * 60_000;
/** A server error's own Retry-After is honoured up to an hour. */
const SERVER_RETRY_MAX_MS = 60 * 60_000;
/** A key adsb.lol refuses is left out this long; a refused call without a
 * key holds its caller as long. */
const REFUSED_KEY_MS = 15 * 60_000;
/** A 403's body is read this far to see whether it speaks of quota. */
const REFUSAL_BODY_BYTES = 2048;
/** GNSS integrity's own slice of the day's budget; the rest is the flights'. */
const GNSS_RESERVE = 0.2;
/** /v2/mil stops once this much of the day's budget is used. */
const MIL_SHARE = 0.5;
/** Pacing spends this much of a caller's share, leaving room for new places. */
const PACED_SHARE = 0.9;
/**
 * A new place is asked at once while the calls counted keep the pace within
 * this many times its even gap: a burst may spend about half the paced share
 * at once, and new places come no faster than the pace after that.
 */
const NEW_PLACE_SLACK = 2;
/** Least and most time between two calls for the same place. */
const PACING = Object.freeze({
  flights: Object.freeze([30_000, ADSBLOL_FLIGHTS_MAX_GAP_MS]),
  gnss: Object.freeze([60_000, 30 * 60_000]),
});
const KINDS = Object.freeze(['flights', 'gnss', 'mil']);
/**
 * Failures before any connection was made, so adsb.lol never saw the call.
 * A reset, a closed socket or a timeout may come after the request went out:
 * those stay counted.
 */
const UNREACHED = new Set([
  'ENOTFOUND',
  'EAI_AGAIN',
  'ECONNREFUSED',
  'ENETUNREACH',
  'ENETDOWN',
  'EHOSTUNREACH',
  'EHOSTDOWN',
  'EADDRNOTAVAIL',
  'UND_ERR_CONNECT_TIMEOUT',
]);
/** Warnings given once per key: another key may earn them again. */
const KEY_WARNINGS = Object.freeze(['key-format', 'refused-key']);
const SHARED_STATES = '__GEV_ADSBLOL_UPSTREAM_STATES';
const REFUSALS = Object.freeze({
  locked: 'adsb.lol quota locked',
  budget: 'adsb.lol daily budget used',
  cooldown: 'adsb.lol held back after a failure',
  upstream: 'adsb.lol refused the request',
  failed: 'adsb.lol call failed',
  timeout: 'adsb.lol did not answer in time',
});

/**
 * Milliseconds a Retry-After asks for (delay-seconds or a future HTTP date),
 * or null when it is absent, unreadable or already past.
 * @param {string|null|undefined} raw Header value.
 * @param {number} nowMs Epoch ms.
 * @returns {number|null}
 */
export function adsbLolRetryAfterMs(raw, nowMs) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text))
    return Math.min(Number(text) * 1000, Number.MAX_SAFE_INTEGER);
  // A numeric-looking value that is not delay-seconds is not read as a date.
  if (!/[a-z]/i.test(text)) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) && at > nowMs ? at - nowMs : null;
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const minuteOf = (ms) => Math.floor(ms / BUCKET_MS);
/** When the calls counted in a minute have all left the window. */
const bucketLeavesAt = (minute) => (minute + 1) * BUCKET_MS + WINDOW_MS;
const total = (rows) => rows.reduce((sum, [, calls]) => sum + calls, 0);

/** Whether a fetch failure left no answer (see UNREACHED), causes included. */
function unreached(error, depth = 0) {
  if (!error || depth > 3) return false;
  if (UNREACHED.has(error.code)) return true;
  if (unreached(error.cause, depth + 1)) return true;
  return Array.isArray(error.errors)
    ? error.errors.some((inner) => unreached(inner, depth + 1))
    : false;
}

/** The first REFUSAL_BODY_BYTES of a body as text; the rest is dropped. */
async function bodyStart(response, signal) {
  const reader = response.body?.getReader?.();
  if (!reader) return '';
  const stop = () => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', stop, { once: true });
  const parts = [];
  let size = 0;
  try {
    while (size < REFUSAL_BODY_BYTES && !signal?.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = value.subarray(0, REFUSAL_BODY_BYTES - size);
      parts.push(part);
      size += part.byteLength;
    }
  } catch {
    // What was read is all there is to go by.
  } finally {
    signal?.removeEventListener('abort', stop);
    stop();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function newState() {
  return {
    loaded: false,
    /**
     * Calls sent per key state, per minute, per caller:
     * `{keyless|keyed: Map<minute, {flights, gnss, mil}>}`.
     */
    calls: { keyless: new Map(), keyed: new Map() },
    /** @type {{until: number, status: number, keyed: boolean}|null} */
    lock: null,
    /** A fingerprint of the key last seen (never the key), '' for none. */
    keyPrint: null,
    /** @type {{print: string, until: number}|null} The key refused, until when. */
    refusedKey: null,
    writing: null,
    dirty: false,
    warned: new Set(),
  };
}

/** A short one-way fingerprint, so a refusal is told apart without the key. */
const fingerprint = (key) =>
  createHash('sha256').update(key).digest('base64url').slice(0, 16);

function refusalError({ reason, until, status }, at, cause) {
  const error = new Error(REFUSALS[reason]);
  error.name = 'AdsbLolRefusal';
  error.reason = reason;
  error.status = status;
  error.until = until;
  error.retryAfterMs = Math.max(0, until - at);
  if (cause) error.cause = cause;
  return error;
}

/**
 * One adsb.lol transport. `statePath` names the file its counts and lock are
 * kept in; without it nothing is read or written. `state` is the memory it
 * shares (see sharedAdsbLolUpstream); a fresh one by default.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now] Wall clock, epoch ms.
 * @param {Record<string, string|undefined>} [options.env]
 * @param {string|null} [options.statePath]
 * @param {(...args: unknown[]) => void} [options.warn]
 */
export function createAdsbLolUpstream({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  env = process.env,
  statePath = null,
  state = newState(),
  warn = (...args) => console.warn(...args),
} = {}) {
  /**
   * Callers held back after a failed call: kind → {until, status, streak}.
   * This transport's own, so a restart (a new key saved) starts afresh.
   */
  const holds = new Map();

  function warnOnce(topic, message) {
    if (state.warned.has(topic)) return;
    state.warned.add(topic);
    warn(message);
  }

  /** The key set, or '' without a usable one; never logged. */
  function configuredKey() {
    const key = String(env.ADSBLOL_API_KEY ?? '').trim();
    const print = key ? fingerprint(key) : '';
    if (print !== state.keyPrint) {
      // Another key: what was warned of the last one may be said again.
      state.keyPrint = print;
      for (const topic of KEY_WARNINGS) state.warned.delete(topic);
    }
    if (!key) return '';
    // fetch() throws on a header it cannot carry, and its message may hold
    // the value: such a key is not sent at all.
    if (/^[\x21-\x7e]{1,512}$/.test(key)) return key;
    warnOnce(
      'key-format',
      '[adsb.lol] ADSBLOL_API_KEY has characters an HTTP header cannot carry; asking without a key',
    );
    return '';
  }

  /** Whether adsb.lol's refusal of the key last seen still holds. */
  const refusalHolds = (at) =>
    state.refusedKey?.print === state.keyPrint && state.refusedKey.until > at;

  /** The key to send now: none while adsb.lol refuses it. */
  function apiKey(at = now()) {
    const key = configuredKey();
    return key && !refusalHolds(at) ? key : '';
  }

  /** Whether calls are sent with a key now. */
  const keyed = (at = now()) => apiKey(at) !== '';
  /** Whether a key is set that adsb.lol refused, so calls go without it. */
  const keyRefused = (at = now()) => configuredKey() !== '' && refusalHolds(at);
  /** One key state's calls; the other state's are kept apart. */
  const callsOf = (withKey) => state.calls[withKey ? 'keyed' : 'keyless'];
  /** The calls of the key state calls are sent with now. */
  const calls = (at) => callsOf(keyed(at));

  function limit(at = now()) {
    const raw = String(env.ADSBLOL_DAILY_BUDGET ?? '').trim();
    if (/^\d+$/.test(raw))
      return Math.min(Number(raw), Number.MAX_SAFE_INTEGER);
    return keyed(at) ? ADSBLOL_BUDGET_KEYED : ADSBLOL_BUDGET_KEYLESS;
  }

  /**
   * What a caller may spend in any 24 h: one or more `{kinds, allowed}`,
   * each the callers whose calls count against it and how many it allows.
   */
  function shares(kind, at) {
    const all = limit(at);
    const reserve = Math.floor(all * GNSS_RESERVE);
    const flights = { kinds: ['flights', 'mil'], allowed: all - reserve };
    if (kind === 'flights') return [flights];
    if (kind === 'gnss') return [{ kinds: ['gnss'], allowed: reserve }];
    if (kind === 'mil')
      return [flights, { kinds: KINDS, allowed: Math.floor(all * MIL_SHARE) }];
    throw new TypeError(`Unknown adsb.lol caller: ${kind}`);
  }

  function prune(at) {
    for (const minutes of Object.values(state.calls))
      for (const minute of minutes.keys())
        if (bucketLeavesAt(minute) <= at) minutes.delete(minute);
  }

  /** These callers' counted calls, oldest minute first: `[[minute, n]]`. */
  function counted(kinds, at) {
    prune(at);
    const rows = [];
    for (const [minute, byKind] of calls(at)) {
      let n = 0;
      for (const kind of kinds) n += byKind[kind] ?? 0;
      if (n > 0) rows.push([minute, n]);
    }
    return rows.sort((a, b) => a[0] - b[0]);
  }

  /** When fewer than `allowed` of these rows are counted again. */
  function freesAt(rows, allowed, at) {
    let excess = total(rows) - allowed + 1;
    if (excess <= 0) return at;
    for (const [minute, n] of rows) {
      excess -= n;
      if (excess <= 0) return bucketLeavesAt(minute);
    }
    // A share of nothing never frees: ask again in a day.
    return at + WINDOW_MS;
  }

  /** The adsb.lol lock in force for the key state calls go with now, else 0. */
  function lockedUntil(at) {
    const lock = state.lock;
    return lock && lock.until > at && lock.keyed === keyed(at) ? lock.until : 0;
  }

  function load() {
    if (state.loaded) return;
    state.loaded = true;
    if (!statePath) return;
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT')
        warnOnce(
          'read',
          '[adsb.lol] the saved daily budget could not be read; counting from zero',
        );
      return;
    }
    const at = now();
    const add = (keyState, minute, byKind) => {
      // Counts from a clock more than a window ahead are not believed.
      if (!Number.isSafeInteger(minute) || minute > minuteOf(at + WINDOW_MS))
        return;
      const row = { flights: 0, gnss: 0, mil: 0 };
      for (const kind of KINDS) {
        const n = byKind[kind];
        if (Number.isSafeInteger(n) && n > 0) row[kind] = n;
      }
      if (KINDS.some((kind) => row[kind] > 0))
        state.calls[keyState].set(minute, row);
    };
    if (Array.isArray(saved?.calls)) {
      // The first format kept one count a minute: read it as the flights'.
      for (const [minute, n] of saved.calls.filter(Array.isArray))
        add('keyless', minute, { flights: n });
    } else {
      for (const keyState of ['keyless', 'keyed']) {
        const rows = saved?.calls?.[keyState];
        for (const row of Array.isArray(rows) ? rows : []) {
          if (!Array.isArray(row)) continue;
          const [minute, flights, gnss, mil] = row;
          add(keyState, minute, { flights, gnss, mil });
        }
      }
    }
    prune(at);
    const lock = saved?.lock;
    if (Number.isFinite(lock?.until) && lock.until > at)
      state.lock = {
        until: Math.min(lock.until, at + LOCK_MAX_MS),
        status: Number.isSafeInteger(lock.status) ? lock.status : 429,
        keyed: lock.keyed === true,
      };
  }

  /** Write the counts and the lock, never the key, after a change. */
  function persist() {
    if (!statePath) return;
    state.dirty = true;
    if (state.writing) return;
    state.writing = (async () => {
      while (state.dirty) {
        state.dirty = false;
        const at = now();
        prune(at);
        const lock = state.lock?.until > at ? state.lock : null;
        const text = JSON.stringify({
          version: 2,
          calls: Object.fromEntries(
            Object.entries(state.calls).map(([keyState, minutes]) => [
              keyState,
              [...minutes]
                .sort((a, b) => a[0] - b[0])
                .map(([minute, row]) => [
                  minute,
                  row.flights,
                  row.gnss,
                  row.mil,
                ]),
            ]),
          ),
          lock,
        });
        const temp = `${statePath}.${process.pid}.tmp`;
        try {
          await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
          await fs.promises.writeFile(temp, text, 'utf8');
          await fs.promises.rename(temp, statePath);
        } catch (error) {
          warnOnce(
            'write',
            `[adsb.lol] the daily budget could not be saved (${error?.code || 'error'}); it is kept in memory`,
          );
        }
      }
    })().finally(() => {
      state.writing = null;
    });
  }

  /** Count one call sent now, with a key or without; the ticket takes it back. */
  function count(kind, at, withKey) {
    const minutes = callsOf(withKey);
    const minute = minuteOf(at);
    const row = minutes.get(minute) ?? { flights: 0, gnss: 0, mil: 0 };
    row[kind] += 1;
    minutes.set(minute, row);
    persist();
    return { minutes, minute, kind };
  }

  /** Take back a call that never reached adsb.lol. */
  function uncount({ minutes, minute, kind }) {
    const row = minutes.get(minute);
    if (!row?.[kind]) return;
    row[kind] -= 1;
    if (!KINDS.some((other) => row[other] > 0)) minutes.delete(minute);
    persist();
  }

  /**
   * Lock every path for the key state the refused call was sent with (a key
   * saved meanwhile has a quota of its own); resolves to the lock's end.
   */
  function lockFor(ms, status, at, withKey) {
    const until = at + clamp(ms, LOCK_MIN_MS, LOCK_MAX_MS);
    // Overlapping refusals keep the longest lock for one key state.
    if (state.lock?.keyed === withKey && state.lock.until >= until)
      return state.lock.until;
    state.lock = { until, status, keyed: withKey };
    warn(
      `[adsb.lol] HTTP ${status}: no adsb.lol call until ${new Date(until).toISOString()}`,
    );
    persist();
    return until;
  }

  /**
   * Hold a caller back after a failed call: 60 s, doubling with each failure
   * in a row up to 15 min, or `atLeastMs` when that is longer.
   */
  function holdBack(kind, status, at, atLeastMs = 0) {
    const previous = holds.get(kind);
    const streak = (previous?.streak ?? 0) + 1;
    const backoff = Math.min(
      HOLD_LONGEST_MS,
      HOLD_FIRST_MS * 2 ** (streak - 1),
    );
    const until = Math.max(
      previous?.until ?? 0,
      at + Math.max(backoff, atLeastMs),
    );
    holds.set(kind, { until, status, streak });
    return until;
  }

  /**
   * May this caller ask adsb.lol now? null when it may, else why not and
   * until when: `{reason, until, status, retryAfterMs}`.
   * @param {'flights'|'gnss'|'mil'} kind
   * @param {number} [at]
   */
  function admit(kind, at = now()) {
    load();
    const lock = lockedUntil(at);
    if (lock) {
      const status = state.lock.status;
      return { reason: 'locked', until: lock, status, retryAfterMs: lock - at };
    }
    let until = 0;
    for (const { kinds, allowed } of shares(kind, at)) {
      const rows = counted(kinds, at);
      if (total(rows) >= allowed)
        until = Math.max(until, freesAt(rows, allowed, at));
    }
    if (until)
      return { reason: 'budget', until, status: 429, retryAfterMs: until - at };
    const hold = holds.get(kind);
    if (hold?.until > at)
      return {
        reason: 'cooldown',
        until: hold.until,
        status: hold.status,
        retryAfterMs: hold.until - at,
      };
    return null;
  }

  /**
   * Classify a non-OK answer: lock every path, leave a refused key out, or
   * hold the caller back. `sent` is the key state the call went out with.
   */
  async function refuse(kind, response, signal, sent) {
    const status = response.status;
    // Only a 403 is read, and only its start: it may speak of quota.
    const text = status === 403 ? await bodyStart(response, signal) : '';
    if (status !== 403) void response.body?.cancel().catch(() => {});
    const at = now();
    const asked = adsbLolRetryAfterMs(
      response.headers?.get?.('retry-after'),
      at,
    );
    if (
      status === 429 ||
      (status === 403 && /quota|rate[\s_-]?limit|too many requests/i.test(text))
    ) {
      const until = lockFor(asked ?? LOCK_DEFAULT_MS, status, at, sent.keyed);
      return refusalError({ reason: 'locked', until, status }, at);
    }
    if ((status === 401 || status === 403) && sent.keyed) {
      // The key itself was refused: the next calls go without it, at once,
      // and it is tried again once the refusal has run out.
      state.refusedKey = { print: sent.print, until: at + REFUSED_KEY_MS };
      warnOnce(
        'refused-key',
        `[adsb.lol] HTTP ${status}: the key was refused; check ADSBLOL_API_KEY. Asking without a key meanwhile`,
      );
      return refusalError({ reason: 'upstream', until: at, status }, at);
    }
    if (status === 401 || status === 403)
      warnOnce(
        `refused-keyless-${status}`,
        `[adsb.lol] HTTP ${status}: adsb.lol refused a request without a key`,
      );
    const until = holdBack(
      kind,
      status,
      at,
      status === 401 || status === 403
        ? REFUSED_KEY_MS
        : status >= 500 && asked !== null
          ? Math.min(asked, SERVER_RETRY_MAX_MS)
          : 0,
    );
    return refusalError({ reason: 'upstream', until, status }, at);
  }

  /**
   * Send one call to an adsb.lol path, if this caller may (else it throws an
   * AdsbLolRefusal). `read(response, signal)` reads, and may check, the OK
   * body within the same deadline. Every failure throws an AdsbLolRefusal
   * (its `cause` the error met) and, but for a refused key, holds the caller
   * back; a call that never reached adsb.lol is taken back from the count.
   * Only the requester's own abort is thrown as it came.
   * @param {'flights'|'gnss'|'mil'} kind
   * @param {string} pathname e.g. `/v2/mil`
   * @param {{read?: (response: Response, signal: AbortSignal) => Promise<unknown>,
   *   timeoutMs?: number, userAgent?: string, signal?: AbortSignal}} [options]
   */
  async function request(
    kind,
    pathname,
    { read, timeoutMs = 10_000, userAgent, signal } = {},
  ) {
    const at = now();
    const refused = admit(kind, at);
    if (refused) throw refusalError(refused, at);
    // The key state the call goes with is the one it counts, locks and is
    // refused under, whatever is saved before it answers.
    const key = apiKey(at);
    const sent = { keyed: key !== '', print: key ? state.keyPrint : '' };
    // A sent call counts, whatever it answers.
    const ticket = count(kind, at, sent.keyed);
    const deadline = AbortSignal.timeout(timeoutMs);
    const requestSignal = signal
      ? AbortSignal.any([signal, deadline])
      : deadline;
    const failed = (error) => {
      const failedAt = now();
      const timedOut =
        error?.name === 'TimeoutError' ||
        (error?.name === 'AbortError' && deadline.aborted);
      const status = timedOut ? 504 : 502;
      const until = holdBack(kind, status, failedAt);
      return refusalError(
        { reason: timedOut ? 'timeout' : 'failed', until, status },
        failedAt,
        error,
      );
    };
    let response;
    try {
      response = await fetchImpl(`${ADSBLOL_ORIGIN}${pathname}`, {
        headers: {
          Accept: 'application/json',
          ...(userAgent ? { 'User-Agent': userAgent } : {}),
          ...(key ? { 'x-api-key': key } : {}),
        },
        redirect: 'error',
        signal: requestSignal,
      });
    } catch (error) {
      // The requester left: that is no failure of adsb.lol's.
      if (signal?.aborted) throw error;
      if (unreached(error)) uncount(ticket);
      throw failed(error);
    }
    if (!response.ok) throw await refuse(kind, response, requestSignal, sent);
    try {
      const value = read ? await read(response, requestSignal) : response;
      // A good answer lifts this caller's own hold.
      holds.delete(kind);
      return value;
    } catch (error) {
      if (signal?.aborted) throw error;
      throw failed(error);
    }
  }

  /**
   * The pace the calls counted allow, unclamped, and its even gap (the
   * paced share spread evenly over the window); both Infinity for a share
   * too small to pace. See gapMs.
   */
  function pace(kind, at) {
    if (!PACING[kind]) throw new TypeError(`adsb.lol does not pace ${kind}`);
    const [{ kinds, allowed }] = shares(kind, at);
    const paced = Math.floor(allowed * PACED_SHARE);
    if (paced <= 0) return { gap: Infinity, even: Infinity };
    const rows = counted(kinds, at);
    // Paced calls that fit before the next counted minute leaves the window.
    let room = paced - total(rows);
    const even = WINDOW_MS / paced;
    let gap = even;
    for (const [minute, n] of rows) {
      const span = bucketLeavesAt(minute) - at;
      gap = Math.max(gap, room < 0 ? span : span / (room + 1));
      room += n;
    }
    return { gap, even };
  }

  /**
   * The least time between two calls for the same place (flights or GNSS):
   * never faster than 90 % of the caller's share spread evenly over the
   * window, and slower while the calls already counted would leave too
   * little of it before they leave the window. That is the exact bound: if
   * every later call for the place keeps this gap, no 24 h ever holds more
   * than the 90 %.
   * @param {'flights'|'gnss'} kind
   * @param {number} [at]
   */
  function gapMs(kind, at = now()) {
    load();
    const [least, most] = PACING[kind] ?? [];
    return clamp(pace(kind, at).gap, least, most);
  }

  /**
   * Whether a new place may be asked about at once: while the calls counted
   * keep the pace within NEW_PLACE_SLACK times its even gap, which spares
   * the rest of the paced share for the places already asked about. From an
   * empty window that lets a burst spend about half of it at once.
   * @param {'flights'|'gnss'} kind
   * @param {number} [at]
   */
  function roomForNew(kind, at = now()) {
    load();
    const { gap, even } = pace(kind, at);
    return Number.isFinite(gap) && gap <= even * NEW_PLACE_SLACK;
  }

  /**
   * What the budget stands at, for headers and logs: never the key. `used`
   * and `limit` are those of the key state calls go with now, every caller
   * together; `keyRefused` says a key is set that adsb.lol refused (calls go
   * without it meanwhile); `lockedUntil` is adsb.lol's own lock;
   * `nextResetHint` is when the oldest counted call leaves the window. Times
   * are epoch ms, or null.
   */
  function status(at = now()) {
    load();
    const rows = counted(KINDS, at);
    return {
      keyed: keyed(at),
      keyRefused: keyRefused(at),
      used: total(rows),
      limit: limit(at),
      lockedUntil: lockedUntil(at) || null,
      nextResetHint: rows.length ? bucketLeavesAt(rows[0][0]) : null,
    };
  }

  return {
    admit,
    request,
    gapMs,
    roomForNew,
    status,
    /** Resolves once the last change is written (tests, shutdown). */
    flush: () => state.writing ?? Promise.resolve(),
  };
}

/**
 * The composition's transport: its memory lives on globalThis, one per file,
 * so every caller and every in-process restart of the dev server shares it.
 * @param {Parameters<typeof createAdsbLolUpstream>[0]} [options]
 */
export function sharedAdsbLolUpstream({ statePath = null, ...options } = {}) {
  const states = (globalThis[SHARED_STATES] ??= new Map());
  const key = statePath ?? '';
  if (!states.has(key)) states.set(key, newState());
  return createAdsbLolUpstream({
    ...options,
    statePath,
    state: states.get(key),
  });
}

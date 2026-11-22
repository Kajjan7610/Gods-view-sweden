import fs from 'node:fs';
import path from 'node:path';
import { readResponseTextCapped } from '../common/http.js';

// Swedish fork: one transport for every CelesTrak call, the GP (TLE) and
// SATCAT routes of celestrak.js, which the satellites layer, Space Missions
// and the voice tools read through. CelesTrak's usage policy
// (https://celestrak.org/usage-policy.php, last updated 2026-11-16) asks a
// machine-to-machine client to stop at once on any answer but HTTP 200 and
// leave it to a human, to stop at least 15 min after a 500 or 503, and warns
// that 403s ignored end at the firewall. Its GP pages are said to allow 50
// HTTP errors (301, 403, 404) in 2 h before that, and Active and Starlink
// one download per update (every 2 h).
//
// - Every failure pauses every CelesTrak call: a 5xx, a timeout, a network
//   error, an unusable body or any other answer but 200 for at least 15 min
//   (a longer Retry-After wins, up to 6 h); a 403, a 429, a redirect (never
//   followed) or any other 4xx for at least 2 h (a longer Retry-After, up to
//   24 h). Each pause is logged once, without the URL.
// - A 404 holds only its URL: it is not asked again in this process, nor for
//   24 h after a restart.
// - HTTP errors (3xx and 4xx) count in a rolling 2 h: the 20th pauses every
//   call for 2 h, well under the 50.
// - A URL is asked at most once in 2 h, whatever it answered; a call that
//   never connected (no name, no route) is taken back.
// - Calls go one at a time, GP before SATCAT, and each checks the pause again
//   right before it is sent, so the first failure stops the rest of a burst.
//   waiting() tells a caller with a copy to answer it at once rather than
//   hold its client while the call waits its turn.
// - The composition's transport keeps this state on globalThis, so a KOPPLA
//   PÅ save, which restarts the dev server in this same process, keeps it,
//   and writes it to its file when it changes. A transport made without a
//   file (tests, embedders) keeps its own.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
/** The pause after a 5xx, a timeout, a network error or an unusable body. */
export const CELESTRAK_SERVER_HOLD_MS = 15 * MINUTE_MS;
/** The pause after a 403, 429, redirect or other 4xx, or a spent budget. */
export const CELESTRAK_REFUSAL_HOLD_MS = 2 * HOUR_MS;
/** A server error's own Retry-After is honoured up to this. */
const SERVER_RETRY_MAX_MS = 6 * HOUR_MS;
/** A refusal's own Retry-After is honoured up to this. */
const REFUSAL_RETRY_MAX_MS = 24 * HOUR_MS;
/** One URL is asked at most once in this long: one download per update. */
export const CELESTRAK_URL_GAP_MS = 2 * HOUR_MS;
/** HTTP errors (3xx, 4xx) are counted over this window… */
export const CELESTRAK_ERROR_WINDOW_MS = 2 * HOUR_MS;
/** …and this many pause every call (CelesTrak is said to allow 50). */
export const CELESTRAK_ERROR_BUDGET = 20;
/** A URL that answered 404 is not asked for this long after a restart. */
export const CELESTRAK_GONE_MS = 24 * HOUR_MS;
/** How long one call may take, its answer and body together. */
const TIMEOUT_MS = 20_000;
// CelesTrak 403s bulk groups (e.g. `active`) unless the request carries a
// descriptive User-Agent with a contact point.
const USER_AGENT =
  'gods-eye-view-celestrak-proxy/1.0 (+https://github.com/Kajjan7610/Gods-view-sweden)';
/**
 * CelesTrak asks for compressed downloads. Node's fetch (undici) already asks
 * for these over https and decodes them; said here so it always holds.
 */
const ACCEPT_ENCODING = 'br, gzip, deflate';
const SHARED_STATES = '__GEV_CELESTRAK_UPSTREAM_STATES';
/** Failures before any connection was made, so CelesTrak never saw the call. */
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
const REFUSALS = Object.freeze({
  held: 'CelesTrak calls are paused',
  gap: 'CelesTrak was asked for this less than 2 h ago',
  gone: 'CelesTrak has nothing for this',
  failed: 'CelesTrak call failed',
});

/**
 * Milliseconds a Retry-After asks for (delay-seconds or a future HTTP date),
 * or null when it is absent, unreadable or already past.
 * @param {string|null|undefined} raw Header value.
 * @param {number} nowMs Epoch ms.
 * @returns {number|null}
 */
export function celestrakRetryAfterMs(raw, nowMs) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  if (/^\d+$/.test(text))
    return Math.min(Number(text) * 1000, Number.MAX_SAFE_INTEGER);
  // A numeric-looking value that is not delay-seconds is not read as a date.
  if (!/[a-z]/i.test(text)) return null;
  const at = Date.parse(text);
  return Number.isFinite(at) && at > nowMs ? at - nowMs : null;
}

/** Whether a fetch failure left no answer (see UNREACHED), causes included. */
function unreached(error, depth = 0) {
  if (!error || depth > 3) return false;
  if (UNREACHED.has(error.code)) return true;
  if (unreached(error.cause, depth + 1)) return true;
  return Array.isArray(error.errors)
    ? error.errors.some((inner) => unreached(inner, depth + 1))
    : false;
}

function newState() {
  return {
    loaded: false,
    /** @type {{until: number, status: number}|null} The pause on every call. */
    hold: null,
    /** When each counted HTTP error came, oldest first. */
    errors: [],
    /** @type {Map<string, number>} URL → when it answered 404. */
    gone: new Map(),
    /** URLs that answered 404 in this process: never asked again. */
    goneHere: new Set(),
    /** @type {Map<string, number>} URL → when it was last sent. */
    sent: new Map(),
    /** Calls waiting their turn, `{url, run}`: GP first, then SATCAT. */
    queue: [[], []],
    /** The URL whose call is in flight, or null. */
    current: null,
    /** @type {Map<string, Promise>} URL → its call, queued or in flight. */
    pending: new Map(),
    writing: null,
    dirty: false,
    warned: new Set(),
  };
}

/** Start the next call once none is in flight. */
function drain(state) {
  if (state.current !== null) return;
  const next = state.queue[0].shift() ?? state.queue[1].shift();
  if (!next) return;
  state.current = next.url;
  next.run().finally(() => {
    state.current = null;
    drain(state);
  });
}

function refusalError(reason, until, status) {
  const error = new Error(REFUSALS[reason]);
  error.name = 'CelestrakRefusal';
  error.reason = reason;
  error.until = until;
  error.status = status;
  return error;
}

/**
 * One CelesTrak transport. `statePath` names the file its pause, error count,
 * 404s and send times are kept in; without it nothing is read or written.
 * `state` is the memory it shares (see sharedCelestrakUpstream); a fresh one
 * by default.
 * @param {object} [options]
 * @param {typeof fetch} [options.fetchImpl]
 * @param {() => number} [options.now] Wall clock, epoch ms.
 * @param {string|null} [options.statePath]
 * @param {(...args: unknown[]) => void} [options.warn]
 */
export function createCelestrakUpstream({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  statePath = null,
  state = newState(),
  warn = (...args) => console.warn(...args),
} = {}) {
  function warnOnce(topic, message) {
    if (state.warned.has(topic)) return;
    state.warned.add(topic);
    warn(message);
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
          '[celestrak-proxy] the saved CelesTrak pause could not be read; starting without it',
        );
      return;
    }
    const at = now();
    // Times from a clock more than a span ahead are not believed.
    const believed = (time, span) =>
      Number.isFinite(time) && time > at - span && time <= at + span;
    const hold = saved?.hold;
    if (Number.isFinite(hold?.until) && hold.until > at)
      state.hold = {
        // Never longer than the longest pause CelesTrak can ask for.
        until: Math.min(hold.until, at + REFUSAL_RETRY_MAX_MS),
        status: Number.isSafeInteger(hold.status) ? hold.status : 0,
      };
    state.errors = (Array.isArray(saved?.errors) ? saved.errors : [])
      .filter((time) => believed(time, CELESTRAK_ERROR_WINDOW_MS))
      .sort((a, b) => a - b);
    for (const [times, rows, span] of [
      [state.gone, saved?.gone, CELESTRAK_GONE_MS],
      [state.sent, saved?.sent, CELESTRAK_URL_GAP_MS],
    ])
      for (const row of Array.isArray(rows) ? rows : [])
        if (
          Array.isArray(row) &&
          typeof row[0] === 'string' &&
          believed(row[1], span)
        )
          times.set(row[0], row[1]);
  }

  /** Write the pause, the error count, the 404s and the send times. */
  function persist() {
    if (!statePath) return;
    state.dirty = true;
    if (state.writing) return;
    state.writing = (async () => {
      while (state.dirty) {
        state.dirty = false;
        const at = now();
        const recent = (times, span) =>
          [...times].filter(([, time]) => time > at - span);
        const text = JSON.stringify({
          version: 1,
          hold: state.hold?.until > at ? state.hold : null,
          errors: state.errors.filter(
            (time) => time > at - CELESTRAK_ERROR_WINDOW_MS,
          ),
          gone: recent(state.gone, CELESTRAK_GONE_MS),
          sent: recent(state.sent, CELESTRAK_URL_GAP_MS),
        });
        const temp = `${statePath}.${process.pid}.tmp`;
        try {
          await fs.promises.mkdir(path.dirname(statePath), { recursive: true });
          await fs.promises.writeFile(temp, text, 'utf8');
          await fs.promises.rename(temp, statePath);
        } catch (error) {
          warnOnce(
            'write',
            `[celestrak-proxy] the CelesTrak pause could not be saved (${error?.code || 'error'}); it is kept in memory`,
          );
        }
      }
    })().finally(() => {
      state.writing = null;
    });
  }

  /**
   * Pause every call until `at + ms`; a longer pause already set stays.
   * Said once, when the pause starts or grows, or `always`. Returns the
   * pause's end.
   */
  function pause(ms, status, at, says, policy, always = false) {
    const longer = !(state.hold && state.hold.until >= at + ms);
    if (longer) {
      state.hold = { until: at + ms, status };
      persist();
    }
    if (longer || always)
      warn(
        `[celestrak-proxy] ${says}: requests paused until ${new Date(state.hold.until).toISOString()}${policy ? '; check the usage policy' : ''}`,
      );
    return state.hold.until;
  }

  /**
   * Count one HTTP error; the budget's last pauses every call, said even
   * when the answer's own pause already reaches as far.
   */
  function countError(status, at) {
    state.errors = state.errors.filter(
      (time) => time > at - CELESTRAK_ERROR_WINDOW_MS,
    );
    state.errors.push(at);
    persist();
    if (state.errors.length >= CELESTRAK_ERROR_BUDGET)
      pause(
        CELESTRAK_REFUSAL_HOLD_MS,
        status,
        at,
        `${state.errors.length} CelesTrak errors in 2 h`,
        true,
        true,
      );
  }

  /** Why this URL may not be sent now (see admit), or null. */
  function refusalFor(url, at) {
    load();
    const goneAt = state.gone.get(url);
    if (
      state.goneHere.has(url) ||
      (goneAt !== undefined && at - goneAt < CELESTRAK_GONE_MS)
    )
      return { reason: 'gone', until: Infinity, status: 404 };
    const hold = state.hold?.until > at ? state.hold : null;
    const sent = state.sent.get(url);
    const gapUntil = sent === undefined ? 0 : sent + CELESTRAK_URL_GAP_MS;
    if (gapUntil > at && gapUntil > (hold?.until ?? 0))
      return { reason: 'gap', until: gapUntil, status: null };
    return hold
      ? { reason: 'held', until: hold.until, status: hold.status }
      : null;
  }

  /**
   * May this URL be asked now? null when it may, or when a call for it is
   * already queued or in flight (request() shares that one); else why not
   * and until when: `{reason, until, status}`. A 404's URL (`gone`) has no
   * end (Infinity); `gap` is the URL's own 2 h; `held` the pause on every
   * call.
   * @param {string} url
   * @param {number} [at]
   */
  function admit(url, at = now()) {
    return state.pending.has(url) ? null : refusalFor(url, at);
  }

  /** Pause after a call that went wrong before its answer was read whole. */
  function failed(error, deadline, reading) {
    const at = now();
    const timedOut = deadline.aborted || error?.name === 'TimeoutError';
    const status = timedOut ? 504 : 502;
    const says = timedOut
      ? `CelesTrak did not answer within ${TIMEOUT_MS / 1000} s`
      : error?.code === 'RESPONSE_TOO_LARGE'
        ? 'CelesTrak sent an answer too large to read'
        : reading
          ? "CelesTrak's answer broke off"
          : 'CelesTrak could not be reached';
    const until = pause(CELESTRAK_SERVER_HOLD_MS, status, at, says, false);
    return refusalError('failed', until, status);
  }

  /** Classify an answer but 200: pause every call, or leave out a 404's URL. */
  function refuse(url, response, label) {
    const at = now();
    const status = response.status;
    const asked = celestrakRetryAfterMs(
      response.headers?.get?.('retry-after'),
      at,
    );
    const redirect =
      response.type === 'opaqueredirect' || (status >= 300 && status < 400);
    const refused = redirect || (status >= 400 && status < 500);
    if (status === 404) {
      state.gone.set(url, at);
      state.goneHere.add(url);
      persist();
      warn(
        `[celestrak-proxy] CelesTrak answered 404 for ${label}: not asked again, nor for 24 h after a restart`,
      );
      // CelesTrak counts redirects, 403s and 404s towards its firewall.
      countError(status, at);
      return refusalError('gone', Infinity, 404);
    }
    const ms = refused
      ? Math.max(
          CELESTRAK_REFUSAL_HOLD_MS,
          Math.min(asked ?? 0, REFUSAL_RETRY_MAX_MS),
        )
      : Math.max(
          CELESTRAK_SERVER_HOLD_MS,
          Math.min(asked ?? 0, SERVER_RETRY_MAX_MS),
        );
    const says = redirect
      ? `CelesTrak redirected the request${status ? ` (${status})` : ''}`
      : status === 403 || status === 429
        ? `CelesTrak refused (${status})`
        : `CelesTrak answered HTTP ${status}`;
    // The answer's own pause is said first, then the budget if it is spent.
    pause(ms, status, at, says, refused);
    if (refused) countError(status, at);
    return refusalError('held', state.hold.until, status);
  }

  /** Send one call now, unless its URL may not be asked now. */
  async function send(
    url,
    { label = 'a CelesTrak call', validate, invalid, maxBytes },
  ) {
    const at = now();
    // Checked again now, its turn come: a call before it may have failed.
    const refusal = refusalFor(url, at);
    if (refusal)
      throw refusalError(refusal.reason, refusal.until, refusal.status);
    // A sent call starts its URL's 2 h, whatever it answers.
    const before = state.sent.get(url);
    state.sent.set(url, at);
    persist();
    const deadline = AbortSignal.timeout(TIMEOUT_MS);
    let response;
    try {
      response = await fetchImpl(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept-Encoding': ACCEPT_ENCODING,
        },
        // CelesTrak counts a redirect as an error: it is never followed.
        redirect: 'manual',
        signal: deadline,
      });
    } catch (error) {
      if (unreached(error)) {
        // CelesTrak never saw it: the URL's 2 h does not start.
        if (before === undefined) state.sent.delete(url);
        else state.sent.set(url, before);
        persist();
      }
      throw failed(error, deadline, false);
    }
    if (response.status !== 200 || response.type === 'opaqueredirect') {
      void response.body?.cancel().catch(() => {});
      throw refuse(url, response, label);
    }
    let body;
    try {
      body = await readResponseTextCapped(response, maxBytes, deadline);
    } catch (error) {
      throw failed(error, deadline, true);
    }
    if (!validate(body)) {
      const until = pause(
        CELESTRAK_SERVER_HOLD_MS,
        502,
        now(),
        `CelesTrak's answer was not usable (${invalid})`,
        false,
      );
      throw refusalError('failed', until, 502);
    }
    return { at: now(), body };
  }

  /**
   * Ask CelesTrak for one URL when its turn comes, if it may be asked then.
   * Resolves to `{at, body}`: a 200 body that `validate` accepts. A refusal
   * or a failure rejects with a CelestrakRefusal; a failure pauses as the
   * comment at the top of this file says. A URL already queued or in flight
   * shares that call.
   * @param {string} url
   * @param {{label: string, validate: (body: string) => boolean,
   *   invalid: string, maxBytes: number, priority?: 0|1}} options
   *   `label` names the call in a log line (never the URL); `priority` 0
   *   (GP, the default) goes before 1 (SATCAT).
   * @returns {Promise<{at: number, body: string}>}
   */
  function request(url, options) {
    const queued = state.pending.get(url);
    if (queued) return queued;
    const call = new Promise((resolve, reject) => {
      state.queue[options.priority === 1 ? 1 : 0].push({
        url,
        run: () =>
          send(url, options).then(
            (value) => {
              state.pending.delete(url);
              resolve(value);
            },
            (error) => {
              state.pending.delete(url);
              reject(error);
            },
          ),
      });
    });
    state.pending.set(url, call);
    drain(state);
    return call;
  }

  /**
   * Whether this URL's call waits its turn behind another (queued, not yet
   * sent): a caller holding a copy answers with it rather than wait.
   * @param {string} url
   */
  const waiting = (url) => state.pending.has(url) && state.current !== url;

  /**
   * What holds now, for tests and logs: the pause on every call
   * (`heldUntil`, epoch ms, or null), the HTTP errors counted in the last
   * 2 h and the URLs left out after a 404.
   */
  function status(at = now()) {
    load();
    return {
      heldUntil: state.hold?.until > at ? state.hold.until : null,
      errors: state.errors.filter(
        (time) => time > at - CELESTRAK_ERROR_WINDOW_MS,
      ).length,
      gone: [...state.gone].filter(
        ([url, time]) =>
          state.goneHere.has(url) || at - time < CELESTRAK_GONE_MS,
      ).length,
    };
  }

  return {
    admit,
    request,
    waiting,
    status,
    /** Resolves once the last change is written (tests, shutdown). */
    flush: () => state.writing ?? Promise.resolve(),
  };
}

/**
 * The composition's transport: its memory lives on globalThis, one per file,
 * so every in-process restart of the dev server shares it.
 * @param {Parameters<typeof createCelestrakUpstream>[0]} [options]
 */
export function sharedCelestrakUpstream({ statePath = null, ...options } = {}) {
  const states = (globalThis[SHARED_STATES] ??= new Map());
  const key = statePath ?? '';
  if (!states.has(key)) states.set(key, newState());
  return createCelestrakUpstream({
    ...options,
    statePath,
    state: states.get(key),
  });
}

// Polismyndigheten's rules for its open data APIs ("Regler för öppna data",
// reviewed by the agency 2026-09-24): every call over HTTPS with a User-Agent
// naming the app, at least 10 seconds apart, at most 60 an hour and 1 440 a
// day, and a 404 is permanent: that resource is not asked again. Notices
// every 5 minutes, stations once a day and a failure left alone for 5 minutes
// keep both routes far under the hourly cap.

/** The app's name, and where Polisen can find who runs it. */
export const POLISEN_USER_AGENT =
  'GodsEyeViewSverige/1.0 (+https://github.com/Kajjan7610/Gods-view-sweden)';
export const POLISEN_HEADERS = Object.freeze({
  Accept: 'application/json',
  'User-Agent': POLISEN_USER_AGENT,
});
/** At least this long between any two calls to Polisen. */
export const POLISEN_MIN_GAP_MS = 10_000;
/** After a failed call Polisen is left alone this long. */
export const POLISEN_RETRY_AFTER_FAILURE_MS = 5 * 60_000;
/** After Polisen answers 429 (too many calls), left alone this long. */
export const POLISEN_RETRY_AFTER_RATE_LIMIT_MS = 30 * 60_000;

/** Polisen answered 404: the resource is gone and is not asked again. */
export class PolisenGoneError extends Error {
  constructor(url) {
    super(`Polisen answered 404 for ${url}; not asked again`);
    this.gone = true;
  }
}

/** How long Polisen is left alone after this error. */
export const polisenRetryAfterMs = (error) =>
  error?.status === 429
    ? POLISEN_RETRY_AFTER_RATE_LIMIT_MS
    : POLISEN_RETRY_AFTER_FAILURE_MS;

/**
 * One gate for every call to Polisen in this server: a call waits until 10
 * seconds have passed since the one before it.
 */
export function createPolisenGate({
  now = () => Date.now(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let next = 0;
  return async function waitForTurn() {
    const at = Math.max(now(), next);
    next = at + POLISEN_MIN_GAP_MS;
    const wait = at - now();
    if (wait > 0) await sleep(wait);
  };
}

/** The gate the events and the stations share. */
export const polisenGate = createPolisenGate();

/**
 * A call to Polisen by its rules; the response, or an error carrying the
 * HTTP status (a PolisenGoneError for 404).
 */
export async function fetchPolisen(fetchImpl, gate, url, { signal } = {}) {
  await gate();
  const response = await fetchImpl(url, {
    signal,
    redirect: 'manual',
    headers: POLISEN_HEADERS,
  });
  if (response.ok) return response;
  try {
    await response.body?.cancel();
  } catch {
    /* no-op */
  }
  if (response.status === 404) throw new PolisenGoneError(url);
  throw Object.assign(new Error(`upstream HTTP ${response.status}`), {
    status: response.status,
  });
}

/**
 * Bound an upstream Retry-After delay (seconds or HTTP date). Swedish fork:
 * `maxMs` lets a caller honour a longer wait than the 30-minute default.
 */
export function providerCooldownMs(
  response,
  now = Date.now(),
  maxMs = 30 * 60000,
) {
  const raw = response?.headers?.get('retry-after')?.trim();
  const seconds = raw && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : NaN;
  const deadline = raw && !Number.isFinite(seconds) ? Date.parse(raw) : NaN;
  const delay = Number.isFinite(seconds)
    ? seconds * 1000
    : Number.isFinite(deadline)
      ? deadline - now
      : 60000;
  return Math.min(maxMs, Math.max(5000, delay));
}

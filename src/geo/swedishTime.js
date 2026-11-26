/**
 * Swedish fork: Sweden's own clock for the HUD summary's zone tag.
 *
 * The original names a view's zone from its longitude (15° an hour), which
 * over Sweden says UTC+1 the year round, also in summer when Swedish clocks
 * are on UTC+2. Inside the area below the tag is Sweden's offset from the
 * `Europe/Stockholm` rules at the HUD's world time (so a view of a summer
 * day says UTC+2). Elsewhere it is null and the original's estimate stays.
 *
 * The area's west and south take in Norway, Denmark and the coasts across
 * the Baltic to the south-west, which keep the same clock as Sweden. Its
 * east is the Swedish-Finnish land border from Treriksröset down the
 * Könkämä, Muonio and Torne rivers, as Natural Earth 10m draws it (public
 * domain, simplified, so within up to about 2-3 km of the border either
 * clock may be named), then the open water between Sweden
 * and the Finnish, Åland and Baltic coasts, which keep UTC+2/+3.
 * Points are [lon, lat].
 */
const SWEDISH_CLOCK_AREA = Object.freeze([
  [4.0, 54.8],
  [4.0, 71.5],
  [20.548, 71.5],
  // Treriksröset, then the land border (Natural Earth 10m admin-0).
  [20.548, 69.06],
  [20.623, 69.036],
  [20.911, 68.981],
  [20.934, 68.949],
  [20.888, 68.927],
  [20.906, 68.895],
  [21.072, 68.869],
  [21.305, 68.756],
  [21.406, 68.749],
  [21.464, 68.687],
  [21.717, 68.619],
  [21.737, 68.588],
  [21.919, 68.568],
  [22.072, 68.477],
  [22.303, 68.476],
  [22.808, 68.395],
  [23.067, 68.29],
  [23.155, 68.217],
  [23.166, 68.122],
  [23.307, 68.146],
  [23.383, 68.051],
  [23.662, 67.95],
  [23.636, 67.913],
  [23.481, 67.865],
  [23.485, 67.737],
  [23.554, 67.587],
  [23.473, 67.555],
  [23.431, 67.486],
  [23.477, 67.444],
  [23.765, 67.42],
  [23.751, 67.346],
  [23.786, 67.338],
  [23.735, 67.29],
  [23.603, 67.26],
  [23.615, 67.214],
  [23.581, 67.153],
  [24.004, 66.805],
  [23.892, 66.751],
  [23.882, 66.564],
  [23.652, 66.459],
  [23.663, 66.317],
  [23.724, 66.207],
  [23.889, 66.161],
  [24.02, 66.049],
  [24.055, 65.948],
  [24.163, 65.823],
  // The sea border off the Torne mouth, then the Bay and Sea of Bothnia
  // between the two coasts.
  [24.15, 65.5],
  [22.7, 64.75],
  [21.3, 63.62],
  [20.4, 63.2],
  [19.6, 62.4],
  [19.4, 61.3],
  // West of Åland.
  [19.25, 60.5],
  [19.25, 60.0],
  [19.6, 59.8],
  // The Baltic between Gotland and Saaremaa, Latvia and Lithuania.
  [20.5, 58.5],
  [20.2, 57.0],
  [19.6, 56.0],
  [19.0, 54.8],
]);

/** Whether [lon, lat] lies inside `ring` (ray casting). */
function inRing(ring, lon, lat) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

let stockholmParts = null;

/**
 * Sweden's offset from UTC, whole hours, at `ms`; null without Intl rules or
 * for a time the rules cannot place (a world time before year 100 or BC
 * reads back as no offset at all).
 */
export function stockholmOffsetHours(ms) {
  if (!Number.isFinite(ms)) return null;
  try {
    stockholmParts ??= new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Stockholm',
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
    });
    const parts = stockholmParts.formatToParts(new Date(ms));
    const part = (type) =>
      Number(parts.find((entry) => entry.type === type)?.value);
    // setUTCFullYear keeps years 0-99 as they are (Date.UTC would not).
    const local = new Date(0);
    local.setUTCFullYear(part('year'), part('month') - 1, part('day'));
    local.setUTCHours(part('hour') % 24, part('minute'), 0, 0);
    const offset = Math.round(
      (local.getTime() - Math.floor(ms / 60000) * 60000) / 36e5,
    );
    // Real offsets run from UTC-12 to UTC+14; anything else is a misread.
    return Number.isFinite(offset) && offset >= -12 && offset <= 14
      ? offset
      : null;
  } catch {
    return null;
  }
}

/**
 * The zone tag ("UTC+1", "UTC+2") for a point under Sweden's clock at `ms`,
 * or null outside that area or without time-zone rules.
 * @param {number} latDeg
 * @param {number} lonDeg
 * @param {number} ms World time, ms since the epoch.
 * @returns {string|null}
 */
export function swedishZoneTag(latDeg, lonDeg, ms) {
  if (!Number.isFinite(latDeg) || !Number.isFinite(lonDeg)) return null;
  if (!inRing(SWEDISH_CLOCK_AREA, lonDeg, latDeg)) return null;
  const offset = stockholmOffsetHours(ms);
  return offset === null ? null : `UTC${offset >= 0 ? '+' : ''}${offset}`;
}

/** Fixed upstream request URLs; callers own validation, credentials and transport. */
/**
 * CelesTrak GP data (orbital elements) for a group, as CSV. Swedish fork:
 * CelesTrak sends no TLE for objects numbered 100000 and up; CSV carries
 * every object. `FORMAT=CSV` as CelesTrak's GP documentation writes it
 * (celestrak.org/NORAD/documentation/gp-data-formats.php).
 */
export function celestrakGpUrl(group) {
  const url = new URL('https://celestrak.org/NORAD/elements/gp.php');
  url.searchParams.set('GROUP', group);
  url.searchParams.set('FORMAT', 'CSV');
  return url;
}

// Swedish fork: the old name, kept for consumers of `sources/space` and for
// upstream merges. It asks for CSV too: no request asks for the TLE format.
/** @deprecated Use celestrakGpUrl. */
export const celestrakTleUrl = celestrakGpUrl;

/** CelesTrak SATCAT records (object type, status, owner) for a GP group, as CSV. */
export function celestrakSatcatUrl(group) {
  const url = new URL('https://celestrak.org/satcat/records.php');
  url.searchParams.set('GROUP', group);
  url.searchParams.set('FORMAT', 'CSV');
  return url;
}

export function launchLibraryRecentUrl(end) {
  // Stable minute boundaries let different installations share LL2's cache.
  const roundedEnd = new Date(Math.floor(end.getTime() / 60000) * 60000);
  const start = new Date(roundedEnd.getTime() - 30 * 86400000);
  const url = new URL('https://ll.thespacedevs.com/2.3.0/launches/');
  url.searchParams.set('net__gte', start.toISOString());
  url.searchParams.set('net__lte', roundedEnd.toISOString());
  url.searchParams.set('limit', '100');
  url.searchParams.set('mode', 'detailed');
  return url;
}

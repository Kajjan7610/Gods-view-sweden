/**
 * Swedish fork: a layer's own rows as the records the context panel counts
 * "in view" and the analyst reads (src/data/entityContext.js reads them
 * through a layer's getAnalystRecords). Pure — no Cesium, no i18n.
 */

/** Records a layer hands out when no count is asked for. */
export const ANALYST_RECORDS_MAX = 2000;

/**
 * Rows as records `{ id, name, lat, lon, ...extra }`: `place(row)` gives
 * `[lon, lat]` (by default `row.point`), `name(row)` the name a person would
 * use, `extra(row)` a few plain fields worth asking about. Rows without a
 * place are left out; at most `maxCount` are returned.
 */
export function analystRows(
  rows,
  maxCount = ANALYST_RECORDS_MAX,
  {
    place = (row) => row?.point,
    name = (row) => row?.name,
    extra = () => ({}),
  } = {},
) {
  const limit = Number.isFinite(maxCount)
    ? Math.max(1, Math.floor(maxCount))
    : ANALYST_RECORDS_MAX;
  const records = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (records.length >= limit) break;
    const at = place(row);
    const lon = Number(at?.[0]);
    const lat = Number(at?.[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    records.push({
      id: row?.id ?? null,
      name: name(row) ?? null,
      lat,
      lon,
      ...extra(row),
    });
  }
  return records;
}

/** The middle of a ring or line ([[lon, lat], …]) as [lon, lat], or null. */
export function middleOf(points) {
  if (!Array.isArray(points) || !points.length) return null;
  let lon = 0;
  let lat = 0;
  let count = 0;
  for (const point of points) {
    if (!Number.isFinite(point?.[0]) || !Number.isFinite(point?.[1])) continue;
    lon += point[0];
    lat += point[1];
    count += 1;
  }
  return count ? [lon / count, lat / count] : null;
}

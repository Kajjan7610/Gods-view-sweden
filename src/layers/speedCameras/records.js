/**
 * Trafikverket's traffic safety cameras (Swedish fork): pure parsing shared
 * by the server proxy and the layer. No Cesium, no Node built-ins.
 *
 * Trafikverket's open API (TrafficSafetyCamera, CC0) lists every fixed speed
 * camera site in Sweden, some 2,800, with its position, the direction it
 * faces, the road and a place name. The police move the camera equipment
 * between sites, so a site is not always photographing.
 */

/** The counties by Trafikverket's (SCB's) county number. */
export const COUNTIES = Object.freeze({
  1: 'Stockholms län',
  3: 'Uppsala län',
  4: 'Södermanlands län',
  5: 'Östergötlands län',
  6: 'Jönköpings län',
  7: 'Kronobergs län',
  8: 'Kalmar län',
  9: 'Gotlands län',
  10: 'Blekinge län',
  12: 'Skåne län',
  13: 'Hallands län',
  14: 'Västra Götalands län',
  17: 'Värmlands län',
  18: 'Örebro län',
  19: 'Västmanlands län',
  20: 'Dalarnas län',
  21: 'Gävleborgs län',
  22: 'Västernorrlands län',
  23: 'Jämtlands län',
  24: 'Västerbottens län',
  25: 'Norrbottens län',
});

/** Eight compass points, north first; index by {@link compassIndex}. */
export const COMPASS = Object.freeze([
  'N',
  'NE',
  'E',
  'SE',
  'S',
  'SW',
  'W',
  'NW',
]);

/** The compass point nearest a bearing in degrees (0 north, 90 east). */
export const compassIndex = (bearing) =>
  Math.round((((Number(bearing) % 360) + 360) % 360) / 45) % 8;

/**
 * One camera site, or null without a Swedish position.
 * @param {object} row One TrafficSafetyCamera object.
 */
export function normalizeSpeedCamera(row) {
  const match = /POINT \(([-\d.]+) ([-\d.]+)\)/.exec(
    String(row?.Geometry?.WGS84 ?? ''),
  );
  if (!match || row?.Deleted === true || row?.Id == null) return null;
  const lon = Number(match[1]);
  const lat = Number(match[2]);
  if (lat < 54 || lat > 70 || lon < 9 || lon > 25) return null;
  const bearing =
    row.Bearing == null || row.Bearing === '' ? NaN : Number(row.Bearing);
  const county = Array.isArray(row.CountyNo) ? row.CountyNo[0] : row.CountyNo;
  return {
    id: String(row.Id).slice(0, 20),
    name:
      String(row.Name ?? '')
        .trim()
        .slice(0, 80) || String(row.Id),
    road:
      String(row.RoadNumber ?? '')
        .trim()
        .slice(0, 12) || null,
    bearing: Number.isFinite(bearing) ? ((bearing % 360) + 360) % 360 : null,
    county: COUNTIES[Number(county)] ?? null,
    point: [Math.round(lon * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5],
  };
}

/** Every site from Trafikverket's answer, by road then name. */
export function normalizeSpeedCameras(payload) {
  const rows = payload?.RESPONSE?.RESULT?.[0]?.TrafficSafetyCamera;
  if (!Array.isArray(rows)) throw new Error('Malformed speed camera answer');
  return rows
    .map(normalizeSpeedCamera)
    .filter(Boolean)
    .sort(
      (a, b) =>
        String(a.road).localeCompare(String(b.road), 'sv', { numeric: true }) ||
        a.name.localeCompare(b.name, 'sv'),
    );
}

const distanceKm = ([lon1, lat1], [lon2, lat2]) => {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) *
      Math.cos(lat2 * rad) *
      Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
};

/**
 * The sites within `km` of a point ([lon, lat]), nearest first, each with
 * its distance in km.
 */
export function camerasNear(cameras, point, km) {
  return cameras
    .map((camera) => ({ ...camera, km: distanceKm(point, camera.point) }))
    .filter((camera) => camera.km <= km)
    .sort((a, b) => a.km - b.km);
}

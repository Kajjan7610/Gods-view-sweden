/**
 * The 2026 Riksdag election per election district (valdistrikt): pure
 * parsing and geometry shared by the snapshot build, the server route and
 * the layer. No Cesium, no Node built-ins.
 *
 * Valmyndigheten publishes the district maps (drawn by the county boards, in
 * SWEREF 99 TM) and the final votes per district as open data: free to use,
 * with Valmyndigheten credited. A district's votes are the ones counted in
 * it; late advance votes are counted in each municipality's collection
 * district (uppsamlingsdistrikt), which has no area and is not drawn.
 */

import {
  decodeLine,
  encodeLine,
  ringsContain,
} from '../municipalities/records.js';

export { decodeLine, encodeLine };

export const ELECTION_YEAR = 2026;
/** The Riksdag parties by Valmyndigheten's names, in the order shown. */
export const PARTIES = Object.freeze(
  [
    ['S', 'Arbetarepartiet-Socialdemokraterna', '#ed1b34'],
    ['M', 'Moderaterna', '#52bdec'],
    ['SD', 'Sverigedemokraterna', '#dddd00'],
    ['V', 'Vänsterpartiet', '#af0000'],
    ['C', 'Centerpartiet', '#009933'],
    ['KD', 'Kristdemokraterna', '#231977'],
    ['MP', 'Miljöpartiet de gröna', '#83cf39'],
    ['L', 'Liberalerna (tidigare Folkpartiet)', '#006ab3'],
  ].map(([id, name, color]) => Object.freeze({ id, name, color })),
);
export const OTHER_PARTIES = Object.freeze({ id: 'other', color: '#9e9e9e' });
/**
 * Turnout classes in percent, lowest first, on a neutral scale (viridis):
 * no red for low turnout, so no part of a town reads as worse.
 */
export const TURNOUT_CLASSES = Object.freeze(
  [
    ['below-70', 70, '#440154'],
    ['70-80', 80, '#3b528b'],
    ['80-85', 85, '#21918c'],
    ['85-90', 90, '#5ec962'],
    ['above-90', Infinity, '#fde725'],
  ].map(([id, max, color]) => Object.freeze({ id, max, color })),
);
/** Shares and turnout are kept in tenths of a percent. */
const PER_MILLE = 1000;

const finite = (value) => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/**
 * SWEREF 99 TM (EPSG:3006) easting and northing to WGS 84 longitude and
 * latitude, by Lantmäteriet's Gauss–Krüger formulas on GRS 80 (central
 * meridian 15°, scale 0.9996, false easting 500 000 m).
 * @param {[number, number]} point [easting, northing] in metres.
 * @returns {[number, number]} [lon, lat] in degrees.
 */
export function sweref99tmToWgs84([easting, northing]) {
  const a = 6378137;
  const f = 1 / 298.257222101;
  const e2 = f * (2 - f);
  const n = f / (2 - f);
  const aRoof = (a / (1 + n)) * (1 + (n * n) / 4 + n ** 4 / 64);
  const d1 = n / 2 - (2 * n * n) / 3 + (37 * n ** 3) / 96 - n ** 4 / 360;
  const d2 = (n * n) / 48 + n ** 3 / 15 - (437 * n ** 4) / 1440;
  const d3 = (17 * n ** 3) / 480 - (37 * n ** 4) / 840;
  const d4 = (4397 * n ** 4) / 161280;
  const aStar = e2 + e2 ** 2 + e2 ** 3 + e2 ** 4;
  const bStar = -(7 * e2 ** 2 + 17 * e2 ** 3 + 30 * e2 ** 4) / 6;
  const cStar = (224 * e2 ** 3 + 889 * e2 ** 4) / 120;
  const dStar = -(4279 * e2 ** 4) / 1260;
  const k0 = 0.9996;
  const xi = northing / (k0 * aRoof);
  const eta = (easting - 500000) / (k0 * aRoof);
  const xiP =
    xi -
    d1 * Math.sin(2 * xi) * Math.cosh(2 * eta) -
    d2 * Math.sin(4 * xi) * Math.cosh(4 * eta) -
    d3 * Math.sin(6 * xi) * Math.cosh(6 * eta) -
    d4 * Math.sin(8 * xi) * Math.cosh(8 * eta);
  const etaP =
    eta -
    d1 * Math.cos(2 * xi) * Math.sinh(2 * eta) -
    d2 * Math.cos(4 * xi) * Math.sinh(4 * eta) -
    d3 * Math.cos(6 * xi) * Math.sinh(6 * eta) -
    d4 * Math.cos(8 * xi) * Math.sinh(8 * eta);
  const phiStar = Math.asin(Math.sin(xiP) / Math.cosh(etaP));
  const deltaLambda = Math.atan(Math.sinh(etaP) / Math.cos(xiP));
  const s = Math.sin(phiStar) ** 2;
  const phi =
    phiStar +
    Math.sin(phiStar) *
      Math.cos(phiStar) *
      (aStar + bStar * s + cStar * s * s + dStar * s * s * s);
  return [15 + (deltaLambda * 180) / Math.PI, (phi * 180) / Math.PI];
}

/**
 * The final votes per district code: votes counted, each Riksdag party's
 * share and the rest together, and turnout, shares and turnout in tenths of
 * a percent. Collection districts (six-digit codes) are left out.
 * @param {object[]} voteRows "Antal_distrikt" rows.
 * @param {object[]} turnoutRows "Valdeltagande_distrikt" rows.
 * @returns {Map<string, {votes: number, shares: number[], turnout: number|null}>}
 */
export function districtResults(voteRows, turnoutRows) {
  const turnout = new Map(
    turnoutRows.map((row) => [
      String(row.Valdistriktskod ?? ''),
      finite(row['Valdeltagande (%)']),
    ]),
  );
  const named = new Set(PARTIES.map((party) => party.name));
  const meta = new Set([
    'Valtyp',
    'Valdistriktskod',
    'Valdistriktsnamn',
    'Kommunkod',
    'Kommunnamn',
    'Valkretskod',
    'Valkretsnamn',
    'Länskod',
    'Länsnamn',
  ]);
  const out = new Map();
  for (const row of voteRows) {
    const code = String(row.Valdistriktskod ?? '');
    if (!/^\d{8}$/.test(code)) continue;
    const byParty = PARTIES.map((party) => finite(row[party.name]) ?? 0);
    let other = 0;
    for (const [name, value] of Object.entries(row))
      if (!meta.has(name) && !named.has(name)) other += finite(value) ?? 0;
    const votes = byParty.reduce((sum, value) => sum + value, other);
    if (!votes) continue;
    const share = (value) => Math.round((value / votes) * PER_MILLE);
    const fraction = turnout.get(code);
    out.set(code, {
      votes,
      shares: [...byParty.map(share), share(other)],
      turnout:
        fraction != null && fraction > 0
          ? Math.round(fraction * PER_MILLE)
          : null,
    });
  }
  return out;
}

/** The party with the largest share, or null for a district without votes. */
export function leadingParty(shares) {
  if (!Array.isArray(shares) || !shares.length) return null;
  let best = -1;
  let at = -1;
  // Only the named parties lead; "other" is many parties together.
  for (let i = 0; i < PARTIES.length; i++)
    if (shares[i] > best) {
      best = shares[i];
      at = i;
    }
  return at >= 0 ? PARTIES[at] : null;
}

/** The turnout class of a turnout in tenths of a percent, or null. */
export function turnoutClass(turnoutPerMille) {
  if (!Number.isFinite(turnoutPerMille)) return null;
  const percent = turnoutPerMille / 10;
  return TURNOUT_CLASSES.find((entry) => percent < entry.max) ?? null;
}

/** [west, south, east, north] of decoded polygons. */
export function polygonsBounds(polygons) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const polygon of polygons)
    for (const ring of polygon)
      for (const [lon, lat] of ring) {
        if (lon < west) west = lon;
        if (lon > east) east = lon;
        if (lat < south) south = lat;
        if (lat > north) north = lat;
      }
  return [west, south, east, north];
}

/** Whether a point lies in any of a district's decoded polygons. */
export function polygonsContain(polygons, point) {
  return polygons.some((rings) => ringsContain(rings, point));
}

/**
 * The districts whose box meets a view box, nearest the view's centre first,
 * at most `limit`.
 * @param {{b: number[]}[]} districts Snapshot districts (boxes in degrees).
 * @param {number[]} bbox [west, south, east, north].
 * @param {number} limit
 */
export function districtsInView(districts, [west, south, east, north], limit) {
  const cx = (west + east) / 2;
  const cy = (south + north) / 2;
  const cos = Math.cos((cy * Math.PI) / 180);
  return districts
    .filter(
      ({ b }) => b[2] >= west && b[0] <= east && b[3] >= south && b[1] <= north,
    )
    .map((district) => ({
      district,
      d:
        (((district.b[0] + district.b[2]) / 2 - cx) * cos) ** 2 +
        ((district.b[1] + district.b[3]) / 2 - cy) ** 2,
    }))
    .sort((p, q) => p.d - q.d)
    .slice(0, limit)
    .map(({ district }) => district);
}

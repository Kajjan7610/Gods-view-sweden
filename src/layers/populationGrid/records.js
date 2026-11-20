/**
 * Sweden's population per square: SCB's 1 km population grid (open data,
 * CC0; "Källa: SCB" asked for unchanged figures), reference date 31 December
 * 2025, and the 5, 10 and 25 km sums worked out from it (processed SCB data,
 * which SCB asks not to be named the source of). The total per square only,
 * never ages or sexes. Pure lookups shared by the snapshot build, the server
 * route and the layer. No Cesium, no Node built-ins.
 *
 * Privacy: the snapshot keeps a 1 km square as its colour class alone (the
 * build sums the exact counts first), so fewer than 5 people read as "1–4",
 * never as a number, even in the file; a summed square keeps its exact sum
 * and leaves the server rounded (`roundedPeople`).
 */

import { sweref99tmToWgs84 } from '../electionDistricts/records.js';

export { sweref99tmToWgs84 };

/** The year of SCB's grid, its reference date the last day of it. */
export const GRID_YEAR = 2025;
/** The square sizes the snapshot keeps, km: SCB's own, then the sums. */
export const GRID_LEVELS_KM = Object.freeze([1, 5, 10, 25]);
/** The largest view box (its longer side, km) each level is read for. */
const LEVEL_MAX_SPAN_KM = Object.freeze([
  [1, 60],
  [5, 250],
  [10, 600],
]);
/** Fewer people than this in a square is a class, never a number. */
export const SMALL_COUNT = 5;

/**
 * The colour classes, people per km², light to dark. The first is for summed
 * squares alone: a 1 km square with anybody in it has at least 1 per km².
 */
export const DENSITY_CLASSES = Object.freeze(
  [
    ['under-1', 0, '#ffffcc'],
    ['1-4', 1, '#ffeda0'],
    ['5-19', 5, '#fed976'],
    ['20-99', 20, '#feb24c'],
    ['100-499', 100, '#fd8d3c'],
    ['500-1999', 500, '#e31a1c'],
    ['2000-', 2000, '#800026'],
  ].map(([id, from, color]) => Object.freeze({ id, from, color })),
);

/** The class index of a density, people per km². */
export function densityClass(perKm2) {
  for (let index = DENSITY_CLASSES.length - 1; index > 0; index -= 1)
    if (perKm2 >= DENSITY_CLASSES[index].from) return index;
  return 0;
}

/**
 * A summed square's people as shown: null under `SMALL_COUNT`, else to the
 * nearest 10 (100 from 10 000), so no exact count leaves the server.
 */
export function roundedPeople(total) {
  if (!Number.isFinite(total) || total < SMALL_COUNT) return null;
  const step = total >= 10_000 ? 100 : 10;
  return Math.max(step, Math.round(total / step) * step);
}

/**
 * The square size (km) a view box is read at: 1 km close up, then the 5, 10
 * and 25 km sums, so a view never holds many more than ~2 500 squares.
 * @param {number[]} bbox [west, south, east, north], degrees.
 */
export function levelForBox([west, south, east, north]) {
  const midLat = ((south + north) / 2) * (Math.PI / 180);
  const spanKm = Math.max(
    (east - west) * 111.32 * Math.cos(midLat),
    (north - south) * 110.57,
  );
  for (const [km, maxSpan] of LEVEL_MAX_SPAN_KM)
    if (spanKm <= maxSpan) return km;
  return 25;
}

/**
 * A packed level of the snapshot as columns: each square's south-west
 * corner (SWEREF 99 TM metres) and its value: the colour class of a 1 km
 * square, the people of a summed one.
 * @param {{origin: number[], width: number, cells: number[]}} level
 * @param {number} km The level's square size.
 */
export function decodeLevel({ origin, width, cells }, km) {
  const count = Math.floor(cells.length / 2);
  const east = new Int32Array(count);
  const north = new Int32Array(count);
  const values = new Int32Array(count);
  const size = km * 1000;
  let place = 0;
  for (let index = 0; index < count; index += 1) {
    place += cells[index * 2];
    east[index] = (origin[0] + (place % width)) * size;
    north[index] = (origin[1] + Math.floor(place / width)) * size;
    values[index] = cells[index * 2 + 1];
  }
  return { east, north, values };
}

/** A square's corners as [lon, lat], from its south-west corner (m). */
export function squareCorners(east, north, km) {
  const size = km * 1000;
  return [
    [east, north],
    [east + size, north],
    [east + size, north + size],
    [east, north + size],
  ].map((corner) => sweref99tmToWgs84(corner));
}

/** A square's middle as [lon, lat]. */
export const squareCentre = (east, north, km) =>
  sweref99tmToWgs84([east + km * 500, north + km * 500]);

/**
 * The squares of a level whose middle lies in a view (widened by a square),
 * nearest its centre first, at most `limit`, as their indices.
 * @param {{lon: Float64Array, lat: Float64Array}} centres
 * @param {number[]} bbox [west, south, east, north].
 * @param {number} km The level's square size.
 * @param {number} limit
 */
export function squaresInView({ lon, lat }, bbox, km, limit) {
  const [west, south, east, north] = bbox;
  const cy = (south + north) / 2;
  const cx = (west + east) / 2;
  const cos = Math.cos((cy * Math.PI) / 180);
  const padLat = km / 110;
  const padLon = padLat / Math.max(0.2, cos);
  const found = [];
  for (let index = 0; index < lon.length; index += 1) {
    const x = lon[index];
    const y = lat[index];
    if (
      x < west - padLon ||
      x > east + padLon ||
      y < south - padLat ||
      y > north + padLat
    )
      continue;
    found.push([index, ((x - cx) * cos) ** 2 + (y - cy) ** 2]);
  }
  found.sort((p, q) => p[1] - q[1]);
  return found.slice(0, limit).map(([index]) => index);
}

/**
 * A square as the route sends it: `[east km, north km, class]`, and for a
 * summed square its rounded people too (null under `SMALL_COUNT`). `value`
 * is the level's stored value: a 1 km square's class (all it carries), a
 * summed square's people.
 */
export function squareRow(east, north, value, km) {
  if (km === 1) {
    if (
      !Number.isInteger(value) ||
      value < 1 ||
      value >= DENSITY_CLASSES.length
    )
      throw new Error(`not a 1 km class: ${value}`);
    return [east / 1000, north / 1000, value];
  }
  const shown = roundedPeople(value);
  return [
    east / 1000,
    north / 1000,
    densityClass((shown ?? 0) / (km * km)),
    shown,
  ];
}

/** A row the route sent, read back; null when it is not one. */
export function readSquareRow(row, km) {
  if (!Array.isArray(row)) return null;
  const [eastKm, northKm, cls, people] = row;
  if (![eastKm, northKm, cls].every(Number.isInteger)) return null;
  if (cls < 0 || cls >= DENSITY_CLASSES.length) return null;
  const summed = km > 1;
  return {
    id: `${km}:${eastKm}:${northKm}`,
    km,
    east: eastKm * 1000,
    north: northKm * 1000,
    cls,
    // A 1 km square's people never reach the client.
    people: summed && Number.isFinite(people) ? people : null,
    summed,
  };
}

/** People per km² of a summed square, as its card rounds it; null when few. */
export function shownDensity({ people, km }) {
  if (!Number.isFinite(people)) return null;
  const perKm2 = people / (km * km);
  return perKm2 < 10 ? Math.round(perKm2 * 10) / 10 : Math.round(perKm2);
}

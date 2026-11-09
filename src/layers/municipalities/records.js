/**
 * Swedish municipalities (kommuner) and counties (län): pure geometry and
 * lookups shared by the snapshot build and the layer. No Cesium, no Node
 * built-ins.
 *
 * The boundaries come from OpenStreetMap (ODbL). Each boundary line is kept
 * once and shared by the areas on both sides of it, so neighbours meet
 * exactly; an area is a list of rings, each a list of signed line numbers
 * (1-based; negative runs the line backwards). Lines are delta-encoded
 * integer pairs at 1e-5 degrees, like the bundled Natural Earth packs.
 */

/** Boundary kinds, outermost first, with their colour and width. */
export const BOUNDARY_KINDS = Object.freeze(
  [
    ['county', '#ffd54f', 2.5],
    ['municipality', '#80deea', 1.2],
  ].map(([id, color, width]) => Object.freeze({ id, color, width })),
);

const SCALE = 1e5;

/** Delta-encode a line of [lon, lat] pairs. */
export function encodeLine(points) {
  const out = [];
  let x = 0;
  let y = 0;
  for (const [lon, lat] of points) {
    const nx = Math.round(lon * SCALE);
    const ny = Math.round(lat * SCALE);
    out.push(nx - x, ny - y);
    x = nx;
    y = ny;
  }
  return out;
}

/** Decode a delta-encoded line back to [lon, lat] pairs. */
export function decodeLine(encoded) {
  const out = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i + 1 < encoded.length; i += 2) {
    x += encoded[i];
    y += encoded[i + 1];
    out.push([x / SCALE, y / SCALE]);
  }
  return out;
}

/**
 * Whether a line goes anywhere: at least two points that differ. Simplifying
 * leaves a few boundary lines as one point twice; rings still walk them, but
 * there is nothing to draw.
 */
export function hasLength(points) {
  const [lon, lat] = points[0] ?? [];
  return points.some((point) => point[0] !== lon || point[1] !== lat);
}

/**
 * Douglas–Peucker in local metres, keeping both ends, so lines that meet at
 * an end still meet after simplifying.
 * @param {number[][]} points [lon, lat] pairs.
 * @param {number} toleranceM
 */
export function simplifyLine(points, toleranceM) {
  if (points.length <= 2) return points.slice();
  const lat0 = (points[0][1] * Math.PI) / 180;
  const kx = 111320 * Math.cos(lat0);
  const ky = 110540;
  const xy = points.map(([lon, lat]) => [lon * kx, lat * ky]);
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = xy[a];
    const [bx, by] = xy[b];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1;
    let at = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = xy[i];
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > toleranceM) {
      keep[at] = 1;
      stack.push([a, at], [at, b]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** The [lon, lat] ring a list of signed line numbers walks. */
export function ringPoints(ring, lines) {
  const out = [];
  for (const signed of ring) {
    const line = lines[Math.abs(signed) - 1];
    const points = signed > 0 ? line : [...line].reverse();
    out.push(...(out.length ? points.slice(1) : points));
  }
  return out;
}

/** Even–odd containment over all of an area's rings (holes included). */
export function ringsContain(rings, [lon, lat]) {
  let inside = false;
  for (const ring of rings)
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

/** [west, south, east, north] of some rings. */
export function ringsBounds(rings) {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const ring of rings)
    for (const [lon, lat] of ring) {
      if (lon < west) west = lon;
      if (lon > east) east = lon;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  return [west, south, east, north];
}

/**
 * An index of decoded areas for point lookups: each area's rings and box.
 * @param {{rings: number[][]}[]} areas
 * @param {number[][][]} lines Decoded lines.
 */
export function indexAreas(areas, lines) {
  return areas.map((area) => {
    const rings = area.rings.map((ring) => ringPoints(ring, lines));
    return { area, rings, bounds: ringsBounds(rings) };
  });
}

/** The area containing a point, from an index, or null. */
export function areaAt(index, point) {
  const [lon, lat] = point;
  for (const entry of index) {
    const [west, south, east, north] = entry.bounds;
    if (lon < west || lon > east || lat < south || lat > north) continue;
    if (ringsContain(entry.rings, point)) return entry.area;
  }
  return null;
}

/** A municipality's short name: "Västerås kommun" → "Västerås". */
export function shortMunicipalityName(name) {
  return String(name || '')
    .replace(/\s+kommun$/i, '')
    .trim();
}

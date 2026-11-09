/**
 * Sweden's power system now, from Svenska kraftnät's control room
 * (svk.se/om-kraftsystemet/kontrollrummet): the flow on every link that
 * touches a Swedish bidding zone, and the country's production per type and
 * consumption. Pure parsing shared by the server proxy and the layer. No
 * Cesium, no Node built-ins.
 *
 * A flow is reported as `FROM_TO` with a signed MW value: positive runs from
 * the first area to the second. No open map of the zone borders is used:
 * Swedish zones sit in a town well inside them (as on the price layer) and
 * each foreign end of a link at the place the interconnector lands.
 */

/** The four Swedish bidding zones. */
export const SWEDISH_AREAS = Object.freeze([
  Object.freeze({ id: 'SE1', name: 'Luleå', point: [22.15, 65.58] }),
  Object.freeze({ id: 'SE2', name: 'Sundsvall', point: [17.31, 62.39] }),
  Object.freeze({ id: 'SE3', name: 'Stockholm', point: [16.0, 59.5] }),
  Object.freeze({ id: 'SE4', name: 'Malmö', point: [13.6, 56.1] }),
]);
const SWEDISH_POINT = new Map(SWEDISH_AREAS.map((a) => [a.id, a.point]));

/**
 * Every link to or between Swedish zones, keyed as SvK names it, with the
 * place its foreign end lands.
 */
export const LINKS = Object.freeze(
  [
    ['SE1_SE2'],
    ['SE2_SE3'],
    ['SE3_SE4'],
    ['FI_SE1', 'Kemi', [24.55, 65.73]],
    ['FI_SE3', 'Rauma', [21.51, 61.13]],
    ['NO4_SE1', 'Narvik', [17.43, 68.44]],
    ['NO4_SE2', 'Mo i Rana', [14.14, 66.31]],
    ['NO3_SE2', 'Trondheim', [10.4, 63.43]],
    ['NO1_SE3', 'Oslo', [10.75, 59.91]],
    ['DK1_SE3', 'Aalborg', [9.92, 57.05]],
    ['SE4_DK2', 'København', [12.57, 55.68]],
    ['DE_SE4', 'Lübeck', [10.69, 53.87]],
    ['SE4_PL', 'Słupsk', [17.03, 54.46]],
    ['LT_SE4', 'Klaipėda', [21.13, 55.71]],
  ].map(([id, place, foreignPoint]) => {
    const [a, b] = id.split('_');
    const point = (area) => SWEDISH_POINT.get(area) || foreignPoint;
    return Object.freeze({
      id,
      a,
      b,
      aPoint: point(a),
      bPoint: point(b),
      place: place || null,
    });
  }),
);
const LINK_BY_ID = new Map(LINKS.map((link) => [link.id, link]));

export const isSwedish = (area) => SWEDISH_POINT.has(area);

/** SvK's production series ids. */
export const PRODUCTION_TYPES = Object.freeze({
  1: 'total',
  2: 'nuclear',
  3: 'hydro',
  4: 'thermal',
  5: 'wind',
  6: 'unspecified',
  7: 'consumption',
  8: 'net',
});

/** How a link's flow relates to Sweden, with its colour. */
export const FLOW_KINDS = Object.freeze([
  Object.freeze({ id: 'internal', color: '#40c4ff' }),
  Object.freeze({ id: 'import', color: '#69f0ae' }),
  Object.freeze({ id: 'export', color: '#ffab40' }),
]);
const KIND_COLOR = new Map(FLOW_KINDS.map((kind) => [kind.id, kind.color]));

export function flowColor(kind) {
  return KIND_COLOR.get(kind) || '#9e9e9e';
}

/**
 * The map/flow answer to the Swedish links, each drawn from the area that
 * sends to the one that receives, and the Swedish zones' import and export.
 * @param {object} payload
 */
export function normalizeFlows(payload) {
  const groups = Array.isArray(payload?.Data) ? payload.Data : [];
  const links = [];
  const areas = [];
  for (const group of groups) {
    for (const row of Array.isArray(group?.data) ? group.data : []) {
      const value = Number(row?.value);
      const link = LINK_BY_ID.get(String(row?.id ?? ''));
      if (link && Number.isFinite(value)) {
        const forward = value >= 0;
        const from = forward ? link.a : link.b;
        const to = forward ? link.b : link.a;
        links.push({
          id: link.id,
          from,
          to,
          fromPoint: forward ? link.aPoint : link.bPoint,
          toPoint: forward ? link.bPoint : link.aPoint,
          place: link.place,
          mw: Math.round(Math.abs(value)),
          kind:
            isSwedish(from) && isSwedish(to)
              ? 'internal'
              : isSwedish(to)
                ? 'import'
                : 'export',
        });
      }
      if (row?.id === 'SE')
        for (const area of Array.isArray(row.ElectricalAreas)
          ? row.ElectricalAreas
          : []) {
          const id = String(area?.AreaName ?? '');
          if (!isSwedish(id)) continue;
          areas.push({
            id,
            import: Math.round(Number(area.Import) || 0),
            export: Math.round(Number(area.Export) || 0),
          });
        }
    }
  }
  const updated = Number(payload?.LastUpdated);
  return {
    links: links.sort((a, b) => a.id.localeCompare(b.id)),
    areas: areas.sort((a, b) => a.id.localeCompare(b.id)),
    updated: Number.isFinite(updated) ? updated : null,
  };
}

/**
 * The production answer to the latest value of each type, in MW, and when.
 * @param {object} payload
 */
export function normalizeProduction(payload) {
  const out = { at: null };
  for (const series of Array.isArray(payload?.Data) ? payload.Data : []) {
    const type = PRODUCTION_TYPES[series?.id];
    if (!type) continue;
    let latest = null;
    for (const point of Array.isArray(series.data) ? series.data : []) {
      const x = Number(point?.x);
      if (point?.y == null || !Number.isFinite(x)) continue;
      const y = Number(point.y);
      if (Number.isFinite(y) && (!latest || x > latest.x)) latest = { x, y };
    }
    if (!latest) continue;
    out[type] = Math.round(latest.y);
    out.at = Math.max(out.at ?? 0, latest.x);
  }
  return out;
}

/**
 * The production answer as the day's quarter-hours, oldest first: each with
 * its time and MW per type (total, nuclear, hydro, thermal, wind,
 * unspecified, consumption and net, positive when Sweden exports).
 * @param {object} payload
 * @returns {Array<{at: number} & Record<string, number>>}
 */
export function normalizeProductionDay(payload) {
  const byTime = new Map();
  for (const series of Array.isArray(payload?.Data) ? payload.Data : []) {
    const type = PRODUCTION_TYPES[series?.id];
    if (!type) continue;
    for (const point of Array.isArray(series.data) ? series.data : []) {
      const at = Number(point?.x);
      if (point?.y == null || !Number.isFinite(at)) continue;
      const value = Number(point.y);
      if (!Number.isFinite(value)) continue;
      const entry = byTime.get(at) ?? { at };
      entry[type] = Math.round(value);
      byTime.set(at, entry);
    }
  }
  return [...byTime.values()].sort((a, b) => a.at - b.at);
}

/** The country of a bidding zone: "NO3" is "NO", "FI" is "FI". */
export const countryOf = (area) => String(area ?? '').slice(0, 2);

/** Whether a link touches a country, on either end. */
export const linkTouches = (link, country) =>
  countryOf(link.from) === country || countryOf(link.to) === country;

/**
 * Sweden's exchange with each neighbouring country now, from the link flows:
 * MW in, MW out and the net (positive when Sweden exports), largest first.
 * @param {ReadonlyArray<{from: string, to: string, kind: string, mw: number}>} links
 */
export function exchangeByCountry(links) {
  const byCountry = new Map();
  for (const link of links) {
    if (link.kind !== 'import' && link.kind !== 'export') continue;
    const country = countryOf(link.kind === 'import' ? link.from : link.to);
    const entry = byCountry.get(country) ?? { country, import: 0, export: 0 };
    entry[link.kind] += link.mw;
    byCountry.set(country, entry);
  }
  return [...byCountry.values()]
    .map((entry) => ({ ...entry, net: entry.export - entry.import }))
    .sort(
      (a, b) =>
        Math.abs(b.net) - Math.abs(a.net) || a.country.localeCompare(b.country),
    );
}

/** Sweden's total import, export and net (positive when exporting) now. */
export function exchangeTotals(links) {
  let imported = 0;
  let exported = 0;
  for (const link of links) {
    if (link.kind === 'import') imported += link.mw;
    else if (link.kind === 'export') exported += link.mw;
  }
  return { import: imported, export: exported, net: exported - imported };
}

/** Line width in pixels for a flow: thin at a trickle, thick at 6 GW. */
export function flowWidth(mw) {
  return Math.min(14, 3 + Math.sqrt(Math.max(0, mw)) / 7);
}

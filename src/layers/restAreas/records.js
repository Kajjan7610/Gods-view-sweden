/**
 * Trafikverket's rest areas (Sweden): pure parsing shared by the server proxy
 * and the layer. No Cesium, no Node built-ins.
 *
 * Parking (Road.Infrastructure 1.4) of Trafikverket's open API (CC0 1.0):
 * the some 320 rest areas along the state roads, with their spaces for cars
 * and lorries, their equipment (toilet, picnic tables, play area, a station
 * for emptying caravan toilets) and whether they are open. No occupancy: the
 * spaces are how many there are, not how many are free.
 */

export const MAX_AREAS = 2000;

export const OPEN_COLOR = '#66bb6a';
export const LORRY_COLOR = '#ffb300';
export const LIMITED_COLOR = '#ff7043';
export const CLOSED_COLOR = '#78909c';

/** Equipment the app names, in the order a card lists it. */
export const EQUIPMENT = Object.freeze([
  'toilet',
  'picnicFacilities',
  'playground',
  'dumpingStation',
  'refuseBin',
]);

const text = (value, max = 120) => {
  const s = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return s ? s.slice(0, max) : null;
};

/** A WKT "POINT (lon lat)" as [lon, lat], or null outside Sweden. */
export function pointOf(wkt) {
  const match = /POINT\s*Z?\s*\(\s*([-\d.]+)\s+([-\d.]+)/.exec(
    String(wkt ?? ''),
  );
  if (!match) return null;
  const lon = Number(match[1]);
  const lat = Number(match[2]);
  return lon >= 10 && lon <= 25 && lat >= 55 && lat <= 69.5 ? [lon, lat] : null;
}

/**
 * How the area stands: 'closed', 'limited' (open, partly closed),
 * 'lorry' (open with lorry spaces) or 'open'.
 */
export function areaStatus(area) {
  if (area.open === 'closed') return 'closed';
  if (area.operation === 'limitedOperation') return 'limited';
  return area.spaces.lorry > 0 ? 'lorry' : 'open';
}

export function statusColor(status) {
  return status === 'closed'
    ? CLOSED_COLOR
    : status === 'limited'
      ? LIMITED_COLOR
      : status === 'lorry'
        ? LORRY_COLOR
        : OPEN_COLOR;
}

/** Trafikverket's answer as the rest areas the layer draws. */
export function normalizeRestAreaSnapshot(response) {
  const list = response?.RESPONSE?.RESULT?.[0]?.Parking;
  if (!Array.isArray(list)) throw new Error('malformed rest area answer');
  const areas = [];
  for (const item of list) {
    if (item?.Deleted === true) continue;
    const id = text(item?.Id, 60);
    const point = pointOf(item?.Geometry?.WGS84);
    if (!id || !point) continue;
    const spaces = { car: 0, lorry: 0 };
    for (const row of Array.isArray(item?.VehicleCharacteristics)
      ? item.VehicleCharacteristics
      : []) {
      const count = Number(row?.NumberOfSpaces);
      if (row?.VehicleType in spaces && Number.isFinite(count) && count > 0)
        spaces[row.VehicleType] += count;
    }
    const kinds = new Set(
      (Array.isArray(item?.Equipment) ? item.Equipment : []).map(
        (row) => row?.Type,
      ),
    );
    const area = {
      id,
      name: text(item?.Name, 80) ?? id,
      point,
      spaces,
      equipment: EQUIPMENT.filter((kind) => kinds.has(kind)),
      accessibleToilet: (item?.Equipment ?? []).some(
        (row) =>
          row?.Type === 'toilet' &&
          row?.Accessibility === 'handicappedAccessible',
      ),
      free: item?.TariffsAndPayment?.FreeOfCharge === true ? true : null,
      open: item?.OpenStatus === 'closed' ? 'closed' : 'open',
      operation: text(item?.OperationStatus, 40),
      // Trafikverket's own note, in Swedish ("Belysning. Trantorn.").
      note: text(item?.Description, 200),
    };
    area.status = areaStatus(area);
    areas.push(area);
    if (areas.length >= MAX_AREAS) break;
  }
  return { areas };
}

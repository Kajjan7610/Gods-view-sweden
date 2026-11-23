/** Space queries: launches, satellite passes and satellites overhead. */

import { suggestView } from '../views.js';
import {
  findNextSatellitePass,
  lookAnglesAt,
} from '../../data/satellitePass.js';
import { createGpSatrecCache, parseGpCsv } from '../../sources/gp.js';
import { POINT_SCHEMA, resolvePoint } from '../area.js';
import { defineTool, ToolError } from '../catalog.js';
import { LIMIT_SCHEMA, capRows, countNoun, isoTime } from '../results.js';
import { roundHeadingDegrees } from '../../data/headingDegrees.js';

const text = (value) => (typeof value === 'string' && value ? value : null);

export const getRecentLaunches = defineTool({
  name: 'get_recent_launches',
  title: 'Recent launches',
  description:
    'Orbital launches from Launch Library 2 over the last 30 days, newest ' +
    'first, with provider, rocket, pad, mission and outcome.',
  inputSchema: {
    type: 'object',
    properties: { limit: LIMIT_SCHEMA },
    additionalProperties: false,
  },
  requires: ['launches'],
  async run(args, { services, signal }) {
    const { payload, stale } = services.launches.getLaunchSnapshot
      ? await services.launches.getLaunchSnapshot({ signal })
      : {
          payload: await services.launches.getLaunches({ signal }),
          stale: false,
        };
    const launches = Array.isArray(payload) ? payload : payload.results;
    if (!Array.isArray(launches))
      throw new ToolError('malformed', 'The launch feed returned no launches');
    const rows = launches
      .map((launch) => ({
        id: text(launch?.id),
        name: text(launch?.name),
        time: text(launch?.net),
        status: text(launch?.status?.name),
        provider: text(launch?.launch_service_provider?.name),
        rocket: text(
          launch?.rocket?.configuration?.full_name ??
            launch?.rocket?.configuration?.name,
        ),
        pad: text(launch?.pad?.name),
        location: text(launch?.pad?.location?.name),
        mission: text(launch?.mission?.name),
        orbit: text(launch?.mission?.orbit?.name),
      }))
      .filter((launch) => launch.name)
      .sort((a, b) => String(b.time).localeCompare(String(a.time)));
    const result = capRows(rows, args.limit);
    return {
      summary:
        `${countNoun(rows.length, 'launch', 'launches')} in the last 30 days${rows[0] ? `; latest ${rows[0].name}` : ''}` +
        (stale ? ' (data may be stale).' : '.'),
      data: {
        view: suggestView(services, {
          point: { lat: 20, lon: 0 },
          altitudeM: 15_000_000,
          layers: ['rocket-launches'],
        }),
        ...result,
        stale,
      },
    };
  },
});

// Groups served by the satellite catalog route; `stations` includes the ISS.
const GROUPS = [
  'stations',
  'visual',
  'gps-ops',
  'glo-ops',
  'galileo',
  'geo',
  'starlink',
];
const ISS_NORAD = 25544;
const COMPASS = [
  'N',
  'NNE',
  'NE',
  'ENE',
  'E',
  'ESE',
  'SE',
  'SSE',
  'S',
  'SSW',
  'SW',
  'WSW',
  'W',
  'WNW',
  'NW',
  'NNW',
];
const GROUP_SCHEMA = {
  type: 'string',
  enum: GROUPS,
  description: 'CelesTrak group to search (default "stations").',
};

const compass = (degrees) =>
  COMPASS[Math.round((((degrees % 360) + 360) % 360) / 22.5) % 16];
const round = (value, digits) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
const nowMs = (services) => services.clock?.now() ?? Date.now();

/** A view following a satellite from above an observer. */
function followSatellite(services, point, satellite) {
  return satellite.norad
    ? suggestView(services, {
        point,
        altitudeM: 3_000_000,
        follow: { kind: 'satellite', id: String(satellite.norad) },
      })
    : null;
}

/**
 * Swedish fork: satrecs kept per group between questions. The proxy serves
 * the same rows for 6 h, so a second question about a group builds none of
 * them again; each group keeps only the satrecs its last overhead list
 * asked for (createGpSatrecCache), and every group's go once no question
 * has come for SATRECS_IDLE_MS.
 */
export const SATRECS_IDLE_MS = 5 * 60_000;
const groupSatrecs = new Map();
let satrecsIdle = null;

/** Drop every group's satrecs (the idle timer's end, and tests). */
export function dropSatelliteSatrecs() {
  clearTimeout(satrecsIdle);
  satrecsIdle = null;
  groupSatrecs.clear();
}

/** The group's satrec cache; asking for it puts the idle drop back. */
function satrecsFor(group) {
  let satrecs = groupSatrecs.get(group);
  if (!satrecs) groupSatrecs.set(group, (satrecs = createGpSatrecCache()));
  clearTimeout(satrecsIdle);
  satrecsIdle = setTimeout(dropSatelliteSatrecs, SATRECS_IDLE_MS);
  // It never keeps a Node process (the MCP server, a test run) alive.
  satrecsIdle.unref?.();
  return satrecs;
}

/** The satrec cache a group's last questions left, for tests. */
export const _satelliteSatrecsForTest = (group) => groupSatrecs.get(group);

async function readCatalog(services, group, signal) {
  const result = await services.satellites.readGroup(group, { signal });
  if (!result.ok)
    throw new ToolError(
      'unavailable',
      `The ${group} satellite catalog is unavailable (HTTP ${result.status})`,
    );
  // CelesTrak GP data as CSV (src/sources/gp.js), every object numbered
  // 100000 and up included. A satrec is asked for when first needed
  // (satrecOf): a pass needs one, the overhead list one per satellite.
  const satrecs = satrecsFor(group);
  const entries = parseGpCsv(result.text).map((gp) => ({
    name: gp.name,
    norad: gp.noradId,
    gp,
    satrecs,
  }));
  // The proxy serves its last copy when CelesTrak is down; old orbital
  // elements make predictions drift.
  return { entries, satrecs, stale: result.stale === true };
}

/** An entry's satrec, asked once; null when SGP4 rejects its elements. */
function satrecOf(entry) {
  if (entry.satrec === undefined) entry.satrec = entry.satrecs.satrec(entry.gp);
  return entry.satrec;
}

/** The satellite asked for, of those whose elements make an orbit. */
function matchSatellite(entries, wanted) {
  const first = (matches) =>
    entries.find((entry) => matches(entry) && satrecOf(entry)) ?? null;
  if (wanted == null) return first((entry) => entry.norad === ISS_NORAD);
  const text = String(wanted).trim().toUpperCase();
  const number = /^\d+$/.test(text) ? Number(text) : null;
  return (
    first((entry) => number != null && entry.norad === number) ??
    first((entry) => entry.name.toUpperCase() === text) ??
    first((entry) => entry.name.toUpperCase().includes(text))
  );
}

export const nextSatellitePass = defineTool({
  name: 'next_satellite_pass',
  title: 'Next satellite pass',
  description:
    'When a satellite next rises over an observer, with rise, peak and set ' +
    'times, peak elevation, rise direction and naked-eye visibility. Defaults ' +
    'to the International Space Station.',
  inputSchema: {
    type: 'object',
    properties: {
      location: POINT_SCHEMA,
      satellite: {
        type: 'string',
        minLength: 1,
        maxLength: 80,
        description:
          'Satellite name or NORAD catalog number (default the ISS).',
      },
      group: GROUP_SCHEMA,
      min_elevation_deg: { type: 'number', minimum: 0, maximum: 80 },
      visible_only: {
        type: 'boolean',
        description: 'Only passes visible to the naked eye.',
      },
      hours: { type: 'number', minimum: 1, maximum: 72 },
    },
    required: ['location'],
    additionalProperties: false,
  },
  requires: ['satellites'],
  async run(args, { services, signal }) {
    const point = await resolvePoint(args.location, { services, signal });
    const group = args.group ?? 'stations';
    const { entries, stale } = await readCatalog(services, group, signal);
    const staleNote = stale ? ' (orbit data may be stale)' : '';
    const satellite = matchSatellite(entries, args.satellite);
    if (!satellite)
      throw new ToolError(
        'invalid_arguments',
        `No satellite matching "${args.satellite ?? 'ISS'}" is in the ${group} group`,
      );
    const hours = args.hours ?? 24;
    const pass = findNextSatellitePass({
      satrec: satrecOf(satellite),
      latDeg: point.lat,
      lonDeg: point.lon,
      fromMs: nowMs(services),
      minElevDeg: args.min_elevation_deg ?? 10,
      horizonHours: hours,
      requireVisible: args.visible_only === true,
    });
    const name = satellite.name;
    if (!pass)
      return {
        summary: `${name} has no ${args.visible_only ? 'visible ' : ''}pass over ${point.label} in the next ${hours} hours${staleNote}.`,
        data: {
          view: followSatellite(services, point, satellite),
          stale,
          location: point,
          satellite: name,
          norad: satellite.norad,
          pass: null,
        },
      };
    return {
      summary:
        `${name} next rises over ${point.label} at ${isoTime(pass.riseMs)} in the ${compass(pass.riseAzDeg)}, ` +
        `peaking at ${Math.round(pass.maxElevDeg)}°` +
        `${pass.visible ? '; visible to the naked eye' : ''}${staleNote}.`,
      data: {
        view: followSatellite(services, point, satellite),
        stale,
        location: point,
        satellite: name,
        norad: satellite.norad,
        pass: {
          rise: isoTime(pass.riseMs),
          peak: isoTime(pass.maxElevMs),
          set: isoTime(pass.setMs),
          max_elevation_deg: round(pass.maxElevDeg, 1),
          rise_azimuth_deg: roundHeadingDegrees(pass.riseAzDeg),
          rise_direction: compass(pass.riseAzDeg),
          visible: pass.visible,
        },
      },
    };
  },
});

export const satellitesOverhead = defineTool({
  name: 'satellites_overhead',
  title: 'Satellites overhead',
  description:
    'Satellites in a group that are above an observer right now, highest first, ' +
    'with elevation and direction.',
  inputSchema: {
    type: 'object',
    properties: {
      location: POINT_SCHEMA,
      group: GROUP_SCHEMA,
      min_elevation_deg: { type: 'number', minimum: 0, maximum: 90 },
      limit: LIMIT_SCHEMA,
    },
    required: ['location'],
    additionalProperties: false,
  },
  requires: ['satellites'],
  async run(args, { services, signal }) {
    const point = await resolvePoint(args.location, { services, signal });
    const group = args.group ?? 'stations';
    const minimum = args.min_elevation_deg ?? 10;
    const at = nowMs(services);
    const { entries, satrecs, stale } = await readCatalog(
      services,
      group,
      signal,
    );
    // Every satellite of the group is asked for: the group's cache keeps
    // just those.
    satrecs.begin();
    const rows = entries
      .flatMap((entry) => {
        const satrec = satrecOf(entry);
        const look = satrec && lookAnglesAt(satrec, at, point.lat, point.lon);
        return look && look.elevDeg >= minimum
          ? [
              {
                name: entry.name,
                norad: entry.norad,
                elevation_deg: round(look.elevDeg, 1),
                azimuth_deg: roundHeadingDegrees(look.azDeg),
                direction: compass(look.azDeg),
              },
            ]
          : [];
      })
      .sort((a, b) => b.elevation_deg - a.elevation_deg);
    satrecs.end();
    return {
      summary:
        `${countNoun(rows.length, 'satellite')} from the ${group} group ${rows.length === 1 ? 'is' : 'are'} at least ${minimum}° above ${point.label} at ${isoTime(at)}` +
        (stale ? ' (orbit data may be stale).' : '.'),
      data: {
        view: suggestView(services, {
          point,
          altitudeM: 3_000_000,
          layers: ['satellites'],
        }),
        ...capRows(rows, args.limit),
        stale,
        location: point,
        group,
        at: isoTime(at),
      },
    };
  },
});

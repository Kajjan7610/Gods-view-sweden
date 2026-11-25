// Swedish fork: how many ground cells the route-shape corridors add to a
// transit floor pass (trails.js `prepareEntry` offers them; height.js warms
// at most FLOOR_WARM_PER_POLL of them per poll), for a typical Stockholm (SL)
// bus set, against the same buses drawn in straight steps. Real trails.js and
// routeShapes.js over a stub surface and a scripted shapes route, as in
// routeShapes.test.mjs.
//
// Measured (2026-11-25), 150 buses on 30 routes, the first one selected:
//   4 reports each (a minute after the layer is on): 475 report cells,
//     535 with straight steps, 536 with route shapes (+1, 0.2 %);
//   20 reports each (five minutes on): 1,139 report cells, 1,162 straight,
//     1,162 shaped (+0).
// The shapes do not dominate, so they are not capped: the buses' own reports
// are most of the cells, and the per-poll budget (300) bounds what is asked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrails } from './trails.js';
import { initializePlayback, recordFix, updatePlayback } from './movement.js';
import { readFix, seek } from '../../data/contactPlayback.js';
import { encodeRouteShape } from '../../data/transitRouteShapes.js';
import { FLOOR_WARM_PER_POLL } from './policy.js';

const M_PER_DEG = 111_320;
const T0 = 1_000_000;
/** The layer's poll: one new report per bus each time (TRANSIT_POLL_MS). */
const POLL_MS = 15_000;
/** An inner-city bus between two polls, at about 22 km/h (m). */
const STEP_M = 90;
const BUSES = 150;
const ROUTES = 30;

/** A small deterministic generator, so every run measures the same fleet. */
function random(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Metres between two [lat, lon] corners. */
const legM = ([aLat, aLon], [bLat, bLon]) =>
  Math.hypot(
    (bLat - aLat) * M_PER_DEG,
    (bLon - aLon) * M_PER_DEG * Math.cos((aLat * Math.PI) / 180),
  );

const routeLength = (corners) =>
  corners
    .slice(1)
    .reduce((sum, corner, i) => sum + legM(corners[i], corner), 0);

/**
 * A bus route through a street grid in central Stockholm: twelve legs of
 * 250-450 m, turning at each corner, about four kilometres.
 * @returns {Array<[number, number]>} [lat, lon] corners.
 */
function streetRoute(next) {
  let lat = 59.3 + next() * 0.06;
  let lon = 17.98 + next() * 0.14;
  const corners = [[lat, lon]];
  let northSouth = next() < 0.5;
  for (let leg = 0; leg < 12; leg += 1) {
    const metres = (next() < 0.5 ? -1 : 1) * (250 + next() * 200);
    if (northSouth) lat += metres / M_PER_DEG;
    else lon += metres / (M_PER_DEG * Math.cos((lat * Math.PI) / 180));
    corners.push([lat, lon]);
    northSouth = !northSouth;
  }
  return corners;
}

/** The point `s` metres along a route. */
function along(corners, s) {
  for (let i = 1; i < corners.length; i += 1) {
    const length = legM(corners[i - 1], corners[i]);
    if (s <= length || i === corners.length - 1) {
      const f = Math.min(1, s / length);
      return {
        lat: corners[i - 1][0] + (corners[i][0] - corners[i - 1][0]) * f,
        lon: corners[i - 1][1] + (corners[i][1] - corners[i - 1][1]) * f,
      };
    }
    s -= length;
  }
  return null;
}

/** Let the batched shapes request and its answer run. */
async function settle() {
  for (let i = 0; i < 12; i += 1) await new Promise((r) => setImmediate(r));
}

/** A scripted `/api/transit/shapes` answering `shapes` by id. */
function shapesRoute(shapes) {
  return async (url) => {
    const asked = new URL(url, 'http://localhost');
    const ids = asked.searchParams.get('ids').split(',');
    const body = {
      version: 1,
      feedId: asked.searchParams.get('feed'),
      staticAt: 1,
      shapes: Object.fromEntries(
        ids.filter((id) => shapes[id]).map((id) => [id, shapes[id]]),
      ),
      missing: ids.filter((id) => !shapes[id]),
      deferred: [],
    };
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
}

/** The state, services and parts trails.js reads; every cell is cold. */
function layer() {
  const state = {
    _enabled: true,
    _visible: new Set(),
    _vehicles: new Map(),
    _selectedKey: null,
    _cockpitSubjectKey: null,
    _heightDirty: new Set(),
    _viewer: null,
    _activeFeeds: new Map(),
    _feedStatus: new Map(),
  };
  const services = { render: { governorRequestRender() {} } };
  const parts = {
    height: {
      requestHeight: (lat, lon) => ({
        cell: `${lat.toFixed(3)},${lon.toFixed(3)}`,
        height: null,
        prior: null,
      }),
      nearGround: () => true,
    },
    rendering: { cameraHeightM: () => 800, sampleIdle() {} },
  };
  parts.trails = createTrails({ state, services, parts, source: null });
  return { state, parts };
}

/**
 * The SL fleet: BUSES buses on ROUTES routes, each with `reports` reports one
 * poll apart along its route with a few metres of GPS scatter, drawn a poll
 * and a bit behind its newest report, as the playback delay holds it.
 */
function fleet(ctx, routes, reports) {
  const next = random(7);
  const entries = [];
  for (let i = 0; i < BUSES; i += 1) {
    const r = i % routes.length;
    const corners = routes[r];
    const start = next() * (routeLength(corners) - STEP_M * reports - 50);
    const trip = `T${i}`;
    const key = `trafiklab-sl:${9031005000000000 + i}`;
    const entry = {
      key,
      feedId: 'trafiklab-sl',
      mode: 'bus',
      modeInferred: false,
      courseDeg: null,
      record: {
        id: key.split(':')[1],
        tripId: trip,
        shapeId: `S${r}`,
        routeId: `bus:${r}`,
      },
    };
    initializePlayback(entry);
    for (let k = 0; k < reports; k += 1) {
      const at = along(corners, start + STEP_M * k);
      const t = T0 + POLL_MS * k;
      const fix = {
        t,
        lat: at.lat + ((next() - 0.5) * 6) / M_PER_DEG,
        lon: at.lon + ((next() - 0.5) * 6) / (M_PER_DEG * 0.51),
      };
      recordFix(entry, fix, {
        receivedAt: t + 1000,
        wallNowMs: t + 1000,
        monoNowMs: 0,
        context: { trip, route: `bus:${r}`, mode: 'bus' },
      });
    }
    const displayT = T0 + POLL_MS * (reports - 1) - 20_000;
    entry.clocks.wallNowMs = displayT + 30_000;
    entry.clocks.monoNowMs = 0;
    seek(entry.track, displayT, entry.clocks);
    updatePlayback(entry, displayT + 30_000, 0);
    ctx.state._vehicles.set(key, entry);
    ctx.state._visible.add(entry);
    entries.push(entry);
  }
  return entries;
}

/**
 * The distinct cells one floor pass offers (height.js `rereadFloors` calls
 * `prepareEntry` with a collector per vehicle in view), with the first bus
 * selected; the cells of the reports alone; and the buses drawn along a shape.
 */
async function measure(t, { shaped, reports }) {
  const next = random(11);
  const routes = Array.from({ length: ROUTES }, () => streetRoute(next));
  const shapes = Object.fromEntries(
    routes.map((corners, r) => [`S${r}`, encodeRouteShape(corners.flat())]),
  );
  t.mock.method(globalThis, 'fetch', shapesRoute(shaped ? shapes : {}));
  const ctx = layer();
  const entries = fleet(ctx, routes, reports);
  ctx.state._selectedKey = entries[0].key;
  // The first pass asks for the shapes; arriving shapes prepare them again.
  for (const entry of entries) ctx.parts.trails.prepareEntry(entry);
  await settle();
  const cells = new Set();
  const reportCells = new Set();
  const fix = {};
  let alongShapes = 0;
  for (const entry of entries) {
    ctx.parts.trails.prepareEntry(entry, (point, answer) =>
      cells.add(answer.cell),
    );
    if (entry.routeShaped) alongShapes += 1;
    for (let i = 0; i < entry.track.count; i += 1) {
      readFix(entry.track, i, fix);
      reportCells.add(`${fix.lat.toFixed(3)},${fix.lon.toFixed(3)}`);
    }
  }
  ctx.parts.trails.clear();
  return { cells: cells.size, reportCells: reportCells.size, alongShapes };
}

for (const reports of [4, 20]) {
  test(`route shapes add few cells to a floor pass: ${BUSES} SL buses, ${reports} reports each`, async (t) => {
    const straight = await measure(t, { shaped: false, reports });
    const shaped = await measure(t, { shaped: true, reports });
    t.diagnostic(
      JSON.stringify({
        buses: BUSES,
        reports,
        reportCells: shaped.reportCells,
        straightCells: straight.cells,
        shapedCells: shaped.cells,
        shapesAdd: shaped.cells - straight.cells,
        perPollBudget: FLOOR_WARM_PER_POLL,
      }),
    );
    assert.equal(straight.alongShapes, 0, 'without shapes, straight steps');
    assert.equal(shaped.alongShapes, BUSES, 'every bus follows its shape');
    assert.equal(straight.reportCells, shaped.reportCells, 'the same fleet');
    // The measurement behind leaving the shaped corridors uncapped: they add
    // a few per cent of a pass's cells at most, and corridors of either kind
    // fewer cells than the buses' own reports.
    assert.ok(
      shaped.cells - straight.cells <= 0.05 * straight.cells,
      `route shapes added ${shaped.cells - straight.cells} of ${straight.cells} cells`,
    );
    assert.ok(shaped.cells - shaped.reportCells < shaped.reportCells);
  });
}

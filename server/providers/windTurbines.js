import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  WIND_MAX_SPAN_DEG,
  WIND_SHOWN,
  compactTurbine,
  parseKinds,
  turbinesInView,
  unpackTurbines,
} from '../../src/layers/windTurbines/records.js';

// Länsstyrelserna's Vindbrukskollen (CC0 1.0, "Ange Länsstyrelsen som
// källa"), built by scripts/build-wind-turbines.mjs from the county boards'
// shapefile export. The app never asks the county boards: the route serves
// the turbines in a view from the bundled file, read once, the nearest to the
// view's centre first, of the kinds the layer shows, each in a few short
// fields; a clicked turbine's card fields come from /api/wind-turbines/turbine.
export const WIND_TURBINES_FILE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../src/data/local_data/se_wind_turbines/wind-turbines.json',
);
const MAX_LIMIT = 2000;

const numbers = (value, count) => {
  const parts = String(value ?? '')
    .split(',')
    .map(Number);
  return parts.length === count && parts.every(Number.isFinite) ? parts : null;
};
const onEarth = (lon, lat) => Math.abs(lon) <= 180 && Math.abs(lat) <= 90;
const dateMs = (value) => {
  const ms = Date.parse(value ?? '');
  return Number.isFinite(ms) ? ms : null;
};

/** Route serving the wind turbines in a view for dev and preview. */
export function windTurbinesProxy({
  read = (file) => readFile(file, 'utf8'),
} = {}) {
  let snapshot = null;

  function load() {
    snapshot ??= (async () => {
      const file = JSON.parse(await read(WIND_TURBINES_FILE));
      const rows = unpackTurbines(file);
      const value = {
        // The county boards' export date, else the build's.
        snapshotAt: dateMs(file?.exported) ?? dateMs(file?.built),
        updated: typeof file?.updated === 'string' ? file.updated : null,
        rows,
        byId: new Map(rows.map((row) => [row.id, row])),
      };
      console.log(`[wind-turbines] ${value.rows.length} turbines`);
      return value;
    })().catch((error) => {
      // A failed read is tried again by the next view.
      snapshot = null;
      throw error;
    });
    return snapshot;
  }

  async function handler(req, res) {
    const json = (status, value) => {
      if (res.destroyed) return;
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      });
      res.end(JSON.stringify(value));
    };
    if (req.method !== 'GET') return json(405, { error: 'method_not_allowed' });
    const [pathname, search = ''] = (req.url || '/').split('?');
    const params = new URLSearchParams(search);
    if (pathname === '/turbine') return detail(params, json);
    if (pathname !== '/' && pathname !== '')
      return json(404, { error: 'unknown_route' });
    const bbox = numbers(params.get('bbox'), 4);
    const center = numbers(params.get('center'), 2);
    if (
      !bbox ||
      !center ||
      bbox[0] >= bbox[2] ||
      bbox[1] >= bbox[3] ||
      !onEarth(bbox[0], bbox[1]) ||
      !onEarth(bbox[2], bbox[3]) ||
      !onEarth(...center)
    )
      return json(400, { error: 'bbox_and_center_required' });
    // The layer cuts its box to the span at 1e-4 degrees; the sliver allows
    // for the subtraction's own rounding.
    const widest = WIND_MAX_SPAN_DEG + 1e-9;
    if (bbox[2] - bbox[0] > widest || bbox[3] - bbox[1] > widest)
      return json(200, { tooWide: true, turbines: [], counts: {} });
    let value;
    try {
      value = await load();
    } catch (error) {
      console.warn(`[wind-turbines] unavailable: ${error?.message || error}`);
      return json(502, { error: 'wind_turbines_unavailable' });
    }
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Number(params.get('limit')) || WIND_SHOWN),
    );
    const view = turbinesInView(value.rows, {
      bbox,
      center,
      limit,
      kinds: parseKinds(params.get('kinds')),
    });
    return json(200, {
      tooWide: false,
      capped: view.total > view.turbines.length,
      fetchedAt: value.snapshotAt,
      updated: value.updated,
      stale: false,
      total: view.total,
      builtMW: view.builtMW,
      builtPowerUnknown: view.builtPowerUnknown,
      counts: view.counts,
      turbines: view.turbines.map(compactTurbine),
    });
  }

  /** One turbine's full row, for its card. */
  async function detail(params, json) {
    const id = String(params.get('id') ?? '');
    if (!/^[\w-]{1,32}$/.test(id)) return json(400, { error: 'id_required' });
    let value;
    try {
      value = await load();
    } catch (error) {
      console.warn(`[wind-turbines] unavailable: ${error?.message || error}`);
      return json(502, { error: 'wind_turbines_unavailable' });
    }
    const row = value.byId.get(id);
    if (!row) return json(404, { error: 'unknown_turbine' });
    return json(200, { turbine: row, fetchedAt: value.snapshotAt });
  }

  return {
    name: 'wind-turbines',
    configureServer({ middlewares }) {
      middlewares.use('/api/wind-turbines', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/wind-turbines', handler);
    },
  };
}

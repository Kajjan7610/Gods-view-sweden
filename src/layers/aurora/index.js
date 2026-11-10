import * as Cesium from 'cesium';
import { formatNumber, msg, t } from '../../i18n/index.js';
import { measuredWhen } from '../measuredWhen.js';
import { redrawEntities } from '../redrawEntities.js';
import {
  AURORA_SOUTH,
  AURORA_TOWNS,
  auroraColor,
  auroraOutdated,
  chanceAt,
} from './records.js';
export * from './records.js';
export { createAuroraSource } from './source.js';

/** The oval floats at the height auroras glow, so no terrain or tiles clip it. */
const AURORA_HEIGHT_M = 110_000;

/** Each one-degree cell becomes this many pixels a side before smoothing. */
const SMOOTH_SCALE = 6;

/** RGBA for a chance; transparent below 3 %. */
function rgba(chance) {
  const css = auroraColor(chance);
  if (!css) return [0, 0, 0, 0];
  const color = Cesium.Color.fromCssColorString(css);
  // Faint at the oval's edge, strong at its heart.
  const alpha = Math.min(0.75, 0.04 + chance / 55);
  return [color.red * 255, color.green * 255, color.blue * 255, alpha * 255];
}

/** The northern band as a canvas: x is longitude -180..179, y is 90 N down. */
function paint(rows) {
  const height = rows.length;
  const canvas = document.createElement('canvas');
  canvas.width = 360;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  const image = ctx.createImageData(360, height);
  for (let y = 0; y < height; y++) {
    const row = rows[height - 1 - y];
    for (let x = 0; x < 360; x++) {
      const [r, g, b, a] = rgba(row[(x - 180 + 360) % 360]);
      const i = (y * 360 + x) * 4;
      image.data[i] = r;
      image.data[i + 1] = g;
      image.data[i + 2] = b;
      image.data[i + 3] = a;
    }
  }
  ctx.putImageData(image, 0, 0);
  // Upscaled with smoothing, so the one-degree cells read as a glow.
  const smooth = document.createElement('canvas');
  smooth.width = 360 * SMOOTH_SCALE;
  smooth.height = height * SMOOTH_SCALE;
  const smoothCtx = smooth.getContext('2d');
  smoothCtx.imageSmoothingEnabled = true;
  smoothCtx.imageSmoothingQuality = 'high';
  smoothCtx.drawImage(canvas, 0, 0, smooth.width, smooth.height);
  return smooth;
}

/**
 * Own one aurora display: NOAA's OVATION chance of aurora overhead as a
 * glowing band at aurora height over the northern hemisphere, with the
 * Kp index and the chance over Swedish towns in the layer row. Share links
 * carry it as token 0t.
 */
export function createAuroraLayer({ source, now = () => Date.now() } = {}) {
  if (typeof source?.getSnapshot !== 'function')
    throw new TypeError('Aurora requires a snapshot source');
  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _enabled = false;
  let _rowListener = null;
  let _lastUpdate = null;
  let _lastError = null;
  let _stale = false;
  let _snapshot = null;
  /** The time of the grid last drawn; undefined before one is. */
  let _drawn;

  function render() {
    if (!_dataSource) return;
    const entities = _dataSource.entities;
    redrawEntities(entities, () => {
      if (_snapshot?.rows?.length) {
        entities.add({
          id: 'aurora-oval',
          rectangle: {
            coordinates: Cesium.Rectangle.fromDegrees(
              -180,
              AURORA_SOUTH,
              180,
              90,
            ),
            height: AURORA_HEIGHT_M,
            material: new Cesium.ImageMaterialProperty({
              image: paint(_snapshot.rows),
              transparent: true,
            }),
          },
        });
      }
    });
    _viewer?.scene?.requestRender?.();
  }

  const layer = {
    id: 'aurora',
    name: 'Aurora Forecast',
    icon: '🌌',
    source: 'NOAA SWPC',
    updateInterval: 600000,

    init(viewer) {
      if (_viewer) throw new Error('Aurora layer is already initialized');
      _viewer = viewer;
      _dataSource = new Cesium.CustomDataSource('aurora');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);
    },

    enable() {
      _enabled = true;
      if (_dataSource) _dataSource.show = true;
    },

    disable() {
      _request?.abort();
      _request = null;
      _enabled = false;
      _lastError = null;
      if (_dataSource) _dataSource.show = false;
    },

    async update() {
      if (!_enabled || !_dataSource) return false;
      _request?.abort();
      const request = new AbortController();
      _request = request;
      try {
        const snapshot = await source.getSnapshot({ signal: request.signal });
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        // Stale by the proxy's word, or because the forecast is for a time
        // long past: NOAA still answering with a file it stopped renewing.
        _stale = snapshot.stale || auroraOutdated(snapshot, now());
        _lastUpdate =
          snapshot.stale && Number.isFinite(snapshot.fetchedAt)
            ? snapshot.fetchedAt
            : now();
        _lastError = null;
        // The time names the grid; a grid without any is drawn every time.
        const signature = snapshot.forecast ?? snapshot.observed ?? null;
        // The newest snapshot always: the row reads Kp and the towns from it.
        _snapshot = snapshot;
        if (signature === null || signature !== _drawn) {
          // Not trusted until drawn: a drawing that fails is made again.
          _drawn = undefined;
          try {
            render();
          } catch (e) {
            console.warn('[Data:Aurora] Draw error:', e?.message || e);
            _lastError = e?.message || msg('Aurora forecast unavailable');
            _rowListener?.();
            return true;
          }
          _drawn = signature;
          console.log(
            `[Data:Aurora] Updated: forecast ${new Date(snapshot.forecast ?? now()).toISOString()}, Kp ${snapshot.kp?.kp ?? '?'}`,
          );
        }
        _rowListener?.();
        return true;
      } catch (e) {
        if (request.signal.aborted || _request !== request || !_enabled)
          return false;
        console.warn('[Data:Aurora] Fetch error:', e?.message || e);
        _lastError = e?.message || msg('Aurora forecast unavailable');
        _stale = false;
        _rowListener?.();
        return true;
      } finally {
        if (_request === request) _request = null;
      }
    },

    destroy(viewer = _viewer) {
      layer.disable();
      _snapshot = null;
      _drawn = undefined;
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }
      _viewer = null;
      _lastUpdate = null;
      _lastError = null;
      _stale = false;
    },

    setRowControlsListener(listener) {
      _rowListener = typeof listener === 'function' ? listener : null;
    },

    getRowControls() {
      const legend = [];
      // When the forecast is for: the date too once it is not today's.
      const forecast = _snapshot?.forecast ?? _snapshot?.observed;
      if (Number.isFinite(forecast))
        legend.push({
          label: t('Forecast for {time}', {
            time: measuredWhen(forecast, now()),
          }),
          color: _stale ? '#546e7a' : '#00e676',
          count: null,
        });
      const kp = _snapshot?.kp?.kp;
      if (Number.isFinite(kp)) {
        const value = formatNumber(kp, { maximumFractionDigits: 1 });
        const at = _snapshot.kp.at;
        legend.push({
          // Kp is a three-hour value: the row says which hours it is from.
          label: Number.isFinite(at)
            ? t('Kp index {kp} from {time} (0 calm, 9 extreme storm)', {
                kp: value,
                time: measuredWhen(at, now()),
              })
            : t('Kp index {kp} (0 calm, 9 extreme storm)', { kp: value }),
          color: kp >= 5 ? '#ff1744' : kp >= 4 ? '#ffd600' : '#00e676',
          count: null,
        });
      }
      for (const town of AURORA_TOWNS) {
        const chance = _snapshot ? chanceAt(_snapshot, town.point) : null;
        if (chance == null) continue;
        legend.push({
          label: t('{town} {chance} %', { town: town.name, chance }),
          color: auroraColor(chance) || '#546e7a',
          count: null,
        });
      }
      return {
        chips: [],
        legend: legend.map((item, index) =>
          index === 0
            ? {
                ...item,
                blurb: t(
                  'The glowing band is NOAA’s OVATION chance of aurora overhead in the next half hour, drawn at aurora height. You need a dark, clear sky; aurora is often seen low in the north from well south of the band.',
                ),
              }
            : item,
        ),
      };
    },

    getStats() {
      return {
        count: _snapshot ? 1 : 0,
        kp: _snapshot?.kp?.kp ?? null,
        lastUpdate: _lastUpdate,
        error: _lastError,
        stale: _stale,
      };
    },
  };
  return layer;
}

/**
 * The city dossier's sights on the map (Swedish fork): while the SIGHTS tab
 * is open, each sight is a dot coloured by kind with its name above it
 * (world-overlay labels), the chosen one gold and larger. A click on a dot
 * or a name picks that sight.
 */
import { fromDegrees } from '../geo/ellipsoid.js';
import { drawOf, findFrame } from '../render/rendererOf.js';
import { inputFor } from '../input/dispatcher.js';
import {
  registerPickOwner,
  resolvePickId,
  unregisterPickOwner,
} from '../data/pickRegistry.js';

export const CITY_SIGHTS_ID = 'city-sights';
const PICK_PREFIX = 'city-sight:';
const LABEL_SOURCE_ID = 'city-sight-labels';
const LABEL_HOST_OPTIONS = Object.freeze({
  cohortLimit: 60,
  collisionCapacity: 24,
  moving: false,
});
/** One colour per kind, the chosen sight always gold. */
export const SIGHT_COLORS = Object.freeze({
  castle: '#ce93d8',
  fortress: '#b39ddb',
  church: '#90caf9',
  museum: '#80deea',
  runestone: '#ffab91',
  ancient: '#ffcc80',
  manor: '#f48fb1',
  monument: '#e6ee9c',
  nature: '#a5d6a7',
  lighthouse: '#fff59d',
});
const CHOSEN = '#ffc94d';
const OUTLINE_COLOR = '#04101a';
const SIGHT_HEIGHT_M = 30;

/**
 * Own the sight markers for one scene object (`viewer`).
 * @param {{ onPick: (id: string) => void }} options
 */
export function createSightsLayer({
  viewer: host,
  overlayHost,
  onPick,
  // The clicks on the globe: the application's input dispatcher.
  input = (forHost) => inputFor(forHost),
}) {
  const dots = drawOf(host).points({ id: CITY_SIGHTS_ID });
  let shown = false;
  const requestRender = () => findFrame(host)?.requestRender(CITY_SIGHTS_ID);

  /** Draw `sights` with `chosen` marked, or clear with an empty list. */
  function show(sights, chosen = null) {
    shown = sights.length > 0;
    const items = [];
    const entries = [];
    for (const sight of sights) {
      const picked = sight.id === chosen;
      const color = picked ? CHOSEN : (SIGHT_COLORS[sight.kind] ?? '#ffffff');
      const id = `${PICK_PREFIX}${sight.id}`;
      items.push({
        id,
        pos: { lon: sight.lon, lat: sight.lat, height: SIGHT_HEIGHT_M },
        pixelSize: picked ? 13 : 8,
        color,
        outlineColor: OUTLINE_COLOR,
        outlineWidth: 2,
        disableDepthTest: Number.POSITIVE_INFINITY,
      });
      entries.push({
        id,
        position: fromDegrees(sight.lon, sight.lat, SIGHT_HEIGHT_M),
        variant: 'label',
        title: sight.name,
        accent: color,
        // The chosen one always shows; the rest in their list order.
        priority: picked ? 1000 : 100 - (sight.rank ?? 0),
        collisionGroup: 'ambient-label',
        paintLane: 'ambient-label',
        interactive: true,
        edgeFade: 'keyhole',
        horizonCull: true,
        terrainOcclusion: false,
        gapPx: 6,
        verticalOnly: true,
        placement: 'above',
      });
    }
    dots.set(items);
    overlayHost?.setEntries(LABEL_SOURCE_ID, entries, LABEL_HOST_OPTIONS);
    overlayHost?.setVisible?.(LABEL_SOURCE_ID, shown);
    requestRender();
  }

  registerPickOwner(
    CITY_SIGHTS_ID,
    (pickedId) =>
      typeof pickedId === 'string' && pickedId.startsWith(PICK_PREFIX),
  );
  // A scene with no renderer input bound takes no clicks.
  let clicks = null;
  try {
    clicks = input(host) ?? null;
  } catch {
    clicks = null;
  }
  const removeClick = clicks?.onClick((click) => {
    if (!shown) return;
    const at = click.screenPosition;
    const label = overlayHost?.hitTest?.(at?.x, at?.y, {
      sourceId: LABEL_SOURCE_ID,
    });
    const id = String(label?.entryId ?? resolvePickId(click.topHit) ?? '');
    if (id.startsWith(PICK_PREFIX)) onPick(id.slice(PICK_PREFIX.length));
  });

  return {
    show,
    hide: () => show([]),
    destroy() {
      removeClick?.();
      unregisterPickOwner(CITY_SIGHTS_ID);
      overlayHost?.clearSource?.(LABEL_SOURCE_ID);
      dots.dispose();
      requestRender();
    },
  };
}

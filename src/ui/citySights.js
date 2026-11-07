/**
 * The city dossier's sights on the map (Swedish fork): while the SIGHTS tab
 * is open, each sight is a dot coloured by kind with its name above it
 * (world-overlay labels), the chosen one gold and larger. A click on a dot
 * or a name picks that sight.
 */
import * as Cesium from 'cesium';

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

/**
 * Own the sight markers for one viewer.
 * @param {{ onPick: (id: string) => void }} options
 */
export function createSightsLayer({ viewer, overlayHost, onPick }) {
  const source = new Cesium.CustomDataSource('city-sights');
  void viewer.dataSources.add(source);
  let shown = false;

  /** Draw `sights` with `chosen` marked, or clear with an empty list. */
  function show(sights, chosen = null) {
    shown = sights.length > 0;
    source.entities.removeAll();
    const entries = [];
    for (const sight of sights) {
      const picked = sight.id === chosen;
      const color = picked ? CHOSEN : (SIGHT_COLORS[sight.kind] ?? '#ffffff');
      const id = `${PICK_PREFIX}${sight.id}`;
      const position = Cesium.Cartesian3.fromDegrees(sight.lon, sight.lat, 30);
      source.entities.add({
        id,
        position,
        point: {
          pixelSize: picked ? 13 : 8,
          color: Cesium.Color.fromCssColorString(color),
          outlineColor: Cesium.Color.fromCssColorString('#04101a'),
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
        },
      });
      entries.push({
        id,
        position,
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
    overlayHost?.setEntries(LABEL_SOURCE_ID, entries, LABEL_HOST_OPTIONS);
    overlayHost?.setVisible?.(LABEL_SOURCE_ID, shown);
    viewer.scene.requestRender?.();
  }

  const clicks = new Cesium.ScreenSpaceEventHandler(viewer.scene.canvas);
  clicks.setInputAction((click) => {
    if (!shown) return;
    const label = overlayHost?.hitTest?.(click.position?.x, click.position?.y, {
      sourceId: LABEL_SOURCE_ID,
    });
    const id = String(
      label?.entryId ?? viewer.scene.pick(click.position)?.id?.id ?? '',
    );
    if (id.startsWith(PICK_PREFIX)) onPick(id.slice(PICK_PREFIX.length));
  }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

  return {
    show,
    hide: () => show([]),
    destroy() {
      clicks.destroy();
      overlayHost?.clearSource?.(LABEL_SOURCE_ID);
      viewer.dataSources.remove(source, true);
    },
  };
}

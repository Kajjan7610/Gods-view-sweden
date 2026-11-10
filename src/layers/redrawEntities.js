/**
 * Replace everything a layer drew in an entity collection.
 *
 * The old entities are removed before events are suspended, not inside the
 * suspension. Within one suspension Cesium cancels a removal against an
 * addition under the same id and reports neither, so a redraw that keeps its
 * ids (new heights, a new colour) would leave the visualizers drawing the old
 * entities. Removing first reports the removal at once and the additions as
 * one event when `draw` is done.
 * @param {import('cesium').EntityCollection} entities
 * @param {(entities: import('cesium').EntityCollection) => void} draw Adds
 *   the new entities.
 */
export function redrawEntities(entities, draw) {
  entities.removeAll();
  entities.suspendEvents();
  try {
    draw(entities);
  } finally {
    entities.resumeEvents();
  }
}

/**
 * Move entities a layer already drew to new positions, in place.
 *
 * Ground heights arrive a request at a time, for a few rows each. Drawing
 * the whole layer again for every answer would rebuild thousands of dots to
 * move sixty; setting `position` on the entity that is already there moves
 * just that dot, and the visualizers read the new position on their next
 * update. One suspension reports the lot as a single change.
 * @param {import('cesium').EntityCollection} entities
 * @param {Iterable<string>} ids Row ids whose position changed.
 * @param {(id: string) => string} entityId The entity a row was drawn as.
 * @param {(id: string) => import('cesium').Cartesian3 | null | undefined}
 *   positionOf The row's new position; nothing for a row no longer shown.
 * @returns {number} How many entities moved.
 */
export function liftEntities(entities, ids, entityId, positionOf) {
  let moved = 0;
  entities.suspendEvents();
  try {
    for (const id of ids) {
      const entity = entities.getById(entityId(id));
      if (!entity) continue;
      const next = positionOf(id);
      if (!next) continue;
      entity.position = next;
      moved += 1;
    }
  } finally {
    entities.resumeEvents();
  }
  return moved;
}

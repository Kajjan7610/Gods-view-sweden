import { createMilitaryRegistry } from '../layers/aircraft/classification.js';
import { createEmptyMilitarySource } from '../sources/live/standalone.js';

// Swedish fork: military aircraft are not offered, so no flight is tinted.
const registry = createMilitaryRegistry({
  source: createEmptyMilitarySource(),
});
export const isMilitaryLayerActive = registry.isMilitaryLayerActive;
export const setMilitaryLayerActive = registry.setMilitaryLayerActive;
export const onMilitaryLayerActiveChange = registry.onMilitaryLayerActiveChange;
export const registerMilitaryIcaos = registry.registerMilitaryIcaos;
export const isMilitaryIcao = registry.isMilitaryIcao;
export const refreshMilitaryRegistryIfStale =
  registry.refreshMilitaryRegistryIfStale;

/** Configure classification from the same source used by the aircraft layer. */
export const configureMilitaryRegistrySource = registry.configureSource;

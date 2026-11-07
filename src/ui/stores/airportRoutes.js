import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * Today's routes on the globe as the map chip renders them: the airport and
 * its count, or null (src/ui/airportRoutes.js), answered through act().
 */
export const useAirportRoutesStore = defineStore('gev-airport-routes', () => {
  const view = shallowRef(null);
  let actions = null;

  /** @param {?object} next */
  function publish(next) {
    view.value = next && markRaw(next);
  }

  /**
   * @param {Record<string, Function>} next The owner's actions.
   * @returns {() => void} Disconnect.
   */
  function connect(next) {
    actions = next;
    return () => {
      if (actions === next) actions = null;
    };
  }

  function act(name, ...args) {
    return actions?.[name]?.(...args);
  }

  return { view, publish, connect, act };
});

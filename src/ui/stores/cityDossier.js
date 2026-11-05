import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The city dossier as its panel renders it. The dossier controller presents
 * the town the view is visiting — facts, population, society and what is
 * happening now — and answers the panel's tabs and buttons through act().
 */
export const useCityDossierStore = defineStore('gev-city-dossier', () => {
  /** The presented dossier; null until the view first visits a town. */
  const view = shallowRef(null);
  let actions = null;

  /** @param {?object} next A fresh presentation of the dossier. */
  function publish(next) {
    view.value = next && markRaw(next);
  }

  /**
   * @param {Record<string, Function>} next The controller's actions.
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

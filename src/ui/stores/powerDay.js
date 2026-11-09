import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The power day as its panel renders it. The power grid layer presents the
 * day's production by type, consumption and exchange while it is on, and
 * answers the panel's day choice through act().
 */
export const usePowerDayStore = defineStore('gev-power-day', () => {
  /** The presented day; null while the power grid layer is off. */
  const view = shallowRef(null);
  let actions = null;

  /** @param {?object} next A fresh presentation of the day. */
  function publish(next) {
    view.value = next && markRaw(next);
  }

  /**
   * @param {Record<string, Function>} next The layer's actions.
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

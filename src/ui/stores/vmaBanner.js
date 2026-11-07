import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The public alert banner's rows (src/ui/vmaBanner.js), answered through
 * act().
 */
export const useVmaBannerStore = defineStore('gev-vma-banner', () => {
  const rows = shallowRef([]);
  let actions = null;

  /** @param {object[]} next */
  function publish(next) {
    rows.value = markRaw(next ?? []);
  }

  /**
   * @param {Record<string, Function>} next The banner's actions.
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

  return { rows, publish, connect, act };
});

import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The cockpit's Swedavia card as it renders: the flown aircraft's departure
 * and arrival rows today, or null (src/ui/cockpitFlightLeg.js).
 */
export const useCockpitFlightLegStore = defineStore(
  'gev-cockpit-flight-leg',
  () => {
    const view = shallowRef(null);

    /** @param {?object} next */
    function publish(next) {
      view.value = next && markRaw(next);
    }

    return { view, publish };
  },
);

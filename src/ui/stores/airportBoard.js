import { defineStore } from 'pinia';
import { markRaw, shallowRef } from 'vue';

/**
 * The airport board as its panel renders it: the card offered over a
 * Swedavia airport and the open board, if any. The board controller
 * (src/ui/airportBoard.js) answers the panel through act().
 */
export const useAirportBoardStore = defineStore('gev-airport-board', () => {
  /** `{ card, board }`; both null until an airport is near or opened. */
  const view = shallowRef({ card: null, board: null });
  let actions = null;

  /** @param {{ card: ?object, board: ?object }} next */
  function publish(next) {
    view.value = markRaw(next ?? { card: null, board: null });
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

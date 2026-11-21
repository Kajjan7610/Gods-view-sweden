/**
 * The historical photos' time-lapse (▶ PLAY): every year in black and
 * white, 1960, 1975 and 1993…2005, then today's map. Each step holds a
 * year and preloads only the next one, above it at alpha 0; once enough of
 * the next year's tiles have loaded (or TIMELAPSE_READY_CAP_MS has passed)
 * it fades in over TIMELAPSE_FADE_MS. The last step fades the photos out
 * so today's map shows, and playback ends there. No more than two photo
 * layers are ever asked for (the shown year and the next). Nothing runs
 * during a hold but its timers; a fade ticks at about 30 a second and asks
 * for one frame each tick, and with reduced motion it cuts instead.
 *
 * Each step has its own place in the draw order (`order`, rising with the
 * step), so the incoming year always draws above the outgoing one.
 *
 * Pure: no renderer, no DOM. Its owner turns the stage into imagery layers
 * (`onStage`) and frames (`onFrame`), and reports the preload's loaded
 * tiles (`tileLoaded`, with the preload's `token`) and the tile requests
 * going idle (`idle`).
 */
import { HISTORICAL_ORTHO_CATALOGUE } from './model.js';

/** One crossfade, in milliseconds. */
export const TIMELAPSE_FADE_MS = 800;
/** How long each year holds before the next fades in. */
export const TIMELAPSE_HOLD_MS = 1800;
/** The longest wait for the next year's tiles before fading anyway. */
export const TIMELAPSE_READY_CAP_MS = 4000;
/** A fade's tick, about 30 a second. */
export const TIMELAPSE_FRAME_MS = 33;
/** Tiles of the next year loaded before it may fade in. */
export const TIMELAPSE_READY_TILES = 4;

/**
 * The steps, in order: each year's black-and-white photo, then today.
 * @type {ReadonlyArray<{year: number, layerId: string, maxLevel: number, reference: boolean, order: number} | {today: true}>}
 */
export const TIMELAPSE_STEPS = Object.freeze([
  ...HISTORICAL_ORTHO_CATALOGUE.map((entry, order) =>
    Object.freeze({
      year: entry.year,
      layerId: entry.variants.bw.layerId,
      maxLevel: entry.variants.bw.maxLevel,
      reference: entry.reference,
      order,
    }),
  ),
  Object.freeze({ today: true }),
]);

const FADE_TICKS = Math.max(
  1,
  Math.ceil(TIMELAPSE_FADE_MS / TIMELAPSE_FRAME_MS),
);

/**
 * @param {{ steps?: typeof TIMELAPSE_STEPS, setTimeoutImpl?: Function, clearTimeoutImpl?: Function, reducedMotion?: () => boolean, onStage?: () => void, onFrame?: () => void, onEnd?: () => void }} [options]
 *   `onStage`: the stage changed (a layer to add, remove or fade).
 *   `onFrame`: a fade tick wants a frame. `onEnd`: today's map is reached.
 */
export function createTimelapse({
  steps = TIMELAPSE_STEPS,
  setTimeoutImpl = (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeoutImpl = (id) => globalThis.clearTimeout(id),
  reducedMotion = () => false,
  onStage = () => {},
  onFrame = () => {},
  onEnd = () => {},
} = {}) {
  let playing = false;
  let index = 0;
  /** The shown year (alpha `currentAlpha`) and the next (`nextAlpha`). */
  let current = null;
  let currentAlpha = 1;
  let next = null;
  let nextAlpha = 0;
  let holdDone = false;
  let ready = false;
  let fading = false;
  /** Loaded tiles of the current preload, which `token` names. */
  let loaded = 0;
  let token = 0;
  let tick = 0;
  /** Armed timers by purpose: at most one each. */
  const timers = { hold: null, cap: null, fade: null };

  function arm(purpose, ms, fn) {
    disarm(purpose);
    timers[purpose] = setTimeoutImpl(() => {
      timers[purpose] = null;
      fn();
    }, ms);
  }

  function disarm(purpose) {
    if (timers[purpose] === null) return;
    clearTimeoutImpl(timers[purpose]);
    timers[purpose] = null;
  }

  const disarmAll = () => {
    for (const purpose of Object.keys(timers)) disarm(purpose);
  };

  /** Hold the shown year; preload the next above it, unless it is today. */
  function beginHold() {
    holdDone = false;
    fading = false;
    const upcoming = steps[index + 1] ?? null;
    next = upcoming && !upcoming.today ? upcoming : null;
    nextAlpha = 0;
    loaded = 0;
    token += 1;
    // Today needs nothing loaded.
    ready = !next;
    onStage();
    // The owner may have stopped it while drawing the stage.
    if (!playing) return;
    if (next)
      arm('cap', TIMELAPSE_READY_CAP_MS, () => {
        ready = true;
        maybeFade();
      });
    arm('hold', TIMELAPSE_HOLD_MS, () => {
      holdDone = true;
      maybeFade();
    });
  }

  function maybeFade() {
    if (!playing || fading || !holdDone || !ready) return;
    disarm('cap');
    fading = true;
    tick = 0;
    if (reducedMotion()) {
      finishFade();
      onFrame();
      return;
    }
    step();
  }

  /** One fade tick: the next year in, or for today the photos out. */
  function step() {
    if (!playing) return;
    tick += 1;
    const progress = Math.min(1, tick / FADE_TICKS);
    if (next) nextAlpha = progress;
    else currentAlpha = 1 - progress;
    if (progress < 1) {
      onStage();
      if (!playing) return;
      onFrame();
      arm('fade', TIMELAPSE_FRAME_MS, step);
      return;
    }
    finishFade();
    onFrame();
  }

  function finishFade() {
    fading = false;
    if (next) {
      current = next;
      currentAlpha = 1;
      next = null;
      nextAlpha = 0;
      index += 1;
      beginHold();
      return;
    }
    // Today's map: the photos are gone and playback ends.
    playing = false;
    current = null;
    currentAlpha = 0;
    index = steps.length - 1;
    disarmAll();
    onStage();
    onEnd();
  }

  /** What is on screen: the next once more than half in; today once the
   * last photo is more than half out. */
  function onScreenStep() {
    if (next && nextAlpha >= 0.5) return next;
    if (!next && fading && currentAlpha < 0.5) return { today: true };
    return current;
  }

  return {
    /** Play from the first year. */
    start() {
      disarmAll();
      const first = steps[0];
      if (!first || first.today) return false;
      playing = true;
      index = 0;
      current = first;
      currentAlpha = 1;
      beginHold();
      return playing;
    },

    /**
     * Stop where it is. Returns what is on screen at this moment: `{year}`
     * (the next year once more than half in), `{today: true}` (the last
     * photo more than half out), or null when not playing.
     * @returns {{year: number} | {today: true} | null}
     */
    stop() {
      if (!playing) return null;
      const onScreen = onScreenStep();
      playing = false;
      disarmAll();
      current = null;
      next = null;
      currentAlpha = 1;
      nextAlpha = 0;
      fading = false;
      loaded = 0;
      if (onScreen?.today) return { today: true };
      return onScreen ? { year: onScreen.year } : null;
    },

    isPlaying: () => playing,

    /**
     * What to draw: the shown year and the next, each with its alpha, its
     * place in the draw order and (the next) the preload's token.
     */
    stage() {
      return {
        current: current ? { ...current, alpha: currentAlpha } : null,
        next: next ? { ...next, alpha: nextAlpha, token } : null,
        fading,
      };
    },

    /** The step on screen now: `{year, reference}`, `{today}` or null. */
    shown() {
      const onScreen = playing ? onScreenStep() : null;
      if (!onScreen) return null;
      return onScreen.today
        ? { today: true }
        : { year: onScreen.year, reference: onScreen.reference };
    },

    /** The year on screen now, or null (today, or not playing). */
    shownYear() {
      const onScreen = playing ? onScreenStep() : null;
      return onScreen && !onScreen.today ? onScreen.year : null;
    },

    /** A tile of the preload `preloadToken` loaded. */
    tileLoaded(preloadToken) {
      if (!playing || !next || preloadToken !== token) return;
      loaded += 1;
      if (loaded >= TIMELAPSE_READY_TILES) {
        ready = true;
        maybeFade();
      }
    },

    /**
     * No tile request is in flight: with at least one of the preload's
     * tiles loaded, the rest of the view is too.
     */
    idle() {
      if (!playing || !next || loaded === 0) return;
      ready = true;
      maybeFade();
    },

    /** Armed timers, for tests and the live gate. */
    armedTimers: () =>
      Object.values(timers).filter((timer) => timer !== null).length,
  };
}

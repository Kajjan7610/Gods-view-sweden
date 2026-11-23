/**
 * @module data/displayDelay
 * @description How far behind real time a live aircraft feed is drawn.
 *
 * Contacts are drawn at `now − delay` so that, at the time drawn, every
 * contact has a report on both sides and is placed between two real reports
 * instead of dead reckoned past its newest one. The delay has to cover how
 * late the feed really is: a feed whose reports arrive 90 s old every 30 s
 * needs about two minutes, a fresh one about half a minute.
 *
 * Each time a contact's report moves on, the feed's lag is how long the
 * display had to wait for it: its receipt time less the contact's previous
 * report time (lateness, the gap between reports and the wait for the next
 * poll together). The delay aimed at is the 90th percentile of the newest 256
 * lags plus 5 s, within the layer's floor and a five-minute cap. Before a
 * feed has given 16 lags, its first reports stand in: their age plus one poll
 * interval. A delivery that comes more than three poll intervals after the
 * one before it (a hidden tab's polls paused, or the feed failed) gives no
 * lags: the wait was not the feed's lateness.
 *
 * The delay drawn with moves toward that aim at a bounded rate, rising by at
 * most 0.2 s and falling by at most 0.05 s per second, so every contact
 * slows or speeds up a little rather than the whole fleet jumping; an aim
 * within 2 s of where it is leaves it there. Until a layer has drawn a
 * contact, it takes its aim at once.
 *
 * Swedish fork: a whole view of flights reads its centre less often than one
 * disc is read. Its lags are kept in a window of their own (`whole`), aimed
 * at once they are enough, and dropped as soon as a delivery is one disc
 * again; a lag since a report a whole view brought is not one disc's
 * either. Once one disc's lags say where to, the delay falls to the aim
 * within a poll interval: by the second poll after zooming in when one
 * disc's lags from before the whole view remain, else once the centre has
 * been read twice zoomed in.
 */

/** @constant {number} Percentile of the recent lags the delay covers. */
export const DISPLAY_DELAY_RANK = 0.9;
/** @constant {number} How many recent lags the percentile is taken over. */
export const DISPLAY_DELAY_LAGS = 256;
/** @constant {number} Lags before they, rather than first reports, set the aim. */
export const DISPLAY_DELAY_MIN_LAGS = 16;
/** @constant {number} Added to the percentile for jitter (ms). */
export const DISPLAY_DELAY_MARGIN_MS = 5_000;
/** @constant {number} The longest delay (ms). */
export const DISPLAY_DELAY_CAP_MS = 300_000;
/** @constant {number} Delay gained per unit of real time, at most. */
export const DISPLAY_DELAY_RISE = 0.2;
/** @constant {number} Delay shed per unit of real time, at most. */
export const DISPLAY_DELAY_FALL = 0.05;
/** @constant {number} An aim this close (ms) to the delay leaves it be. */
export const DISPLAY_DELAY_DEADBAND_MS = 2_000;
/** @constant {number} Poll intervals between deliveries past which a delivery gives no lags. */
export const DISPLAY_DELAY_GAP_POLLS = 3;
/** @constant {number} Poll intervals the delay takes to fall back after a whole view. */
export const DISPLAY_DELAY_CATCH_UP_POLLS = 1;

function createWindow(capacity) {
  return { values: new Float64Array(capacity), count: 0, cursor: 0 };
}

function add(window, value) {
  if (!Number.isFinite(value) || value < 0) return;
  window.values[window.cursor] = value;
  window.cursor = (window.cursor + 1) % window.values.length;
  window.count = Math.min(window.count + 1, window.values.length);
}

function percentile(window, rank) {
  const sorted = window.values.slice(0, window.count).sort();
  return sorted[Math.max(0, Math.ceil(sorted.length * rank) - 1)];
}

/**
 * One live feed's display delay.
 * @param {object} options
 * @param {number} options.floorMs The shortest delay (ms), and where it starts.
 * @param {number} options.pollMs How often the feed is asked (ms).
 * @param {number} [options.capMs] The longest delay (ms).
 */
export function createDisplayDelay({
  floorMs,
  pollMs,
  capMs = DISPLAY_DELAY_CAP_MS,
}) {
  const lags = createWindow(DISPLAY_DELAY_LAGS);
  const firstAges = createWindow(DISPLAY_DELAY_LAGS);
  // A whole view's lags, whether the last delivery was one, and when the
  // newest one came.
  const wholeLags = createWindow(DISPLAY_DELAY_LAGS);
  let wasWhole = false;
  let wholeAtMs = -Infinity;
  // Back from a whole view, until one disc's lags say where to fall to.
  let catchingUp = false;
  // How fast the delay falls (per unit of real time): faster, back from a
  // whole view, until it reaches its aim.
  let fall = DISPLAY_DELAY_FALL;
  let aimMs = floorMs;
  let fromMs = floorMs;
  let fromAtMs = NaN;
  let currentMs = floorMs;
  // The delivery being noted, the one before it, and whether a pause
  // separated them.
  let deliveryMs = NaN;
  let afterGap = false;

  const clamp = (ms) => Math.max(floorMs, Math.min(capMs, ms));

  /** The delay at `nowMs` on its way from `fromMs` toward the aim. */
  function delayAt(nowMs) {
    if (!Number.isFinite(fromAtMs)) return fromMs;
    const elapsed = Math.max(0, nowMs - fromAtMs);
    const change = Math.max(
      -fall * elapsed,
      Math.min(DISPLAY_DELAY_RISE * elapsed, aimMs - fromMs),
    );
    return fromMs + change;
  }

  return {
    /** The delay contacts are drawn with now (whole ms), as last stepped. */
    get currentMs() {
      return currentMs;
    },
    /** The delay it is moving toward (ms). */
    get aimMs() {
      return aimMs;
    },
    /** Lags seen so far, up to the window. */
    get lagCount() {
      return lags.count;
    },

    /**
     * A contact's report received at `receiptMs`: its time, and the
     * contact's previous report time (none for a contact seen first).
     * `whole`: delivered in a whole view (its lags kept apart).
     */
    noteReport(receiptMs, reportMs, previousReportMs, { whole = false } = {}) {
      if (receiptMs !== deliveryMs) {
        afterGap = receiptMs - deliveryMs > DISPLAY_DELAY_GAP_POLLS * pollMs;
        deliveryMs = receiptMs;
      }
      if (whole) wholeAtMs = receiptMs;
      if (Number.isFinite(previousReportMs)) {
        // A lag since a report a whole view brought spans its pace.
        if (
          reportMs > previousReportMs &&
          !afterGap &&
          (whole || previousReportMs >= wholeAtMs)
        )
          add(whole ? wholeLags : lags, receiptMs - previousReportMs);
      } else if (Number.isFinite(reportMs))
        add(firstAges, receiptMs - reportMs);
    },

    /**
     * Aim again after a delivery. `jump`: nothing is drawn yet, so the delay
     * takes the aim at once. `whole`: the delivery was a whole view's.
     * @param {number} nowMs
     * @param {{jump?: boolean, whole?: boolean}} [options]
     * @returns {number} The delay now (whole ms).
     */
    settle(nowMs, { jump = false, whole = false } = {}) {
      // One disc again: the whole view's lags no longer say anything.
      if (wasWhole && !whole) {
        wholeLags.count = wholeLags.cursor = 0;
        catchingUp = true;
      }
      if (whole) catchingUp = false;
      wasWhole = whole;
      const window =
        whole && wholeLags.count >= DISPLAY_DELAY_MIN_LAGS ? wholeLags : lags;
      let next = aimMs;
      if (window.count >= DISPLAY_DELAY_MIN_LAGS)
        next = clamp(
          percentile(window, DISPLAY_DELAY_RANK) + DISPLAY_DELAY_MARGIN_MS,
        );
      // Back from a whole view first sightings say nothing: the delay waits
      // for one disc's lags.
      else if (firstAges.count && !catchingUp)
        next = clamp(
          percentile(firstAges, DISPLAY_DELAY_RANK) +
            pollMs +
            DISPLAY_DELAY_MARGIN_MS,
        );
      const now = delayAt(nowMs);
      fromMs = jump ? next : now;
      fromAtMs = nowMs;
      // An aim this close leaves the delay where it is.
      aimMs =
        Math.abs(next - now) < DISPLAY_DELAY_DEADBAND_MS && !jump ? now : next;
      // Back from a whole view, once one disc's lags say where to, the delay
      // reaches its aim within a poll interval; once there, it falls at its
      // usual rate again.
      if (catchingUp && lags.count >= DISPLAY_DELAY_MIN_LAGS) {
        catchingUp = false;
        if (aimMs < fromMs)
          fall = Math.max(
            DISPLAY_DELAY_FALL,
            (fromMs - aimMs) / (DISPLAY_DELAY_CATCH_UP_POLLS * pollMs),
          );
      } else if (fromMs - aimMs < DISPLAY_DELAY_DEADBAND_MS)
        fall = DISPLAY_DELAY_FALL;
      currentMs = Math.round(fromMs);
      return currentMs;
    },

    /**
     * Move the delay on to `nowMs`: what the contacts are drawn with until
     * the next step.
     * @returns {number} Whole ms.
     */
    step(nowMs) {
      currentMs = Math.round(delayAt(nowMs));
      return currentMs;
    },

    /** Forget the feed: back to the floor, nothing learned. */
    reset() {
      lags.count = lags.cursor = 0;
      firstAges.count = firstAges.cursor = 0;
      wholeLags.count = wholeLags.cursor = 0;
      wasWhole = false;
      wholeAtMs = -Infinity;
      catchingUp = false;
      fall = DISPLAY_DELAY_FALL;
      aimMs = fromMs = currentMs = floorMs;
      fromAtMs = NaN;
      deliveryMs = NaN;
      afterGap = false;
    },
  };
}

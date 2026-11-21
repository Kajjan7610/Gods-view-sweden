// The time-lapse on its own clock: the step order, two photo layers at
// most, waiting for the next year's tiles (capped), fade ticks only during
// a fade, the reduced-motion cut, and nothing left once stopped.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TIMELAPSE_FADE_MS,
  TIMELAPSE_FRAME_MS,
  TIMELAPSE_HOLD_MS,
  TIMELAPSE_READY_CAP_MS,
  TIMELAPSE_READY_TILES,
  TIMELAPSE_STEPS,
  createTimelapse,
} from './timelapse.js';

/** Timers on a clock the test moves. */
function virtualClock() {
  let now = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeoutImpl(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, at: now + Math.max(0, ms) });
      return id;
    },
    clearTimeoutImpl(id) {
      pending.delete(id);
    },
    /** Move the clock, firing each timer due on the way, in order. */
    advance(ms) {
      const until = now + ms;
      for (;;) {
        let due = null;
        for (const [id, timer] of pending)
          if (timer.at <= until && (!due || timer.at < due[1].at))
            due = [id, timer];
        if (!due) break;
        pending.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
    armed: () => pending.size,
    now: () => now,
  };
}

function rig({ reducedMotion = false } = {}) {
  const clock = virtualClock();
  const stages = [];
  const frames = [];
  let ended = 0;
  const lapse = createTimelapse({
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    reducedMotion: () => reducedMotion,
    onStage: () => stages.push(lapse.stage()),
    onFrame: () => frames.push(clock.now()),
    onEnd: () => (ended += 1),
  });
  /** The next year's tiles load, enough of them. */
  const loadNext = () => {
    const next = lapse.stage().next;
    for (let i = 0; i < TIMELAPSE_READY_TILES; i += 1)
      lapse.tileLoaded(next.token);
  };
  return { clock, lapse, stages, frames, ended: () => ended, loadNext };
}

test('every year in black and white, 1960 to 2005, then today', () => {
  assert.deepEqual(
    TIMELAPSE_STEPS.map((step) => (step.today ? 'today' : step.layerId)),
    [
      '1960',
      '1975',
      ...Array.from({ length: 13 }, (_, i) => `bw-${1993 + i}`),
      'today',
    ],
  );
  assert.equal(TIMELAPSE_FADE_MS, 800);
  assert.equal(TIMELAPSE_HOLD_MS, 1800);
});

test('it steps through the years in order and ends on today, never with more than two photos', () => {
  const { clock, lapse, stages, ended, loadNext } = rig();
  lapse.start();
  const shown = [lapse.shownYear()];
  for (let guard = 0; guard < 40 && lapse.isPlaying(); guard += 1) {
    if (lapse.stage().next) loadNext();
    clock.advance(TIMELAPSE_HOLD_MS + TIMELAPSE_FADE_MS + 100);
    if (lapse.shownYear() !== shown.at(-1)) shown.push(lapse.shownYear());
  }
  assert.deepEqual(
    shown,
    [1960, 1975, ...Array.from({ length: 13 }, (_, i) => 1993 + i), null],
  );
  assert.equal(ended(), 1);
  assert.equal(lapse.isPlaying(), false);
  for (const stage of stages) {
    const photos = [stage.current, stage.next].filter(Boolean);
    assert.ok(photos.length <= 2, 'at most the shown year and the next');
  }
  assert.equal(clock.armed(), 0, 'no timer after the end');
  assert.deepEqual(lapse.stage(), { current: null, next: null, fading: false });
});

test('the next year is preloaded at alpha 0 one hold ahead; the fade waits for its tiles, capped', () => {
  const { clock, lapse, frames } = rig();
  lapse.start();
  assert.deepEqual(
    [lapse.stage().current.layerId, lapse.stage().current.alpha],
    ['1960', 1],
  );
  assert.deepEqual(
    [lapse.stage().next.layerId, lapse.stage().next.alpha],
    ['1975', 0],
  );
  clock.advance(TIMELAPSE_HOLD_MS + 500);
  assert.equal(lapse.stage().next.alpha, 0, 'no fade before its tiles');
  assert.deepEqual(frames, [], 'nothing asked for during the hold');
  // A tile of another (an earlier) preload counts for nothing, and the
  // requests going idle before any of this one's tiles loaded neither.
  const { token } = lapse.stage().next;
  for (let i = 0; i < 8; i += 1) lapse.tileLoaded(token - 1);
  lapse.idle();
  clock.advance(10);
  assert.equal(lapse.stage().next.alpha, 0);
  // The cap: four seconds after the preload, it fades anyway.
  clock.advance(TIMELAPSE_READY_CAP_MS - TIMELAPSE_HOLD_MS - 510);
  assert.ok(lapse.stage().next.alpha > 0, 'fading after the cap');
});

test('a fade asks for a frame per tick, about 30 a second, and none during holds', () => {
  const { clock, lapse, frames, loadNext } = rig();
  lapse.start();
  loadNext();
  clock.advance(TIMELAPSE_HOLD_MS);
  assert.equal(frames.length, 1, 'the first tick at the end of the hold');
  clock.advance(TIMELAPSE_FADE_MS + 50);
  const fadeFrames = frames.length;
  assert.equal(fadeFrames, Math.ceil(TIMELAPSE_FADE_MS / TIMELAPSE_FRAME_MS));
  assert.ok(
    frames.every((at) => at >= TIMELAPSE_HOLD_MS && at <= TIMELAPSE_HOLD_MS + TIMELAPSE_FADE_MS + 40),
  );
  assert.equal(lapse.shownYear(), 1975);
  assert.equal(lapse.stage().current.alpha, 1);
  // The next hold asks for nothing.
  clock.advance(TIMELAPSE_HOLD_MS - 100);
  assert.equal(frames.length, fadeFrames);
});

test('with reduced motion each step cuts, with one frame', () => {
  const { clock, lapse, frames, loadNext } = rig({ reducedMotion: true });
  lapse.start();
  loadNext();
  clock.advance(TIMELAPSE_HOLD_MS);
  assert.equal(lapse.shownYear(), 1975, 'cut at once');
  assert.equal(lapse.stage().current.alpha, 1);
  assert.equal(frames.length, 1);
});

test('stopping keeps the year on screen and leaves no timer', () => {
  const { clock, lapse, loadNext } = rig();
  lapse.start();
  loadNext();
  clock.advance(TIMELAPSE_HOLD_MS + TIMELAPSE_FADE_MS * 0.25);
  assert.deepEqual(lapse.stop(), { year: 1960 }, 'a quarter in: still 1960');
  assert.equal(clock.armed(), 0);
  assert.equal(lapse.isPlaying(), false);
  lapse.start();
  loadNext();
  clock.advance(TIMELAPSE_HOLD_MS + TIMELAPSE_FADE_MS * 0.75);
  assert.deepEqual(lapse.stop(), { year: 1975 }, 'three quarters in: 1975');
  assert.equal(clock.armed(), 0);
  assert.equal(lapse.stop(), null, 'stopping twice is nothing');
});

test('each step draws above the one before; the requests going idle after a load is ready', () => {
  const { clock, lapse } = rig();
  assert.deepEqual(
    TIMELAPSE_STEPS.filter((step) => !step.today).map((step) => step.order),
    Array.from({ length: 15 }, (_, i) => i),
  );
  lapse.start();
  const { current, next } = lapse.stage();
  assert.ok(next.order > current.order, 'the incoming year is above');
  lapse.idle();
  clock.advance(TIMELAPSE_HOLD_MS);
  assert.equal(lapse.stage().next.alpha, 0, 'idle with nothing loaded: wait');
  lapse.tileLoaded(next.token);
  lapse.idle();
  assert.ok(lapse.stage().next.alpha > 0, 'one loaded and idle: fade');
});

test('a stop during the last fade, more than half out, counts as today', () => {
  const { clock, lapse, loadNext } = rig();
  lapse.start();
  while (lapse.stage().next) {
    loadNext();
    const from = lapse.stage().current.year;
    while (lapse.stage().current?.year === from) clock.advance(10);
  }
  assert.equal(lapse.shownYear(), 2005);
  assert.equal(lapse.stage().next, null, 'today needs no preload');
  while (!lapse.stage().fading) clock.advance(10);
  clock.advance(TIMELAPSE_FADE_MS * 0.25);
  assert.equal(lapse.shownYear(), 2005, 'a quarter out: still 2005');
  clock.advance(TIMELAPSE_FADE_MS * 0.5);
  assert.deepEqual(lapse.shown(), { today: true });
  assert.equal(lapse.shownYear(), null);
  assert.deepEqual(lapse.stop(), { today: true });
  assert.equal(clock.armed(), 0);
});

test('an owner that stops it while drawing the stage leaves no timer armed', () => {
  const clock = virtualClock();
  let lapse = null;
  lapse = createTimelapse({
    setTimeoutImpl: clock.setTimeoutImpl,
    clearTimeoutImpl: clock.clearTimeoutImpl,
    onStage: () => lapse.stop(),
  });
  lapse.start();
  assert.equal(lapse.isPlaying(), false);
  assert.equal(clock.armed(), 0);
});

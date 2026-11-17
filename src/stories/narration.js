// Swedish fork: a shipped story may carry a spoken narration in one
// language. The recording holds one line per chapter (a cue: where the line
// starts and ends in the file); each line plays from the moment its chapter
// starts and follows the story's clock, so pausing, seeking and replaying
// keep voice and picture together. Nothing plays in another language or
// while the person has muted it.
import { getLocale } from '../i18n/index.js';

/** Further apart than this, the voice jumps to where the story is. */
export const NARRATION_DRIFT_MS = 350;

/**
 * The line the story is in at `wallMs`, and where in the recording, or
 * null between lines.
 * @param {{chapters: {wallMs: number}[]}} story
 * @param {{cues: {fromMs: number, toMs: number}[]}} narration One cue per
 *   chapter, in chapter order; a chapter without a line has none.
 * @param {number} wallMs
 * @returns {{atMs: number, toMs: number}|null} Milliseconds into the
 *   recording, and where the line ends there.
 */
export function narrationCueAt(story, narration, wallMs) {
  const chapters = story?.chapters ?? [];
  let index = -1;
  for (let i = 0; i < chapters.length; i += 1)
    if (chapters[i].wallMs <= wallMs) index = i;
  const cue = narration?.cues?.[index];
  if (!cue) return null;
  const atMs = cue.fromMs + (wallMs - chapters[index].wallMs);
  return atMs < cue.toMs ? { atMs, toMs: cue.toMs } : null;
}

/** Where in the recording the story is at `wallMs`, or null. */
export const narrationTimeAt = (story, narration, wallMs) =>
  narrationCueAt(story, narration, wallMs)?.atMs ?? null;

/**
 * @param {object} story A catalog story with `narration`
 *   ({lang, src, cues}).
 * @param {object} [options]
 * @param {(src: string) => HTMLAudioElement} [options.createAudio]
 * @param {() => string} [options.locale]
 */
export function createNarration(
  story,
  {
    createAudio = (src) => {
      const audio = new Audio(src);
      audio.preload = 'auto';
      return audio;
    },
    locale = getLocale,
    timers = globalThis,
  } = {},
) {
  const narration = story?.narration;
  let audio = null;
  let muted = false;
  let destroyed = false;
  // The story's clock ticks unevenly (at shot changes, seeks and pauses), so
  // each line stops itself where it ends instead of running into the next.
  let lineEnd = 0;

  const silent = () => {
    timers.clearTimeout(lineEnd);
    lineEnd = 0;
    if (audio && !audio.paused) audio.pause();
  };

  return {
    /** Whether this story speaks in the page's language. */
    get offered() {
      return Boolean(narration?.src) && locale() === narration.lang;
    },
    get muted() {
      return muted;
    },
    setMuted(value) {
      muted = Boolean(value);
      if (muted) silent();
    },
    /** Follow the story's clock: one call per tick. */
    sync({ playing, wallMs }) {
      if (destroyed || !this.offered) return;
      const cue =
        playing && !muted ? narrationCueAt(story, narration, wallMs) : null;
      if (!cue) {
        silent();
        return;
      }
      audio ??= createAudio(narration.src);
      if (Math.abs(audio.currentTime * 1000 - cue.atMs) > NARRATION_DRIFT_MS)
        audio.currentTime = cue.atMs / 1000;
      if (audio.paused) {
        // A browser that blocks sound before a gesture just stays silent.
        Promise.resolve(audio.play()).catch(() => {});
      }
      timers.clearTimeout(lineEnd);
      lineEnd = timers.setTimeout(
        silent,
        Math.max(0, cue.toMs - audio.currentTime * 1000),
      );
    },
    destroy() {
      destroyed = true;
      silent();
      if (audio) audio.src = '';
      audio = null;
    },
  };
}

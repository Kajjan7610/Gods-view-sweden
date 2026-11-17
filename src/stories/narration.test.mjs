// Swedish fork: a story's narration follows the story's clock.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NARRATION_DRIFT_MS,
  createNarration,
  narrationTimeAt,
} from './narration.js';

const STORY = Object.freeze({
  chapters: [{ wallMs: 0 }, { wallMs: 8000 }, { wallMs: 17000 }],
  narration: {
    lang: 'sv',
    src: '/stories/test.mp3',
    cues: [
      { fromMs: 0, toMs: 5000 },
      { fromMs: 5100, toMs: 9000 },
    ],
  },
});

function fakeAudio() {
  const audio = {
    created: 0,
    paused: true,
    currentTime: 0,
    plays: 0,
    src: '',
    play() {
      audio.paused = false;
      audio.plays += 1;
      return Promise.resolve();
    },
    pause() {
      audio.paused = true;
    },
  };
  return audio;
}

function setup(locale = 'sv') {
  const audio = fakeAudio();
  const narration = createNarration(STORY, {
    createAudio: (src) => {
      audio.created += 1;
      audio.src = src;
      return audio;
    },
    locale: () => locale,
  });
  return { audio, narration };
}

test('each chapter plays its own line from the chapter start, then is silent', () => {
  assert.equal(narrationTimeAt(STORY, STORY.narration, 0), 0);
  assert.equal(narrationTimeAt(STORY, STORY.narration, 4000), 4000);
  assert.equal(narrationTimeAt(STORY, STORY.narration, 6000), null);
  assert.equal(narrationTimeAt(STORY, STORY.narration, 8000), 5100);
  assert.equal(narrationTimeAt(STORY, STORY.narration, 10000), 7100);
  assert.equal(narrationTimeAt(STORY, STORY.narration, 12000), null);
  // A chapter without a line is silent.
  assert.equal(narrationTimeAt(STORY, STORY.narration, 17500), null);
});

test('the voice plays, pauses and jumps with the story', () => {
  const { audio, narration } = setup();
  assert.equal(narration.offered, true);
  // Nothing is fetched before the story plays.
  narration.sync({ playing: false, wallMs: 0 });
  assert.equal(audio.created, 0);
  narration.sync({ playing: true, wallMs: 1000 });
  assert.equal(audio.created, 1);
  assert.equal(audio.src, '/stories/test.mp3');
  assert.equal(audio.paused, false);
  assert.equal(audio.currentTime, 1);
  // A small drift is left alone, a seek jumps.
  audio.currentTime = 1.2;
  narration.sync({ playing: true, wallMs: 1000 + NARRATION_DRIFT_MS - 150 });
  assert.equal(audio.currentTime, 1.2);
  narration.sync({ playing: true, wallMs: 9000 });
  assert.equal(audio.currentTime, 6.1);
  narration.sync({ playing: false, wallMs: 9000 });
  assert.equal(audio.paused, true);
  // Between lines it waits.
  narration.sync({ playing: true, wallMs: 13000 });
  assert.equal(audio.paused, true);
  narration.destroy();
  assert.equal(audio.src, '');
  narration.sync({ playing: true, wallMs: 1000 });
  assert.equal(audio.paused, true);
});

test('a line stops at its own end, even when the clock does not tick', () => {
  const audio = fakeAudio();
  const pending = [];
  const narration = createNarration(STORY, {
    createAudio: () => audio,
    locale: () => 'sv',
    timers: {
      setTimeout: (fn, ms) => pending.push({ fn, ms }) && pending.length,
      clearTimeout: (id) => {
        if (id) pending[id - 1].fn = null;
      },
    },
  });
  narration.sync({ playing: true, wallMs: 1000 });
  assert.equal(audio.paused, false);
  const live = pending.filter(({ fn }) => fn);
  assert.equal(live.length, 1);
  assert.equal(live[0].ms, 4000);
  live[0].fn();
  assert.equal(audio.paused, true);
  // A new tick replaces the timer.
  narration.sync({ playing: true, wallMs: 8000 });
  assert.equal(pending.filter(({ fn }) => fn).length, 1);
});

test('muted, or in another language, it never speaks', () => {
  const muted = setup();
  muted.narration.setMuted(true);
  muted.narration.sync({ playing: true, wallMs: 1000 });
  assert.equal(muted.audio.created, 0);
  muted.narration.setMuted(false);
  muted.narration.sync({ playing: true, wallMs: 1000 });
  assert.equal(muted.audio.paused, false);
  muted.narration.setMuted(true);
  assert.equal(muted.audio.paused, true);

  const english = setup('en');
  assert.equal(english.narration.offered, false);
  english.narration.sync({ playing: true, wallMs: 1000 });
  assert.equal(english.audio.created, 0);
});

test('a clock that trails the voice does not restart a line that has been spoken', () => {
  const { audio, narration } = setup();
  narration.sync({ playing: true, wallMs: 1000 });
  // The voice reached the line's end; the story's clock says 4950 ms.
  audio.currentTime = 4.96;
  audio.pause();
  const plays = audio.plays;
  narration.sync({ playing: true, wallMs: 4950 });
  assert.equal(audio.plays, plays);
  assert.equal(audio.paused, true);
});

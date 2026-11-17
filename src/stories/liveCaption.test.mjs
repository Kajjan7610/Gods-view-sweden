// Swedish fork: captions that quote live numbers, and the aurora story.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chapterCaption, readStoryFact } from './liveCaption.js';
import { listStories } from './catalog.js';

const T = (text, values) =>
  String(text).replace(/\{(\w+)\}/g, (m, key) =>
    values && key in values ? String(values[key]) : m,
  );

const OVAL = Object.freeze({
  facts: { kp: 'aurora.kp' },
  captions: [
    { text: 'Kp {kp}: a calm night.', when: { kp: { below: 3 } } },
    { text: 'Kp {kp} right now.' },
    { text: 'The green band is the aurora forecast.' },
  ],
});

test('a caption quotes the live number it names, and its condition picks the words', () => {
  assert.equal(
    chapterCaption(OVAL, () => 5, T),
    'Kp 5 right now.',
  );
  assert.equal(
    chapterCaption(OVAL, () => 2.3, T),
    'Kp 2.3: a calm night.',
  );
});

test('without the number, the caption says only what holds without it', () => {
  assert.equal(
    chapterCaption(OVAL, () => null, T),
    'The green band is the aurora forecast.',
  );
  assert.equal(
    chapterCaption(OVAL, () => Number.NaN, T),
    'The green band is the aurora forecast.',
  );
  // A plain caption, and none at all.
  assert.equal(
    chapterCaption({ caption: 'Plain' }, () => 1, T),
    'Plain',
  );
  assert.equal(
    chapterCaption({ caption: '' }, () => 1, T),
    '',
  );
});

test('a fact is read from the layer that owns it, and only while it is on', () => {
  const aurora = {
    module: { storyFacts: () => ({ kp: 4, 'chance.Kiruna': 37 }) },
  };
  const manager = (on) => ({
    layers: new Map([['aurora', aurora]]),
    isEnabled: () => on,
  });
  assert.equal(readStoryFact(manager(true), 'aurora.kp'), 4);
  assert.equal(readStoryFact(manager(true), 'aurora.chance.Kiruna'), 37);
  assert.equal(readStoryFact(manager(false), 'aurora.kp'), null);
  assert.equal(readStoryFact(manager(true), 'aurora.missing'), null);
  assert.equal(readStoryFact(manager(true), 'nolayer.kp'), null);
  assert.equal(readStoryFact(manager(true), 'kp'), null);
  assert.equal(readStoryFact(null, 'aurora.kp'), null);
  const broken = {
    layers: new Map([
      [
        'aurora',
        {
          module: {
            storyFacts: () => {
              throw new Error('no grid');
            },
          },
        },
      ],
    ]),
  };
  assert.equal(readStoryFact(broken, 'aurora.kp'), null);
});

test('the aurora story ships with live captions, one narration line per chapter and its credits', () => {
  const story = listStories().find(({ id }) => id === 'gev:night-over-sweden');
  assert.ok(story, 'listed');
  assert.equal(story.chapters.length, 6);
  assert.equal(story.narration.lang, 'sv');
  assert.equal(story.narration.cues.length, story.chapters.length);
  // Every line fits its chapter, and the lines follow each other.
  story.chapters.forEach((chapter, i) => {
    const cue = story.narration.cues[i];
    const next = story.chapters[i + 1]?.wallMs ?? story.durationMs;
    assert.ok(cue.toMs > cue.fromMs);
    assert.ok(cue.toMs - cue.fromMs <= next - chapter.wallMs, `line ${i + 1}`);
    if (i) assert.ok(cue.fromMs >= story.narration.cues[i - 1].toMs);
  });
  // Every chapter has a caption that needs no live number.
  for (const chapter of story.chapters) {
    assert.ok(chapter.captions?.length, chapter.title);
    assert.notEqual(
      chapterCaption(chapter, () => null, T),
      '',
      chapter.title,
    );
  }
  const oval = story.chapters[1];
  assert.match(
    chapterCaption(oval, () => 6, T),
    /^Kp 6 right now\./,
  );
  assert.match(
    chapterCaption(oval, () => 1, T),
    /calm night/,
  );
  const kiruna = story.chapters[2];
  assert.match(
    chapterCaption(
      kiruna,
      (key) => (key === 'aurora.chance.Kiruna' ? 12 : null),
      T,
    ),
    /Kiruna right now: 12 %/,
  );
  // The free ElevenLabs plan asks for the credit, NOAA, SMHI and
  // Trafikverket are credited too.
  const credited = story.sources.map(([name]) => name);
  for (const name of ['NOAA SWPC', 'SMHI', 'Trafikverket', 'elevenlabs.io'])
    assert.ok(credited.includes(name), name);
});

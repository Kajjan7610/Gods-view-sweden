// Swedish fork: what a moving item's card says about its reading ("Live",
// "Live · 12 s": the ISS, an aircraft, a train) reads as Swedish, as most
// other languages translate it (German keeps "Live"); the timeline's button
// that goes back to the present uses the same word, and a playing broadcast
// has its own, "Direkt".
import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale, t } from './index.js';
import sameAsEnglish from './same-as-english.json' with { type: 'json' };

const STATUS = ['Live', 'Live · {age}'];

test('a moving item’s status reads in Swedish', (t_) => {
  t_.after(() => setLocale('en'));
  setLocale('sv');
  assert.equal(t('Live'), 'Realtid');
  assert.equal(t('Live · {age}', { age: '12 s' }), 'Realtid · 12 s');
  assert.equal(t('Back to live'), 'Tillbaka till realtid');
  assert.equal(
    t('Back to live at the starting view'),
    'Tillbaka till realtid i startvyn',
  );
  assert.equal(t('Live', { context: 'video stream' }), 'Direkt');
  for (const text of STATUS)
    assert.ok(!sameAsEnglish.sv.includes(text), `${text} is not English`);
});

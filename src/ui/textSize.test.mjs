// The text size: stored per browser, Larger by default, stepping round,
// shown on the root element, and safe when storage refuses.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_TEXT_SIZE,
  TEXT_SIZE_STORAGE_KEY,
  applyTextSize,
  nextTextSize,
  readTextSize,
  saveTextSize,
} from './textSize.js';

const memory = () => {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
  };
};

test('Larger until the viewer chooses; an unknown value is ignored', () => {
  const storage = memory();
  assert.equal(DEFAULT_TEXT_SIZE, 'large');
  assert.equal(readTextSize(storage), 'large');
  saveTextSize(storage, 'normal');
  assert.equal(readTextSize(storage), 'normal');
  storage.setItem(TEXT_SIZE_STORAGE_KEY, 'huge');
  assert.equal(readTextSize(storage), 'large');
  assert.equal(readTextSize(null), 'large');
});

test('the sizes step round', () => {
  assert.equal(nextTextSize('normal'), 'large');
  assert.equal(nextTextSize('large'), 'largest');
  assert.equal(nextTextSize('largest'), 'normal');
});

test('refusing storage and a missing root are no errors', () => {
  const refusing = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
  };
  assert.equal(readTextSize(refusing), 'large');
  assert.doesNotThrow(() => saveTextSize(refusing, 'largest'));
  assert.doesNotThrow(() => applyTextSize('large', null));
  const root = { dataset: {} };
  applyTextSize('largest', root);
  assert.equal(root.dataset.textSize, 'largest');
});

// Saver mode: the viewer's choice, and the address forcing it either way.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GLOBE_SAVER_STORAGE_KEY,
  readGlobeSaver,
  saveGlobeSaver,
} from './globeSaver.js';

const memory = () => {
  const map = new Map();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
};

test('off until chosen; the choice is kept and taken back', () => {
  const storage = memory();
  assert.equal(readGlobeSaver(storage), false);
  saveGlobeSaver(storage, true);
  assert.equal(storage.getItem(GLOBE_SAVER_STORAGE_KEY), 'on');
  assert.equal(readGlobeSaver(storage, '?lang=sv'), true);
  saveGlobeSaver(storage, false);
  assert.equal(readGlobeSaver(storage), false);
});

test('?globe=lite and ?globe=3d win over the choice for one load', () => {
  const storage = memory();
  assert.equal(readGlobeSaver(storage, '?globe=lite'), true);
  saveGlobeSaver(storage, true);
  assert.equal(readGlobeSaver(storage, '?lang=sv&globe=3d'), false);
});

test('refusing storage is no error', () => {
  const refusing = {
    getItem() {
      throw new Error('denied');
    },
    setItem() {
      throw new Error('denied');
    },
    removeItem() {
      throw new Error('denied');
    },
  };
  assert.equal(readGlobeSaver(refusing), false);
  assert.doesNotThrow(() => saveGlobeSaver(refusing, true));
  assert.equal(readGlobeSaver(null, ''), false);
});

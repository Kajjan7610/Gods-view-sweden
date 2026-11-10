// What the dev server's file watcher leaves alone.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  PARTIAL_DOWNLOAD_GLOBS,
  unwatchedRuntimeDirsPlugin,
} from './unwatched-cache.js';

const ignoredGlobs = () =>
  unwatchedRuntimeDirsPlugin().config().server.watch.ignored;
const ignored = (file) =>
  ignoredGlobs().some((glob) => path.posix.matchesGlob(file, glob));

test('a download the browser is still writing is not watched', () => {
  for (const glob of PARTIAL_DOWNLOAD_GLOBS)
    assert.ok(ignoredGlobs().includes(glob), glob);
  // The file that once stopped the dev server, and its Firefox kin.
  assert.ok(
    ignored('D:/Claude Cowork/gods-eye-view/Unconfirmed 64900.crdownload'),
  );
  assert.ok(ignored('D:/repo/credentials.json.crdownload'));
  assert.ok(ignored('/home/kaj/repo/data/export.csv.part'));
  assert.ok(ignored('/home/kaj/repo/x.tmp'));
});

test('the app’s own write directories stay unwatched, and source is watched', () => {
  assert.ok(ignored('/home/kaj/repo/.gev-cache/overpass/a.json'));
  assert.ok(ignored('/home/kaj/repo/.gev-logs/voice.log'));
  for (const file of [
    '/home/kaj/repo/src/layers/policeEvents/records.js',
    '/home/kaj/repo/server/providers/polisenEvents.js',
    '/home/kaj/repo/credentials.json',
    '/home/kaj/repo/src/i18n/locales/sv.json',
  ])
    assert.ok(!ignored(file), file);
});

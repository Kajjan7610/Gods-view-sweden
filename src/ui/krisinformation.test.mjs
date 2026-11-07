// Krisinformation.se in the app: which messages concern a town, and the
// public alert banner's rows.
import assert from 'node:assert/strict';
import test from 'node:test';
import { concernsTown, messagesFor } from './krisinformationModel.js';
import { bannerRows } from './vmaBanner.js';

const VASTERAS = { municipality: 'Västerås', county: 'Västmanlands län' };
const msg = (id, kind, areas, published = 0) => ({
  id,
  kind,
  headline: id,
  preamble: null,
  published,
  web: `https://www.krisinformation.se/${id}`,
  areas,
});

test('the country, the county or the municipality concern a town', () => {
  assert.equal(
    concernsTown(
      msg('a', 'news', [{ type: 'Country', name: 'Sverige' }]),
      VASTERAS,
    ),
    true,
  );
  assert.equal(
    concernsTown(
      msg('b', 'news', [{ type: 'County', name: 'Västmanlands län' }]),
      VASTERAS,
    ),
    true,
  );
  assert.equal(
    concernsTown(
      msg('c', 'news', [{ type: 'Municipality', name: 'Västerås kommun' }]),
      VASTERAS,
    ),
    true,
  );
  assert.equal(
    concernsTown(
      msg('d', 'news', [{ type: 'Municipality', name: 'Uppsala kommun' }]),
      VASTERAS,
    ),
    false,
  );
  assert.equal(concernsTown(msg('e', 'news', []), VASTERAS), false);
});

test("a town's share: its alerts, and its newest news marked national or not", () => {
  const body = {
    vmas: [
      msg('vma-here', 'vma', [
        { type: 'Municipality', name: 'Västerås kommun' },
      ]),
      msg('vma-there', 'vma', [
        { type: 'Municipality', name: 'Kiruna kommun' },
      ]),
    ],
    news: [
      msg('n1', 'news', [{ type: 'Country', name: 'Sverige' }], 3),
      msg('n2', 'news', [{ type: 'County', name: 'Västmanlands län' }], 2),
      msg('n3', 'news', [{ type: 'County', name: 'Skåne län' }], 1),
    ],
  };
  const share = messagesFor(body, VASTERAS);
  assert.deepEqual(
    share.vmas.map((m) => m.id),
    ['vma-here'],
  );
  assert.deepEqual(
    share.news.map((m) => [m.id, m.national]),
    [
      ['n1', true],
      ['n2', false],
    ],
  );
  assert.deepEqual(messagesFor(null, VASTERAS), { vmas: [], news: [] });
});

test('the banner: every active alert in Sweden, closed ones left out', () => {
  const body = {
    vmas: [
      msg('v1', 'vma', [
        { type: 'Municipality', name: 'Västerås kommun' },
        { type: 'County', name: 'Västmanlands län' },
      ]),
      msg('v2', 'vma', [{ type: 'Country', name: 'Sverige' }]),
    ],
  };
  const rows = bannerRows(body);
  assert.deepEqual(
    rows.map((r) => r.area),
    ['Västerås kommun, Västmanlands län', 'All of Sweden'],
  );
  assert.deepEqual(
    bannerRows(body, new Set(['v1'])).map((r) => r.key),
    ['v2'],
  );
  assert.deepEqual(bannerRows(null), []);
});

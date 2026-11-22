// Layer status texts arrive as English data and show in the UI language by
// their shape; English shows exactly as it came.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale, t } from '../i18n/index.js';
import { celestrakPausedError } from '../layers/satellites/ingestion.js';
import {
  translateFeedError,
  translateStatusLine,
  translateStatusMessage,
} from './statusText.js';

// Swedish fork: a CelesTrak pause ends at a local time; read it as a Swedish
// user would.
process.env.TZ = 'Europe/Stockholm';

function inLocale(locale, run) {
  setLocale(locale);
  try {
    return run();
  } finally {
    setLocale('en');
  }
}

const STATUS_LINES = [
  'feed 1090 unreachable',
  'feeds 1090, entry 2 invalid',
  '3 heard · USB 5.8 msg/s · feed 1090 stale',
  '2 feeds live · 14 heard',
  'TTC 0 (95s old)',
  'TTC 0 · GO Transit 4 (95s old)',
  'Loading TTC, MiWay',
];

test('en: status lines and errors show as they came', () => {
  setLocale('en');
  for (const text of [
    ...STATUS_LINES,
    'ECCC HTTP 503',
    'GNSS feed unavailable (HTTP 503)',
    'Upstream response too large',
  ]) {
    assert.equal(translateFeedError(text), text);
    assert.equal(translateStatusLine(text), text);
  }
});

for (const locale of ['es', 'ru']) {
  test(`${locale}: a lone feed problem translates like a joined one`, () => {
    inLocale(locale, () => {
      const lone = translateFeedError('feed 1090 unreachable');
      assert.doesNotMatch(lone, /unreachable/, lone);
      assert.equal(
        translateFeedError('feed 1090 unreachable · 2 heard').split(' · ')[0],
        lone,
      );
    });
  });

  test(`${locale}: a feed with no band is named in the UI language`, () => {
    inLocale(locale, () => {
      const shown = translateFeedError('feeds 1090, entry 2 invalid');
      assert.doesNotMatch(shown, /\b(entry|invalid)\b/, shown);
      assert.ok(shown.includes(t('entry {n}', { n: 2 })), shown);
      assert.ok(shown.includes('1090'), shown);
    });
  });

  test(`${locale}: a quiet transit feed keeps its name and numbers`, () => {
    inLocale(locale, () => {
      const shown = translateStatusLine('TTC 0 · GO Transit 4 (95s old)');
      assert.doesNotMatch(shown, /\bold\b/, shown);
      assert.ok(shown.startsWith('TTC 0 · GO Transit 4 '), shown);
      assert.ok(shown.includes('95'), shown);
    });
  });

  test(`${locale}: a known error shows its catalog entry`, () => {
    inLocale(locale, () => {
      const text = 'Upstream response too large';
      assert.notEqual(t(text), text, 'the catalog has the entry');
      assert.equal(translateFeedError(text), t(text));
    });
  });
}

// A layer's coverage note when no feed covers the view: one sentence with a
// " · " in it (transit/queries.js, bikeshare/controls.js).
const COVERAGE_NOTES = [
  'Fly below 2,850 km to a covered region',
  'No feed here yet · 16 regions available',
  'Fly below 48 km to a covered city',
  'No bike share here yet · 61 systems available',
];

test('en: coverage notes show as they came', () => {
  setLocale('en');
  for (const text of COVERAGE_NOTES)
    assert.equal(translateStatusMessage(text), text);
  assert.equal(
    translateStatusMessage('No bike share here yet · 1 systems available'),
    'No bike share here yet · 1 system available',
  );
});

for (const locale of ['es', 'ru', 'ja']) {
  test(`${locale}: a coverage note translates whole, numbers kept`, () => {
    inLocale(locale, () => {
      for (const text of COVERAGE_NOTES) {
        const shown = translateStatusMessage(text);
        assert.doesNotMatch(
          shown,
          /\b(Fly|below|covered|feed|bike share|available)\b/,
          shown,
        );
        const number = /[\d,]+(?= km| regions| systems)/.exec(text)[0];
        assert.ok(
          shown.replace(/[^\d]/g, '').includes(number.replace(/,/g, '')),
          shown,
        );
      }
    });
  });

  test(`${locale}: a status message without a coverage note keeps its other forms`, () => {
    inLocale(locale, () => {
      assert.equal(
        translateStatusMessage('Upstream response too large'),
        t('Upstream response too large'),
      );
      assert.equal(
        translateStatusMessage('2 feeds live · 14 heard'),
        translateStatusLine('2 feeds live · 14 heard'),
      );
    });
  });
}

// Swedish fork: while CelesTrak's usage policy keeps the proxy from asking,
// the satellites row says until when (satellites/ingestion.js).
const PAUSE_NOW = Date.parse('2026-11-22T12:00:00Z'); // Sunday 13:00 in Stockholm
const PAUSED_TODAY = celestrakPausedError(Date.parse('2026-11-22T13:05:00Z'));
const PAUSED_TOMORROW = celestrakPausedError(
  Date.parse('2026-11-23T12:00:00Z'),
);

test('sv: a CelesTrak pause ends in local time, with the weekday when not today', (t) => {
  t.mock.method(Date, 'now', () => PAUSE_NOW);
  inLocale('sv', () => {
    assert.equal(
      translateFeedError(PAUSED_TODAY),
      'CelesTrak pausad till 14:05 (deras användarregler)',
    );
    assert.equal(
      translateFeedError(PAUSED_TOMORROW),
      'CelesTrak pausad till mån 13:00 (deras användarregler)',
    );
  });
});

test('a CelesTrak pause is told in every language, in at most 72 characters', (t) => {
  t.mock.method(Date, 'now', () => PAUSE_NOW);
  for (const locale of [
    'en',
    'sv',
    'ar',
    'de',
    'es',
    'fr',
    'he',
    'it',
    'ja',
    'pt',
    'ru',
    'uk',
    'zh-CN',
    'zh-Hant',
  ])
    inLocale(locale, () => {
      for (const text of [PAUSED_TODAY, PAUSED_TOMORROW]) {
        const shown = translateFeedError(text);
        assert.ok(shown.length <= 72, `${locale}: ${shown.length} ${shown}`);
        assert.match(shown, /CelesTrak/, `${locale}: ${shown}`);
        assert.doesNotMatch(shown, /2026|T\d\d:/, `${locale}: ${shown}`);
        if (locale !== 'en')
          assert.doesNotMatch(
            shown,
            /paused until|usage policy/,
            `${locale}: ${shown}`,
          );
      }
    });
});

// Swedish fork: groups the proxy no longer asks CelesTrak for, CelesTrak
// having answered 404 (satellites/ingestion.js).
const missing = (n) =>
  `${n} CelesTrak group${n === 1 ? '' : 's'} missing (CelesTrak answered 404)`;

test('sv: groups CelesTrak answered 404 for are told as missing', () => {
  inLocale('sv', () => {
    assert.equal(
      translateFeedError(missing(1)),
      '1 CelesTrak-grupp saknas (CelesTrak svarade 404)',
    );
    assert.equal(
      translateFeedError(missing(11)),
      '11 CelesTrak-grupper saknas (CelesTrak svarade 404)',
    );
  });
});

test('missing groups are told in every language, every plural form, in at most 72 characters', () => {
  for (const locale of [
    'en',
    'sv',
    'ar',
    'de',
    'es',
    'fr',
    'he',
    'it',
    'ja',
    'pt',
    'ru',
    'uk',
    'zh-CN',
    'zh-Hant',
  ])
    inLocale(locale, () => {
      // 0, 1, 2, few, many and other in the languages that tell them apart.
      for (const n of [0, 1, 2, 3, 5, 11, 21, 100, 1_000_000]) {
        const shown = translateFeedError(missing(n));
        assert.ok(shown.length <= 72, `${locale}: ${shown.length} ${shown}`);
        assert.match(shown, /CelesTrak/, `${locale}: ${shown}`);
        assert.match(shown, /404/, `${locale}: ${shown}`);
        if (locale !== 'en')
          assert.doesNotMatch(shown, /missing|answered/, `${locale}: ${shown}`);
      }
    });
});

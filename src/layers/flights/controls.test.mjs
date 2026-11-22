// Swedish fork: the flights row tells what adsb.lol's daily quota allows.
import assert from 'node:assert/strict';
import test from 'node:test';
import { setLocale } from '../../i18n/index.js';
import { createControls, flightsQuotaRow } from './controls.js';

// Lock ends are local times: read them as a Swedish user would.
process.env.TZ = 'Europe/Stockholm';

const NOW = Date.parse('2026-11-22T12:00:00Z'); // 13:00 in Stockholm
const MINUTE = 60_000;
const TOMORROW = Date.parse('2026-11-23T12:00:00Z'); // Monday 13:00
/** The point asked about, and the anchor of its own 0.25° cell's disc. */
const STOCKHOLM = { latitude: 59.33, longitude: 18.07 };
const OWN_DISC = { latitude: 59.25, longitude: 18.0 };
/** A neighbouring cell 28 km from the disc: still the same place. */
const NEARBY = { latitude: 59.45, longitude: 18.3 };
/** Göteborg's disc, 394 km from Stockholm. */
const GOTEBORG_DISC = { latitude: 57.75, longitude: 12.0 };
const quota = (fields = {}) => ({
  used: 12,
  limit: 450,
  keyed: false,
  keyRefused: false,
  lockedUntil: null,
  cache: 'MISS',
  gapMs: null,
  anchor: OWN_DISC,
  asked: STOCKHOLM,
  ...fields,
});
const row = (fields = {}) =>
  flightsQuotaRow({
    source: 'adsb.lol',
    count: 137,
    observedAtMs: NOW - 20_000,
    quota: quota(),
    now: NOW,
    ...fields,
  });
const KEYLESS =
  'Utan nyckel 500 anrop/dygn; en gratis nyckel under KOPPLA PÅ ger fler.';
const BUDGET = '12 av 450 anrop använda det senaste dygnet.';
const OLDER =
  'Inget nytt från adsb.lol just nu; data som redan lästs i närheten visas.';
const NOTHING_NEW =
  'Inget nytt kom in; plan äldre än 30 minuter tas bort från kartan.';

function inLocale(t, locale) {
  setLocale(locale);
  t.after(() => setLocale('en'));
}

test('sv: the row says what is shown and around where, and what a key gives', (t) => {
  inLocale(t, 'sv');
  const fresh = row();
  assert.equal(fresh.info, 'adsb.lol · 250 NM runt kartans mitt · 137 plan');
  assert.equal(fresh.infoTitle, `${KEYLESS} ${BUDGET}`);
  assert.equal(
    row({ count: 1 }).info,
    'adsb.lol · 250 NM runt kartans mitt · 1 plan',
  );
  assert.equal(
    row({ cockpit: true, count: 12 }).info,
    'adsb.lol · 250 NM runt ditt plan · 12 plan',
  );
  assert.equal(
    row({ quota: quota({ keyed: true, used: 3, limit: 950 }) }).infoTitle,
    'Med din adsb.lol-nyckel frågar appen upp till 950 gånger per dygn. 3 av 950 anrop använda det senaste dygnet.',
  );
});

test('sv: a paced disc says its age on the line and why in the tooltip, only while the last poll was answered', (t) => {
  inLocale(t, 'sv');
  const paced = row({
    observedAtMs: NOW - 3 * MINUTE - 10_000,
    quota: quota({ cache: 'PACED' }),
  });
  assert.equal(
    paced.info,
    'adsb.lol · 250 NM runt kartans mitt · 137 plan · för 3 min sedan',
  );
  assert.equal(
    paced.infoTitle,
    `Sparar dagens kvot: samma plats frågas igen först efter en paus. ${KEYLESS} ${BUDGET}`,
  );
  // Swedish fork: a neighbouring cell's paced disc tells how far off it was
  // read, though it is the same place.
  assert.equal(
    row({ quota: quota({ cache: 'PACED', asked: NEARBY }) }).infoTitle,
    `Sparar dagens kvot: samma plats frågas igen först efter en paus. Läst runt en plats 28 km bort. ${KEYLESS} ${BUDGET}`,
  );
  // Ages round to the nearest minute; under half a minute none is told.
  for (const [ageMs, info] of [
    [29_000, 'adsb.lol · 250 NM runt kartans mitt · 137 plan'],
    [31_000, 'adsb.lol · 250 NM runt kartans mitt · 137 plan · för 1 min sedan'],
    [
      3 * MINUTE + 40_000,
      'adsb.lol · 250 NM runt kartans mitt · 137 plan · för 4 min sedan',
    ],
    // Past the hour, the age is in hours.
    [
      150 * MINUTE,
      'adsb.lol · 250 NM runt kartans mitt · 137 plan · för 3 h sedan',
    ],
  ])
    assert.equal(
      row({ observedAtMs: NOW - ageMs, quota: quota({ cache: 'PACED' }) })
        .info,
      info,
      String(ageMs),
    );
});

test('sv: data kept while adsb.lol is not asked, or read elsewhere, is older data from nearby, with its age', (t) => {
  inLocale(t, 'sv');
  const kept = row({
    observedAtMs: NOW - 70_000,
    quota: quota({ cache: 'STALE' }),
  });
  assert.equal(
    kept.info,
    'adsb.lol · äldre data från närheten · 137 plan · för 1 min sedan',
  );
  assert.equal(kept.infoTitle, `${OLDER} ${KEYLESS} ${BUDGET}`);
  assert.equal(
    row({ quota: quota({ cache: 'STALE' }) }).info,
    'adsb.lol · äldre data från närheten · 137 plan',
    'under half a minute old, no age',
  );
  const away = row({
    observedAtMs: NOW - 14 * MINUTE,
    quota: quota({ cache: 'STALE', anchor: GOTEBORG_DISC }),
  });
  assert.equal(
    away.info,
    'adsb.lol · äldre data från närheten · 137 plan · för 14 min sedan',
  );
  assert.equal(
    away.infoTitle,
    `${OLDER} Läst runt en plats 394 km bort. ${KEYLESS} ${BUDGET}`,
  );
});

test('sv: after a failed poll the row says adsb.lol is not answering, and of the disc still shown how old and how far off it is', (t) => {
  inLocale(t, 'sv');
  const failed = row({
    observedAtMs: NOW - 6 * MINUTE,
    quota: quota({ cache: 'STALE', failed: true }),
  });
  assert.equal(
    failed.info,
    'adsb.lol svarar inte · äldre data · 137 plan · för 6 min sedan',
  );
  assert.equal(failed.infoTitle, `${NOTHING_NEW} ${KEYLESS} ${BUDGET}`);
  // Judged against the place the failed poll asked about.
  const far = row({
    observedAtMs: NOW - 2 * MINUTE,
    quota: quota({
      failed: true,
      cache: null,
      asked: { latitude: 67.85, longitude: 20.22 },
    }),
  });
  assert.equal(
    far.info,
    'adsb.lol svarar inte · äldre data · 137 plan · för 2 min sedan',
  );
  assert.equal(
    far.infoTitle,
    `${NOTHING_NEW} Läst runt en plats 964 km bort. ${KEYLESS} ${BUDGET}`,
  );
  // In Cockpit too: nothing new is no aircraft's surroundings.
  assert.equal(
    row({
      cockpit: true,
      observedAtMs: NOW - 2 * MINUTE,
      quota: quota({ failed: true, cache: null }),
    }).info,
    'adsb.lol svarar inte · äldre data · 137 plan · för 2 min sedan',
  );
  // Past the cap the aircraft are gone, and the row says so.
  assert.equal(
    row({
      count: 0,
      observedAtMs: null,
      quota: quota({ failed: true, cache: null, anchor: null }),
    }).info,
    'adsb.lol svarar inte · inga plan visas',
  );
  // A spent quota says more than a failure.
  assert.equal(
    row({
      quota: quota({ failed: true, lockedUntil: TOMORROW, cache: null }),
    }).info,
    'adsb.lol: dagens kvot är slut, åter mån 13:00',
  );
});

test('sv: a refused key says so on the line; the tooltip says how old the aircraft are and that calls go without it meanwhile', (t) => {
  inLocale(t, 'sv');
  const refused = row({
    observedAtMs: NOW - 3 * MINUTE,
    quota: quota({ keyRefused: true, cache: 'STALE' }),
  });
  assert.equal(
    refused.info,
    'adsb.lol nekade nyckeln – kontrollera den under KOPPLA PÅ',
  );
  assert.equal(
    refused.infoTitle,
    `${OLDER} Planen som visas lästes för 3 min sedan. Till dess frågar appen utan nyckel (500 anrop/dygn). ${BUDGET}`,
  );
  assert.equal(
    row({ quota: quota({ keyRefused: true }) }).infoTitle,
    `Till dess frågar appen utan nyckel (500 anrop/dygn). ${BUDGET}`,
    'no word of a key that works',
  );
});

test('sv: with the day’s quota spent the row says when the feed is back, in local time', (t) => {
  inLocale(t, 'sv');
  const lockedUntil = Date.parse('2026-11-22T13:05:00Z');
  assert.equal(
    row({
      count: 80,
      observedAtMs: NOW - 25 * MINUTE,
      quota: quota({ lockedUntil, cache: 'STALE' }),
    }).info,
    'adsb.lol: dagens kvot är slut, åter 14:05 · för 25 min sedan',
  );
  assert.equal(
    row({ count: 0, observedAtMs: null, quota: quota({ lockedUntil }) }).info,
    'adsb.lol: dagens kvot är slut, åter 14:05',
  );
  // A lock that ends tomorrow names the day.
  assert.equal(
    row({ count: 0, quota: quota({ lockedUntil: TOMORROW }) }).info,
    'adsb.lol: dagens kvot är slut, åter mån 13:00',
  );
  // Locked, a paced disc saves nothing: no reason in the tooltip.
  assert.equal(
    row({ quota: quota({ lockedUntil, cache: 'PACED' }) }).infoTitle,
    `${KEYLESS} ${BUDGET}`,
  );
  // Once the lock has passed, the ordinary line again.
  assert.equal(
    row({ quota: quota({ lockedUntil: NOW - 1 }) }).info,
    'adsb.lol · 250 NM runt kartans mitt · 137 plan',
  );
});

test('the whole line stays within 72 characters in every language and state', (t) => {
  const counted = quota({ used: 12345, limit: 12345 });
  const states = {
    fresh: { observedAtMs: NOW - 20_000, quota: counted },
    paced: {
      observedAtMs: NOW - 59 * MINUTE,
      quota: { ...counted, cache: 'PACED' },
    },
    hours: {
      observedAtMs: NOW - 23 * 60 * MINUTE,
      quota: { ...counted, cache: null },
    },
    cockpit: {
      cockpit: true,
      observedAtMs: NOW - 59 * MINUTE,
      quota: { ...counted, cache: 'PACED' },
    },
    older: {
      observedAtMs: NOW - 59 * MINUTE,
      quota: { ...counted, cache: 'STALE', anchor: GOTEBORG_DISC },
    },
    locked: {
      observedAtMs: NOW - 59 * MINUTE,
      quota: { ...counted, lockedUntil: TOMORROW, cache: 'STALE' },
    },
    lockedHours: {
      observedAtMs: NOW - 23 * 60 * MINUTE,
      quota: { ...counted, lockedUntil: TOMORROW, cache: null },
    },
    lockedEmpty: {
      count: 0,
      observedAtMs: null,
      quota: { ...counted, lockedUntil: TOMORROW },
    },
    failed: {
      observedAtMs: NOW - 59 * MINUTE,
      quota: { ...counted, cache: 'STALE', failed: true },
    },
    failedHours: {
      observedAtMs: NOW - 23 * 60 * MINUTE,
      quota: { ...counted, cache: null, failed: true },
    },
    failedEmpty: {
      count: 0,
      observedAtMs: NOW - 59 * MINUTE,
      quota: { ...counted, cache: null, failed: true },
    },
    refusedKey: {
      observedAtMs: NOW - 59 * MINUTE,
      quota: { ...counted, keyRefused: true, cache: 'STALE' },
    },
  };
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
  ]) {
    inLocale(t, locale);
    for (const [name, state] of Object.entries(states)) {
      const { info } = row({ count: 12345, ...state });
      assert.ok(info.length <= 72, `${locale} ${name}: ${info.length} ${info}`);
    }
  }
});

test('en: the same lines in English', () => {
  setLocale('en');
  assert.equal(
    row({ count: 1 }).info,
    'adsb.lol · 250 nm around the map centre · 1 aircraft',
  );
  assert.equal(
    row({
      observedAtMs: NOW - 3 * MINUTE,
      quota: quota({ cache: 'PACED' }),
    }).info,
    'adsb.lol · 250 nm around the map centre · 137 aircraft · 3 min ago',
  );
  assert.equal(
    row({ observedAtMs: NOW - 4 * MINUTE, quota: quota({ cache: 'STALE' }) })
      .info,
    'adsb.lol · older data from nearby · 137 aircraft · 4 min ago',
  );
  assert.equal(
    row({
      observedAtMs: NOW - 4 * MINUTE,
      quota: quota({ cache: null, failed: true }),
    }).info,
    'adsb.lol is not answering · older data · 137 aircraft · 4 min ago',
  );
  assert.equal(
    row({ quota: quota({ keyRefused: true }) }).info,
    'adsb.lol refused the key – check it under POWER UP',
  );
  assert.equal(
    row().infoTitle,
    'Without a key 500 calls a day; a free key under POWER UP gives more. 12 of 450 calls used in the last 24 hours.',
  );
});

test('another source, or no word from the server, says nothing it cannot know', () => {
  setLocale('en');
  assert.equal(
    row({ source: 'OpenSky Network', quota: null }),
    null,
    'OpenSky mode has no adsb.lol line',
  );
  const unknown = row({ quota: null, count: 0, observedAtMs: null });
  assert.equal(
    unknown.info,
    'adsb.lol · 250 nm around the map centre · 0 aircraft',
  );
  assert.equal(unknown.infoTitle, '', 'no budget heard of yet');
});

test('the layer row reads the feed it was given', () => {
  setLocale('en');
  const flightState = {
    _cockpitContactMode: false,
    feed: {
      _lastSource: 'adsb.lol',
      _count: 2,
      _lastUpdate: Date.now(),
      _lastQuota: quota(),
    },
  };
  const { getRowControls } = createControls({ flightState }).methods;
  const controls = getRowControls();
  assert.deepEqual(controls.chips, []);
  assert.deepEqual(controls.legend, []);
  assert.equal(
    controls.info,
    'adsb.lol · 250 nm around the map centre · 2 aircraft',
  );
  flightState.feed._lastSource = 'OpenSky Network';
  flightState.feed._lastQuota = null;
  assert.equal(getRowControls(), null);
});

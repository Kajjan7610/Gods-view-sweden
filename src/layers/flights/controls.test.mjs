// Swedish fork: the flights row tells what adsb.lol's daily quota allows.
import assert from 'node:assert/strict';
import test from 'node:test';
import { formatNumber, setLocale } from '../../i18n/index.js';
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
    // Swedish fork: a whole view read from several discs: all of it, or
    // about how much, and up to how old.
    wholeView: {
      observedAtMs: NOW - 59 * MINUTE,
      quota: {
        ...counted,
        discs: { shown: 6, total: 6 },
        view: { covered: 100, clipped: false },
      },
    },
    wholeViewOuter: {
      observedAtMs: NOW - 20_000,
      quota: {
        ...counted,
        discs: { shown: 6, total: 6 },
        view: { covered: 100, clipped: false },
        outerReadAt: NOW - 59 * MINUTE,
      },
    },
    partOfView: {
      observedAtMs: NOW - 59 * MINUTE,
      quota: {
        ...counted,
        discs: { shown: 5, total: 6 },
        view: { covered: 99, clipped: true },
      },
    },
    partOfViewOuter: {
      observedAtMs: NOW - 20_000,
      quota: {
        ...counted,
        discs: { shown: 5, total: 6 },
        view: { covered: 99, clipped: true },
        outerReadAt: NOW - 59 * MINUTE,
      },
    },
    wholeViewNearest: {
      observedAtMs: NOW - 20_000,
      quota: {
        ...counted,
        discs: { shown: 6, total: 6 },
        view: { covered: 100, clipped: false },
        outerReadAt: NOW - 59 * MINUTE,
        capped: { count: 12345, of: 12345 },
      },
    },
    partOfViewNearest: {
      observedAtMs: NOW - 20_000,
      quota: {
        ...counted,
        discs: { shown: 5, total: 6 },
        view: { covered: 99, clipped: true },
        outerReadAt: NOW - 59 * MINUTE,
        capped: { count: 12345, of: 12345 },
      },
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


// Swedish fork: a whole view, read from a centre disc and outer discs that
// share the flights' pace (with a key and five outer discs, every 442 s and
// every 884 s).
const MIDDLE =
  'Utzoomat läses mitten av vyn med ungefär 7 min mellanrum och de yttre områdena med ungefär 15 min, så att dagens kvot räcker hela dagen.';
const REST = 'De andra områdena läses ett i taget, det närmaste först.';
const view = (fields = {}) =>
  quota({
    cache: 'PACED',
    discs: { shown: 6, total: 6, kept: 6 },
    gaps: { centreMs: 442_000, outerMs: 884_000 },
    view: { covered: 100, clipped: false },
    ...fields,
  });
/** The Swedish percent, as Intl writes it. */
const percent = (n) =>
  formatNumber(n / 100, { style: 'percent', maximumFractionDigits: 0 });

test('sv: the whole view only when nothing of it is left out or cut away, else about how much, and up to how old', (t) => {
  inLocale(t, 'sv');
  const fresh = row({ quota: view({ outerReadAt: NOW - 20_000 }) });
  assert.equal(fresh.info, 'adsb.lol · hela vyn · 137 plan');
  assert.equal(fresh.infoTitle, `${MIDDLE} ${KEYLESS} ${BUDGET}`);
  assert.equal(
    row({ quota: view({ outerReadAt: NOW - 24 * MINUTE }) }).info,
    'adsb.lol · hela vyn · 137 plan · upp till 24 min gamla',
  );
  // The middle older than every outer area: the oldest is still told.
  assert.equal(
    row({
      observedAtMs: NOW - 3 * MINUTE,
      quota: view({ outerReadAt: NOW - 2 * MINUTE }),
    }).info,
    'adsb.lol · hela vyn · 137 plan · upp till 3 min gamla',
  );
  // Sweden's box zoomed out: six discs leave its corners out.
  const sweden = row({
    quota: view({
      view: { covered: 82, clipped: false },
      outerReadAt: NOW - 14 * MINUTE,
    }),
  });
  assert.equal(
    sweden.info,
    `adsb.lol · ca ${percent(82)} av vyn · 137 plan · upp till 14 min gamla`,
  );
  // A view cut to the box around the map centre is never all of it.
  const cut = row({ quota: view({ view: { covered: 99, clipped: true } }) });
  assert.equal(cut.info, `adsb.lol · ca ${percent(99)} av vyn · 137 plan`);
  assert.equal(
    cut.infoTitle,
    `${MIDDLE} Bara den del av vyn som ligger inom ${formatNumber(1500)} km från kartans mitt läses. ${KEYLESS} ${BUDGET}`,
  );
  // Still filling: the rest are read one at a time.
  const filling = row({
    quota: view({
      discs: { shown: 2, total: 6, kept: 6 },
      view: { covered: 41, clipped: false },
    }),
  });
  assert.equal(filling.info, `adsb.lol · ca ${percent(41)} av vyn · 137 plan`);
  assert.equal(filling.infoTitle, `${MIDDLE} ${REST} ${KEYLESS} ${BUDGET}`);
});

test('sv: past the most aircraft an answer gives, the line says how many of the nearest, and the tooltip how old', (t) => {
  inLocale(t, 'sv');
  const nearest = row({
    quota: view({
      outerReadAt: NOW - 24 * MINUTE,
      capped: { count: 2000, of: 2513 },
    }),
  });
  assert.equal(
    nearest.info,
    `adsb.lol · hela vyn · ${formatNumber(2000)} närmaste av ${formatNumber(2513)} plan`,
  );
  assert.equal(
    nearest.infoTitle,
    `${MIDDLE} Av ${formatNumber(2513)} plan som lästs runt vyn visas de ${formatNumber(2000)} som är närmast kartans mitt. Planen som visas lästes för upp till 24 min sedan. ${KEYLESS} ${BUDGET}`,
  );
});

test('sv: while the outer areas are held back, the tooltip says so and never that they are read', (t) => {
  inLocale(t, 'sv');
  const held = row({
    quota: view({
      discs: { shown: 3, total: 6, kept: 6 },
      view: { covered: 55, clipped: false },
      outerHeld: true,
    }),
  });
  assert.equal(
    held.infoTitle,
    `Utzoomat läses mitten av vyn med ungefär 7 min mellanrum; de yttre områdena läses inte just nu, och det som lästs står kvar i upp till 30 minuter. ${KEYLESS} ${BUDGET}`,
  );
});

test('a whole view gives way to every line that says more, and is never said in Cockpit', (t) => {
  inLocale(t, 'sv');
  const outer = { outerReadAt: NOW - 24 * MINUTE };
  assert.equal(
    row({ quota: view({ ...outer, cache: 'STALE' }) }).info,
    'adsb.lol · äldre data från närheten · 137 plan',
  );
  assert.equal(
    row({ quota: view({ ...outer, failed: true, cache: null }) }).info,
    'adsb.lol svarar inte · äldre data · 137 plan',
  );
  assert.equal(
    row({ quota: view({ ...outer, lockedUntil: TOMORROW }) }).info,
    'adsb.lol: dagens kvot är slut, åter mån 13:00',
  );
  assert.equal(
    row({ quota: view({ ...outer, keyRefused: true }) }).info,
    'adsb.lol nekade nyckeln – kontrollera den under KOPPLA PÅ',
  );
  assert.equal(
    row({ cockpit: true, quota: view(outer) }).info,
    'adsb.lol · 250 NM runt ditt plan · 137 plan',
  );
  assert.equal(
    row({ quota: view({ ...outer, discs: { shown: 1, total: 1 } }) }).info,
    'adsb.lol · 250 NM runt kartans mitt · 137 plan',
    'one disc is the disc around the map centre',
  );
  assert.equal(
    row({ quota: view({ ...outer, view: undefined }) }).info,
    'adsb.lol · 250 NM runt kartans mitt · 137 plan',
    'without word of how much is covered, never the whole view',
  );
});

test('en: the whole view in English', () => {
  setLocale('en');
  assert.equal(
    row({ quota: view({ outerReadAt: NOW - 24 * MINUTE }) }).info,
    'adsb.lol · whole view · 137 aircraft · up to 24 min old',
  );
  assert.equal(
    row({ quota: view({ view: { covered: 82, clipped: false } }) }).info,
    'adsb.lol · about 82% of the view · 137 aircraft',
  );
  assert.equal(
    row({ quota: view({ capped: { count: 2000, of: 2513 } }) }).info,
    'adsb.lol · whole view · nearest 2,000 of 2,513 aircraft',
  );
});

test('sv: zoomed out without a key, the tooltip says how often the middle is read and how many areas the quota keeps', (t) => {
  inLocale(t, 'sv');
  // Without a key the pace keeps two of five outer discs: three of six areas.
  const keyless = row({
    quota: view({
      discs: { shown: 3, total: 6, kept: 3 },
      gaps: { centreMs: 533_000, outerMs: 1_067_000 },
      view: { covered: 55, clipped: false },
      outerReadAt: NOW - 17 * MINUTE,
    }),
  });
  assert.equal(
    keyless.info,
    `adsb.lol · ca ${percent(55)} av vyn · 137 plan · upp till 17 min gamla`,
  );
  assert.equal(
    keyless.infoTitle,
    `Utzoomat läses mitten av vyn med ungefär 9 min mellanrum och de yttre områdena med ungefär 18 min, så att dagens kvot räcker hela dagen. Dagens kvot räcker till att hålla områdena närmast kartans mitt aktuella, 3 av 6; de andra läses inte. ${KEYLESS} ${BUDGET}`,
  );
  // With none kept, only the middle, at the flights' own pace.
  const centre = row({
    quota: view({
      discs: { shown: 1, total: 6, kept: 1 },
      gaps: { centreMs: 600_000, outerMs: null },
      view: { covered: 27, clipped: false },
    }),
  });
  assert.equal(
    centre.infoTitle,
    `Dagens kvot räcker till att hålla bara området runt kartans mitt aktuellt; de andra läses inte. ${KEYLESS} ${BUDGET}`,
  );
  // Still filling: the rest are read one at a time.
  assert.equal(
    row({
      quota: view({
        discs: { shown: 2, total: 6, kept: 3 },
        view: { covered: 41, clipped: false },
      }),
    }).infoTitle,
    `${MIDDLE} Dagens kvot räcker till att hålla områdena närmast kartans mitt aktuella, 3 av 6; de andra läses inte. ${REST} ${KEYLESS} ${BUDGET}`,
  );
});

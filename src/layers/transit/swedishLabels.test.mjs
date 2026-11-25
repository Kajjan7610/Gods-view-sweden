// Swedish fork: the transit layer's map labels and card speak the reader's
// language and never show a raw id. The detection field ("BUS WAITING",
// "RAIL STOPPED") was built in English whatever the language; a vehicle
// without a route or fleet number went by its database key
// ("90310059900001…"); and the card's first line said "Stockholm, Sweden".
import assert from 'node:assert/strict';
import test from 'node:test';
import { createQueries } from './queries.js';
import {
  TRANSIT_MODE_COLORS,
  buildTransitSelectionCopy,
  transitDetectionClass,
  transitDetectionId,
  transitDetectionMetric,
  transitModeAbbr,
} from './policy.js';
import {
  getRegisteredTransitFeed,
  getTransitFeed,
} from '../../data/transitFeeds.js';
import { setLocale, t } from '../../i18n/index.js';

const SL = getRegisteredTransitFeed('trafiklab-sl');
/** English mode and motion words, as the detection field wrote them. */
const ENGLISH_WORDS =
  /\b(BUS|TROLLEY|TRAM|CABLE|METRO|MONO|RAIL|FUNI|GONDOLA|FERRY|TRANSIT|EN ROUTE|STOPPED|WAITING|NO FIX)\b/;

/** The playback sample behind each motion word (movement.js, displayMotion). */
const SAMPLES = Object.freeze({
  'EN ROUTE': { phase: 'playing', motion: 'moving', latestReportAgeMs: 5_000 },
  STOPPED: { phase: 'playing', motion: 'stopped', latestReportAgeMs: 5_000 },
  // No sample yet: the vehicle waits for its next report.
  WAITING: undefined,
  // A newest report older than 90 s.
  'NO FIX': {
    phase: 'playing',
    motion: 'moving',
    latestReportAgeMs: 300_000,
  },
});

/** An SL vehicle on screen, doing what `word` says. */
function vehicle(id, mode, word, record = {}) {
  return {
    key: `trafiklab-sl:${id}`,
    feedId: 'trafiklab-sl',
    mode,
    record: { id, ...record },
    sample: SAMPLES[word],
    marker: {
      position: { x: 1, y: 2, z: 3 },
      show: true,
      width: 20,
      height: 20,
    },
  };
}

/** The layer state with these vehicles drawn, as the detection overlay sees it. */
function stateOf(vehicles) {
  return {
    _enabled: true,
    _markersShown: true,
    _vehicles: new Map(vehicles.map((entry) => [entry.key, entry])),
    _visible: new Set(vehicles),
    _activeFeeds: new Map(),
    _detectBuiltAt: -Infinity,
    _detectRevision: 0,
    _detectCache: null,
    _selectedKey: null,
  };
}

/** What the detection overlay is handed for these vehicles, as it pulls it. */
function detections(vehicles) {
  return createQueries({
    state: stateOf(vehicles),
    parts: {},
  }).methods.getDetectableObjects();
}

const fleet = () => [
  vehicle('1', 'bus', 'WAITING', { label: '4057' }),
  vehicle('2', 'tram', 'EN ROUTE', { routeId: 'tram:7' }),
  vehicle('3', 'subway', 'STOPPED', { routeId: 'subway:17' }),
  vehicle('4', 'rail', 'NO FIX', { routeId: 'rail:41' }),
  vehicle('5', 'ferry', 'EN ROUTE', { routeId: 'ferry:80' }),
];

test('Swedish map labels carry no English mode or motion word', () => {
  setLocale('sv');
  try {
    const contacts = detections(fleet());
    assert.equal(contacts.length, 5);
    for (const contact of contacts)
      assert.doesNotMatch(
        `${contact.id} ${contact.klass} ${contact.metric}`,
        ENGLISH_WORDS,
      );
    assert.deepEqual(
      contacts.map((contact) => contact.metric),
      [
        'BUSS VÄNTAR PÅ DATA',
        'SPÅRVAGN PÅ VÄG',
        'T-BANA STÅR STILL',
        'TÅG INAKTUELL',
        'FÄRJA PÅ VÄG',
      ],
    );
    assert.equal(contacts[0].klass, 'BUSS SL');
  } finally {
    setLocale('en');
  }
  // In English the field reads as it always has.
  assert.deepEqual(
    detections(fleet()).map((contact) => contact.metric),
    [
      'BUS WAITING',
      'TRAM EN ROUTE',
      'METRO STOPPED',
      'RAIL NO FIX',
      'FERRY EN ROUTE',
    ],
  );
});

test('the translated words start from the shared English table', () => {
  // The fork's word list follows TRANSIT_MODE_ABBR: a mode added there
  // without a word here would read "TRANSIT".
  for (const mode of [...Object.keys(TRANSIT_MODE_COLORS), 'spaceship'])
    assert.equal(transitDetectionClass(mode, null), transitModeAbbr(mode));
  // An operator's own word is a name and stays as it is.
  const ttc = getTransitFeed('ttc-toronto');
  setLocale('sv');
  try {
    assert.equal(
      transitDetectionMetric({ mode: 'tram' }, 'tram', 0, ttc, t),
      'STREETCAR VÄNTAR PÅ DATA',
    );
    assert.equal(transitDetectionClass('bus', ttc, t), 'BUSS TTC');
  } finally {
    setLocale('en');
  }
});

test('a bare long number never names a vehicle on the map or its card', () => {
  const key = '9031005990000123';
  const unjoined = '9011001000400000';
  // No route a rider knows and no fleet number: the operator.
  assert.equal(transitDetectionId({ id: key, routeId: unjoined }, SL), 'SL');
  assert.equal(transitDetectionId({ id: key }, SL), 'SL');
  // The fleet number before an unjoined route key.
  assert.equal(
    transitDetectionId({ id: key, label: '4057', routeId: unjoined }, SL),
    '4057',
  );
  // A joined route and a short id are names, as before.
  assert.equal(transitDetectionId({ id: key, routeId: 'bus:177' }, SL), '177');
  assert.equal(transitDetectionId({ id: '4400' }, null), '4400');
  const title = (record, translate) =>
    buildTransitSelectionCopy(
      SL,
      { timestamp: 0, ...record },
      'bus',
      0,
      null,
      null,
      translate,
    ).title;
  assert.equal(title({ id: key, routeId: unjoined }), '🚌 SL');
  assert.equal(
    title({ id: key, label: '4057', routeId: unjoined }),
    '🚌 Vehicle 4057',
  );
  assert.equal(title({ id: key, routeId: 'bus:177' }), '🚌 Route 177');
  setLocale('sv');
  try {
    assert.equal(
      title({ id: key, label: '4057', routeId: unjoined }, t),
      '🚌 Fordon 4057',
    );
  } finally {
    setLocale('en');
  }
});

test('a Swedish card names the county, not "…, Sweden"', () => {
  setLocale('sv');
  try {
    const copy = buildTransitSelectionCopy(
      SL,
      { id: '9031005990000123', routeId: 'bus:177', timestamp: 0 },
      'bus',
      0,
      null,
      null,
      t,
    );
    assert.equal(copy.details[0], 'Buss · SL · Stockholm');
    assert.doesNotMatch(copy.details.join(' | '), /Sweden/);
    // Trafikverket's national feed names no region, and leaves no " · ".
    const train = buildTransitSelectionCopy(
      getRegisteredTransitFeed('trafikverket-trains'),
      { id: '2861-20261121', routeId: '2861', timestamp: 0 },
      'rail',
      0,
      null,
      null,
      t,
    );
    assert.equal(train.details[0], 'Tåg · Trafikverket');
    assert.doesNotMatch(train.details.join(' | '), /Sweden/);
  } finally {
    setLocale('en');
  }
});

test('Chinese and Japanese labels keep the Latin words their box is sized for', () => {
  // detectionDraw.js sizes the label box per character for the Latin
  // monospace; CJK glyphs fall back to a wider font and overflowed it.
  for (const locale of ['ja', 'zh-CN', 'zh-Hant']) {
    setLocale(locale);
    try {
      assert.deepEqual(
        detections(fleet()).map((contact) => contact.metric),
        [
          'BUS WAITING',
          'TRAM EN ROUTE',
          'METRO STOPPED',
          'RAIL NO FIX',
          'FERRY EN ROUTE',
        ],
        locale,
      );
    } finally {
      setLocale('en');
    }
  }
});

test('the label words are looked up once per language, however many vehicles', () => {
  const lookups = [];
  const translate = (text, values) => {
    lookups.push(text);
    return t(text, values);
  };
  /** A refreshed detection list for `count` buses, waiting and moving. */
  const refreshFor = (count) => {
    const buses = Array.from({ length: count }, (_, i) =>
      vehicle(String(i), 'bus', i % 2 ? 'WAITING' : 'EN ROUTE', {
        routeId: `bus:${i}`,
      }),
    );
    const state = stateOf(buses);
    const queries = createQueries({ state, parts: {}, translate });
    lookups.length = 0;
    queries.methods.getDetectableObjects();
    // The label refresh between polls, as the overlay pulls it again.
    for (let pass = 0; pass < 3; pass += 1) {
      state._detectBuiltAt = -Infinity;
      queries.refreshDetectCache();
    }
    return lookups.length;
  };
  setLocale('sv');
  try {
    const few = refreshFor(4);
    assert.equal(few, 3, 'BUS, WAITING and EN ROUTE, once each');
    assert.equal(refreshFor(2_600), few, 'not one more for 2,600 buses');
  } finally {
    setLocale('en');
  }
  // A new language looks the words up again, once.
  assert.equal(refreshFor(40), 3);
});

test('a raw number is no fleet number for Context either', () => {
  const state = stateOf([
    vehicle('9031005990000777', 'bus', 'WAITING', {
      label: '9031005990000777',
      lat: 59.33,
      lon: 18.07,
    }),
  ]);
  const [record] = createQueries({
    state,
    parts: {},
  }).methods.getAnalystRecords();
  assert.equal(record.label, null);
  assert.equal(record.operator, 'SL');
});

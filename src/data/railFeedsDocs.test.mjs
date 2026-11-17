// The rail counts the documents state, against the registry: how many feeds
// there are, how many publish GPS or station reports, how many work out of
// the box, register trip updates or have a static GTFS, and one
// DATA_SOURCES.md row per feed, none for a feed the registry does not hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  RAIL_ENABLED_FEEDS,
  RAIL_FEED_REGISTRY,
  railFeedNeedsSchedulePack,
  railFeedPositions,
} from './railFeeds.js';

const read = (file) =>
  readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

const counts = {
  registry: RAIL_FEED_REGISTRY.length,
  gps: RAIL_FEED_REGISTRY.filter((feed) => railFeedPositions(feed) === 'gps')
    .length,
  stationReports: RAIL_FEED_REGISTRY.filter(
    (feed) => railFeedPositions(feed) === 'event',
  ).length,
  // Swedish fork: a feed that needs a key (Trafikverket) is not out of the
  // box either.
  outOfTheBox: RAIL_ENABLED_FEEDS.filter(
    (feed) => !railFeedNeedsSchedulePack(feed) && !feed.requiresKey,
  ).length,
  tripUpdates: RAIL_FEED_REGISTRY.filter(
    (feed) => typeof feed.tripUpdatesUrl === 'string',
  ).length,
  staticGtfs: RAIL_FEED_REGISTRY.filter(
    (feed) => typeof feed.staticGtfsUrl === 'string',
  ).length,
};

test('the registry holds the feeds the documents count', () => {
  // Swedish fork: the four feeds that publish no licence are not polled,
  // and Trafikverket's trains are added (they need the free key).
  assert.deepEqual(counts, {
    registry: 31,
    gps: 30,
    stationReports: 1,
    outOfTheBox: 24,
    tripUpdates: 22,
    staticGtfs: 29,
  });
  assert.equal(
    RAIL_ENABLED_FEEDS.length,
    27,
    'all but the four unlicensed, with Trafikverket',
  );
  assert.deepEqual(
    RAIL_FEED_REGISTRY.filter(
      (feed) => railFeedPositions(feed) === 'event',
    ).map((feed) => feed.id),
    ['irish-rail'],
    'the station reports are Irish Rail’s',
  );
});

test('DATA_SOURCES.md states the rail counts and has one row per feed', () => {
  const sources = read('DATA_SOURCES.md');
  const { registry, gps, outOfTheBox, tripUpdates, staticGtfs } = counts;
  for (const phrase of [
    `The registry lists ${registry} feeds: the original's ${registry - 1}, all switched on upstream, and the Swedish fork's Trafikverket feed. The Swedish fork polls ${RAIL_ENABLED_FEEDS.length} of them`,
    `${gps} feeds publish live GPS positions (SJ Nord's through SIRI VM), and Irish Rail reports the station or timing point a train last passed`,
    `${tripUpdates} feeds register trip updates`,
    `out of the box upstream, ${outOfTheBox} in the Swedish fork`,
    `(${staticGtfs} of the original's ${registry - 1} have one; Trafikverket has none)`,
  ])
    assert.ok(sources.includes(phrase), phrase);
  const rows = sources
    .split('\n')
    .filter((line) => /^\| \*\*.+\| Rail layer trains, /.test(line));
  assert.equal(rows.length, registry, 'one row per feed');
  for (const feed of RAIL_FEED_REGISTRY)
    assert.ok(
      rows.some((row) => row.includes(`| Rail layer trains, ${feed.region}:`)),
      `${feed.id} has a row`,
    );
});

test(
  'CURRENT-STATE.md states the rail counts',
  { skip: 'Swedish fork: docs/CURRENT-STATE.md keeps upstream counts' },
  () => {
    const state = read('docs/CURRENT-STATE.md');
    const { registry, gps, outOfTheBox, tripUpdates, staticGtfs } = counts;
    for (const phrase of [
      `(${registry} keyless feeds, all on, ${outOfTheBox} out of the box;`,
      `The registry lists ${registry} feeds, all`,
      `a host that has built nothing shows ${outOfTheBox} feeds`,
      `By position source, ${gps} feeds publish live GPS.`,
      'Irish Rail publishes the\nstation or timing point the signalling last reported.',
      `${tripUpdates} feeds register trip updates;`,
      `that has a static GTFS (${staticGtfs} of the ${registry})`,
    ])
      assert.ok(state.includes(phrase), phrase);
  },
);

test(
  'README.md states the rail counts',
  { skip: 'Swedish fork: the README describes the Swedish layers' },
  () => {
    const readme = read('README.md');
    const { registry, gps, outOfTheBox } = counts;
    const phrase = `from ${registry} keyless operator feeds: live GPS positions from ${gps} of them and Irish Rail’s station reports, ${outOfTheBox} live out of the box`;
    assert.ok(readme.includes(phrase), phrase);
  },
);

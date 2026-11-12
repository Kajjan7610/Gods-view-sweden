// The Swedish fork leaves Sveriges Radio's channels out of the radio
// directory; every other station is read as before.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isSverigesRadioStation,
  normalizeRadioBrowserStation,
} from './radioBrowser.js';

const row = (overrides) => ({
  stationuuid: '96062a7b-0601-11e8-ae97-52543be04c81',
  name: 'Some Station',
  url_resolved: 'https://stream.example.com/live.mp3',
  homepage: 'https://example.com/',
  geo_lat: '59.33',
  geo_long: '18.06',
  lastcheckok: 1,
  hls: 0,
  codec: 'MP3',
  bitrate: 128,
  countrycode: 'SE',
  tags: 'pop',
  language: 'swedish',
  ...overrides,
});

test('Sveriges Radio’s channels are left out of the directory', () => {
  for (const overrides of [
    { name: 'Sveriges Radio P4 Stockholm', url_resolved: 'https://edge1.sr.se/p4stockholm-mp3-192' },
    { name: 'P4 Göteborg', url_resolved: 'https://live1.sr.se/p4gbg-aac-192' },
    { name: 'P1', homepage: 'https://www.sverigesradio.se/p1' },
    { name: 'Sveriges Radio P2' },
  ])
    assert.equal(normalizeRadioBrowserStation(row(overrides)), null, overrides.name);
});

test('other stations, Swedish ones included, are read as before', () => {
  const station = normalizeRadioBrowserStation(row({ name: 'Mix Megapol' }));
  assert.equal(station?.name, 'Mix Megapol');
  assert.equal(station?.countryCode, 'SE');
  // A host that only ends in the same letters is not SR's.
  assert.equal(
    isSverigesRadioStation({ name: 'X', streamUrl: 'https://radiousr.se/live' }),
    false,
  );
  assert.equal(isSverigesRadioStation({}), false);
});

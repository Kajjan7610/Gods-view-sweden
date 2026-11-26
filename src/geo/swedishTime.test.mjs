// Swedish fork: the HUD names Sweden's own clock over Sweden, UTC+1 in
// winter and UTC+2 in summer, and leaves the neighbours on other clocks
// (Finland, Åland, the Baltic states) to the original's estimate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stockholmOffsetHours, swedishZoneTag } from './swedishTime.js';

const WINTER = Date.UTC(2026, 0, 15, 12);
const SUMMER = Date.UTC(2026, 6, 15, 12);

test("Sweden's offset follows its summer time", () => {
  assert.equal(stockholmOffsetHours(WINTER), 1);
  assert.equal(stockholmOffsetHours(SUMMER), 2);
  // The switch: last Sunday of March 2026 at 01:00 UTC.
  assert.equal(stockholmOffsetHours(Date.UTC(2026, 2, 29, 0, 59)), 1);
  assert.equal(stockholmOffsetHours(Date.UTC(2026, 2, 29, 1, 0)), 2);
  assert.equal(stockholmOffsetHours(Number.NaN), null);
  // Year 50 reads as Stockholm's local mean time (UTC+1:12, rounded), not
  // a garbage offset; a time far BC names a real offset or none.
  assert.equal(
    stockholmOffsetHours(Date.UTC(2026, 6, 1) - 1976 * 365.25 * 864e5),
    1,
  );
  const farBack = stockholmOffsetHours(-8.64e15);
  assert.ok(farBack === null || (farBack >= -12 && farBack <= 14), farBack);
});

test('Swedish places get the Swedish clock, winter and summer', () => {
  for (const [name, lat, lon] of [
    ['Stockholm', 59.33, 18.07],
    ['Malmö', 55.6, 13.0],
    ['Göteborg', 57.71, 11.97],
    ['Visby', 57.64, 18.3],
    ['Gotska Sandön', 58.39, 19.2],
    ['Söderarm', 59.75, 19.4],
    ['Grisslehamn', 60.1, 18.8],
    ['Holmön', 63.8, 20.88],
    ['Umeå', 63.83, 20.26],
    ['Luleå', 65.58, 22.15],
    ['Haparanda', 65.836, 24.137],
    ['Pajala', 67.21, 23.37],
    ['Karesuando', 68.44, 22.48],
    ['Kiruna', 67.86, 20.23],
    ['Abisko', 68.35, 18.83],
    // A few km from the Könkämä, Muonio and Torne rivers, Swedish bank.
    ['Pajala kommun by the river', 67.95, 23.5],
    ['Övertorneå kommun by the river', 66.65, 23.75],
    ['Kiruna kommun by Könkämä', 69.0, 20.75],
    ['Haparanda Sandskär', 65.57, 23.75],
  ]) {
    assert.equal(swedishZoneTag(lat, lon, WINTER), 'UTC+1', name);
    assert.equal(swedishZoneTag(lat, lon, SUMMER), 'UTC+2', name);
  }
});

test('neighbours on the same clock may share it; others never do', () => {
  // Norway and Denmark keep Sweden's clock, so naming it there is true.
  assert.equal(swedishZoneTag(59.91, 10.75, SUMMER), 'UTC+2', 'Oslo');
  assert.equal(swedishZoneTag(55.68, 12.57, WINTER), 'UTC+1', 'Copenhagen');
  // Finland, Åland and the Baltic states are on UTC+2/+3: not Sweden's.
  for (const [name, lat, lon] of [
    ['Helsinki', 60.17, 24.94],
    ['Mariehamn', 60.1, 19.94],
    ['Eckerö', 60.22, 19.6],
    ['Lågskär', 59.84, 19.9],
    ['Turku', 60.45, 22.27],
    ['Vaasa', 63.1, 21.6],
    ['Valsörarna', 63.43, 21.07],
    ['Kemi', 65.74, 24.56],
    ['Oulu', 65.01, 25.47],
    ['Kolari', 67.33, 23.8],
    ['Kilpisjärvi', 69.05, 20.8],
    // A few km from the rivers, Finnish bank.
    ['Ylitornio', 66.3, 23.75],
    ['by Karunki', 66.1, 23.99],
    ['Ylitornio by the river', 66.285, 23.849],
    ['Enontekiö by Könkämä', 68.53, 22.15],
    ['Tornio', 65.848, 24.147],
    ['Tallinn', 59.44, 24.75],
    ['Ventspils', 57.39, 21.55],
    ['Liepāja', 56.51, 21.01],
    ['Klaipėda', 55.71, 21.13],
    ['Baltiysk', 54.65, 19.9],
  ]) {
    assert.equal(swedishZoneTag(lat, lon, SUMMER), null, name);
  }
});

test('no point, no tag', () => {
  assert.equal(swedishZoneTag(Number.NaN, 18, SUMMER), null);
  assert.equal(swedishZoneTag(59.33, 18.07, Number.NaN), null);
});

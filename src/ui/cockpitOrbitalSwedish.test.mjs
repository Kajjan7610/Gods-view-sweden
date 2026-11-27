// Swedish fork: in Swedish the orbit view's "JUST NU ÖVER" names a selection
// of seas, Finland's regions and towns in Swedish (src/data/
// swedishPlaceNames.js); a region or town only in its own country, so
// Naples, Florida stays Naples. Other names stay as Natural Earth spells
// them, and English is unchanged.
import '../testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPinia } from 'pinia';
import { createApp, nextTick } from 'vue';
import { setLocale } from '../i18n/index.js';
import { useCockpitStore } from './stores/cockpit.js';
import CockpitOrbital from './views/panels/CockpitOrbital.vue';
import {
  SWEDISH_PLACE_NAME_KEYS,
  TOWN_NAMES_SHARED,
  swedishRegionName,
  swedishSeaName,
  swedishTownName,
} from '../data/swedishPlaceNames.js';

const VIEW = Object.freeze({
  name: 'SENTINEL-2B',
  norad: 42063,
  owner: null,
  mission: null,
  altitudeKm: 786,
  speedKmS: 7.45,
});

const pack = (file) =>
  JSON.parse(
    readFileSync(
      new URL(`../data/local_data/natural_earth/${file}`, import.meta.url),
      'utf8',
    ),
  );

function mount(t) {
  const host = document.body.appendChild(document.createElement('div'));
  const pinia = createPinia();
  const app = createApp(CockpitOrbital).use(pinia);
  app.mount(host);
  t.after(() => {
    app.unmount();
    host.remove();
    setLocale('en');
  });
  const store = useCockpitStore(pinia);
  const over = () =>
    document.querySelector('#cockpit-orbital-over strong')?.textContent;
  return { store, over };
}

test('every name in the selection is a name the bundled packs use', () => {
  const seas = new Set(pack('marine.json').features.map((f) => f.name));
  for (const name of SWEDISH_PLACE_NAME_KEYS.seas)
    assert.ok(seas.has(name), `sea: ${name}`);
  const divisions = new Set(
    pack('states_provinces.json').features.map((f) => `${f.iso2}|${f.name}`),
  );
  for (const { name, country } of SWEDISH_PLACE_NAME_KEYS.regions)
    assert.ok(divisions.has(`${country}|${name}`), `${country}: ${name}`);
  const count = new Map();
  for (const [name] of pack('populated_places.json').places)
    count.set(name, (count.get(name) ?? 0) + 1);
  for (const { name } of SWEDISH_PLACE_NAME_KEYS.towns)
    assert.ok(count.has(name), `town: ${name}`);
  // The towns renamed only in their own country are exactly those whose
  // name Natural Earth gives to more than one town.
  assert.deepEqual(
    SWEDISH_PLACE_NAME_KEYS.towns
      .filter(({ name }) => count.get(name) > 1)
      .map(({ name }) => name)
      .sort(),
    [...TOWN_NAMES_SHARED].sort(),
  );
});

test('a region is Swedish in its own country; a town also across a border', () => {
  assert.equal(swedishSeaName('Baltic Sea'), 'Östersjön');
  assert.equal(swedishSeaName('Øresund'), 'Öresund');
  assert.equal(swedishSeaName('Gulf of Buli'), 'Gulf of Buli');
  assert.equal(swedishRegionName('Lapland', 'FI'), 'Lappland');
  assert.equal(swedishRegionName('Lapland', 'SE'), 'Lapland');
  assert.equal(swedishRegionName('Orebro', 'SE'), 'Örebro');
  assert.equal(swedishTownName('Vannersborg', 'SE'), 'Vänersborg');
  // København seen from Malmö: its name is its own, so it reads in Swedish.
  assert.equal(swedishTownName('København', 'SE'), 'Köpenhamn');
  assert.equal(swedishTownName('Vyborg', 'FI'), 'Viborg');
  assert.equal(swedishTownName('Helsinki', null), 'Helsingfors');
  assert.equal(swedishTownName('Naples', 'IT'), 'Neapel');
  // Names Natural Earth gives to towns in the United States too.
  assert.equal(swedishTownName('Naples', 'US'), 'Naples');
  assert.equal(swedishTownName('Athens', 'US'), 'Athens');
  assert.equal(swedishTownName('Florence', 'US'), 'Florence');
  assert.equal(swedishTownName('St. Petersburg', 'US'), 'St. Petersburg');
});

test('in Swedish the place below reads in Swedish', async (t) => {
  setLocale('sv');
  const { store, over } = mount(t);
  store.publishOrbital({
    ...VIEW,
    place: {
      kind: 'country',
      name: 'Finland',
      countryCode: 'FI',
      division: 'Northern Ostrobothnia',
      near: 'Oulu',
    },
  });
  await nextTick();
  assert.match(over(), /^Norra Österbotten, Finland/);
  assert.match(over(), /Uleåborg/);
  store.publishOrbital({
    ...VIEW,
    place: {
      kind: 'country',
      name: 'United States of America',
      countryCode: 'US',
      division: 'Florida',
      near: 'Naples',
    },
  });
  await nextTick();
  assert.match(over(), /Naples$/);
  // Over Malmö, with København across the sound.
  store.publishOrbital({
    ...VIEW,
    place: {
      kind: 'country',
      name: 'Sweden',
      countryCode: 'SE',
      division: 'Skåne',
      near: 'København',
    },
  });
  await nextTick();
  assert.match(over(), /^Skåne, Sverige/);
  assert.match(over(), /Köpenhamn$/);
  store.publishOrbital({
    ...VIEW,
    place: { kind: 'sea', name: 'Baltic Sea', countryCode: null },
  });
  await nextTick();
  assert.equal(over(), 'Östersjön');
});

test('in English the names are as Natural Earth spells them', async (t) => {
  setLocale('en');
  const { store, over } = mount(t);
  store.publishOrbital({
    ...VIEW,
    place: { kind: 'sea', name: 'Baltic Sea', countryCode: null },
  });
  await nextTick();
  assert.equal(over(), 'Baltic Sea');
});

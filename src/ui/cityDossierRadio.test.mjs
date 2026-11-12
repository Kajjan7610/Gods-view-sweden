import assert from 'node:assert/strict';
import test from 'node:test';
import { localP4Channel } from './cityDossierRadio.js';

test('a town gets its county’s P4 channel as a link to its page', () => {
  assert.deepEqual(
    localP4Channel({ county: 'Västmanlands län', point: [16.54, 59.61] }),
    {
      name: 'P4 Västmanland',
      url: 'https://www.sverigesradio.se/nyheter/p4-vastmanland',
    },
  );
  assert.equal(
    localP4Channel({ county: 'Uppsala län' })?.url,
    'https://www.sverigesradio.se/nyheter/p4-uppland',
  );
  assert.equal(
    localP4Channel({ county: 'Örebro län' })?.url,
    'https://www.sverigesradio.se/nyheter/p4-orebro',
  );
});

test('Skåne and Västra Götaland take the channel nearest the town', () => {
  const name = (county, point) => localP4Channel({ county, point })?.name;
  assert.equal(name('Skåne län', [13.0, 55.6]), 'P4 Malmöhus');
  assert.equal(name('Skåne län', [14.16, 56.03]), 'P4 Kristianstad');
  assert.equal(name('Västra Götalands län', [11.97, 57.71]), 'P4 Göteborg');
  assert.equal(name('Västra Götalands län', [12.94, 57.72]), 'P4 Sjuhärad');
  assert.equal(name('Västra Götalands län', [13.85, 58.39]), 'P4 Skaraborg');
  assert.equal(name('Västra Götalands län', [12.29, 58.28]), 'P4 Väst');
  assert.equal(name('Västra Götalands län'), 'P4 Göteborg');
});

test('every county has a channel; a place outside them has none', () => {
  for (const county of [
    'Stockholms län', 'Södermanlands län', 'Östergötlands län',
    'Jönköpings län', 'Kronobergs län', 'Kalmar län', 'Gotlands län',
    'Blekinge län', 'Hallands län', 'Värmlands län', 'Dalarnas län',
    'Gävleborgs län', 'Västernorrlands län', 'Jämtlands län',
    'Västerbottens län', 'Norrbottens län',
  ])
    assert.match(
      localP4Channel({ county })?.url ?? '',
      /^https:\/\/www\.sverigesradio\.se\/nyheter\/p4-[a-z]+$/,
      county,
    );
  assert.equal(localP4Channel({ county: 'Akershus' }), null);
  assert.equal(localP4Channel(null), null);
});

// The historical aerial photos' catalogue: the proxy's allow-list as years
// and variants, the selection rules and what a selection drapes.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_SELECTION,
  HISTORICAL_ORTHO_CATALOGUE,
  HISTORICAL_ORTHO_TILE_LAYER_IDS,
  HISTORICAL_ORTHO_YEARS,
  catalogueYear,
  drapedLayers,
  hasFlightYears,
  hasVariant,
  normalizeSelection,
  selectedPhoto,
} from './model.js';

test('the catalogue is the proxy allow-list: two reference years, 1993–2005, colour from 2002 and infrared from 2003', () => {
  assert.deepEqual(HISTORICAL_ORTHO_YEARS, [
    1960, 1975, 1993, 1994, 1995, 1996, 1997, 1998, 1999, 2000, 2001, 2002,
    2003, 2004, 2005,
  ]);
  const expected = [
    '1960',
    'seams-1960',
    'meta-1960',
    '1975',
    'seams-1975',
    'meta-1975',
    ...HISTORICAL_ORTHO_YEARS.slice(2).flatMap((year) => [
      `bw-${year}`,
      ...(year >= 2002 ? [`color-${year}`] : []),
      ...(year >= 2003 ? [`ir-${year}`] : []),
    ]),
  ];
  assert.deepEqual(
    [...HISTORICAL_ORTHO_TILE_LAYER_IDS].sort(),
    [...expected].sort(),
  );
  assert.equal(HISTORICAL_ORTHO_TILE_LAYER_IDS.includes('ir-2002'), false);
  assert.equal(hasVariant(2002, 'color'), true);
  assert.equal(hasVariant(2002, 'ir'), false);
  assert.equal(hasVariant(1960, 'color'), false);
  assert.equal(hasFlightYears(1960), true);
  assert.equal(hasFlightYears(1975), true);
  assert.equal(hasFlightYears(1998), false);
  assert.equal(catalogueYear(1950), null);
});

test('0.5 m photos go to level 16, 1 m photos to 15; reference years are mosaics, single years partial', () => {
  const at = (year) => catalogueYear(year);
  assert.deepEqual(at(1960).variants.bw, {
    layerId: '1960',
    resolutionM: 0.5,
    maxLevel: 16,
  });
  assert.equal(at(1960).reference, true);
  assert.equal(at(1960).coverage, 'mosaic');
  assert.deepEqual(at(1999).variants.bw, {
    layerId: 'bw-1999',
    resolutionM: 1,
    maxLevel: 15,
  });
  assert.equal(at(1999).coverage, 'partial');
  assert.equal(at(2004).variants.color.maxLevel, 16);
  assert.equal(at(2004).variants.ir.maxLevel, 16);
  for (const entry of HISTORICAL_ORTHO_CATALOGUE)
    assert.equal(entry.reference, entry.coverage === 'mosaic');
});

test('a selection falls back to what the year has, and keeps the flight-years wish', () => {
  assert.deepEqual(DEFAULT_SELECTION, {
    year: 1960,
    variant: 'bw',
    flightYears: false,
  });
  assert.deepEqual(normalizeSelection({ year: 1850 }), DEFAULT_SELECTION);
  const colour = normalizeSelection({ year: 2003, variant: 'color' });
  assert.deepEqual(colour, { year: 2003, variant: 'color', flightYears: false });
  // 1998 has no colour: black and white.
  assert.equal(normalizeSelection({ year: 1998 }, colour).variant, 'bw');
  assert.equal(normalizeSelection({ variant: 'sepia' }, colour).variant, 'bw');
  const wish = normalizeSelection({ flightYears: true });
  const single = normalizeSelection({ year: 2001 }, wish);
  assert.equal(single.flightYears, true, 'kept while the year has none');
  assert.deepEqual(drapedLayers(single), [
    { layerId: 'bw-2001', role: 'photo', maxLevel: 15 },
  ]);
  const back = normalizeSelection({ year: 1975 }, single);
  assert.deepEqual(
    drapedLayers(back).map((entry) => [entry.layerId, entry.role]),
    [
      ['1975', 'photo'],
      ['seams-1975', 'seams'],
      ['meta-1975', 'meta'],
    ],
  );
  assert.equal(selectedPhoto(colour).layerId, 'color-2003');
  assert.deepEqual(drapedLayers({ year: 1900, variant: 'bw' }), []);
});

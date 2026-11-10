import assert from 'node:assert/strict';
import test from 'node:test';
import { openingState, parseOpeningHours } from './openingHours.js';

// 9 November 2026 is a Monday; Stockholm is UTC+1 then.
const at = (iso) => new Date(iso);

test('common opening hours read into a week of intervals', () => {
  const week = parseOpeningHours(
    'Mo-Fr 08:00-21:00; Sa,Su 09:00-20:00; PH off',
  );
  assert.deepEqual(week[0], [[480, 1260]]);
  assert.deepEqual(week[5], [[540, 1200]]);
  assert.deepEqual(week[6], [[540, 1200]]);
  assert.deepEqual(parseOpeningHours('24/7')[3], [[0, 1440]]);
  assert.deepEqual(parseOpeningHours('07:00-22:00')[2], [[420, 1320]]);
  // Later rules win for the days they name.
  assert.deepEqual(parseOpeningHours('Mo-Su 07:00-22:00; Su 10:00-18:00')[6], [
    [600, 1080],
  ]);
  assert.deepEqual(parseOpeningHours('Mo-Su 07:00-22:00; Su off')[6], []);
  // A span past midnight runs into the next morning.
  assert.deepEqual(parseOpeningHours('Fr 18:00-02:00')[5], [[0, 120]]);
});

test('hours read as mappers often write them', () => {
  // A comma where a semicolon belongs, between two rules.
  const comma = parseOpeningHours('Mo-Fr 07:00-20:00, Sa-Su 08:00-20:00');
  assert.deepEqual(comma[0], [[420, 1200]]);
  assert.deepEqual(comma[4], [[420, 1200]]);
  assert.deepEqual(comma[5], [[480, 1200]]);
  assert.deepEqual(comma[6], [[480, 1200]]);
  // A space in a day list.
  const spaced = parseOpeningHours('Mo-Fr 08:00-20:00; Sa, Su 09:00-19:00');
  assert.deepEqual(spaced[0], [[480, 1200]]);
  assert.deepEqual(spaced[5], [[540, 1140]]);
  assert.deepEqual(spaced[6], [[540, 1140]]);
  // Spaces around the dash of a span.
  assert.deepEqual(
    parseOpeningHours('07:00 - 23:00'),
    Array.from({ length: 7 }, () => [[420, 1380]]),
  );
  assert.deepEqual(parseOpeningHours('Mo-Fr 08:00 - 17:00')[4], [[480, 1020]]);
  // All three at once, and a rule that closes a day.
  const mixed = parseOpeningHours('Mo-Fr 07:00 - 20:00, Sa, Su 08:00-20:00');
  assert.deepEqual(mixed[0], [[420, 1200]]);
  assert.deepEqual(mixed[5], [[480, 1200]]);
  assert.deepEqual(mixed[6], [[480, 1200]]);
  const closed = parseOpeningHours('Mo-Sa 08:00-20:00, Su off');
  assert.deepEqual(closed[5], [[480, 1200]]);
  assert.deepEqual(closed[6], []);
  assert.deepEqual(parseOpeningHours('Sa off, Su 10:00-16:00')[6], [
    [600, 960],
  ]);
  // A comma between two spans of one rule is still that.
  const lunch = parseOpeningHours('Mo-Fr 08:00-12:00,13:00-17:00; Sa off');
  assert.deepEqual(lunch[0], [
    [480, 720],
    [780, 1020],
  ]);
  assert.deepEqual(lunch[5], []);
  assert.deepEqual(
    openingState(
      'Mo-Fr 07:00-20:00, Sa-Su 08:00-20:00',
      at('2026-11-14T06:30:00Z'),
    ),
    { open: false, opens: '08:00', inDays: 0 },
  );
});

test('forms it does not read are unknown, not guessed', () => {
  assert.equal(parseOpeningHours(''), null);
  assert.equal(parseOpeningHours(null), null);
  assert.equal(parseOpeningHours('Jan-Mar Mo-Fr 08:00-17:00'), null);
  assert.equal(parseOpeningHours('May 13-Sep 06 Mo-Su 10:00-18:00'), null);
  assert.equal(parseOpeningHours('Mo-Fr sunrise-sunset'), null);
  assert.equal(parseOpeningHours('sunrise-sunset'), null);
  assert.equal(parseOpeningHours('by appointment'), null);
  assert.equal(
    parseOpeningHours('Mo-Fr 08:00-17:00, Jan-Mar Sa 10:00-14:00'),
    null,
  );
  assert.equal(openingState('by appointment'), null);
});

test('the state says when an open store closes and a closed one opens', () => {
  const hours = 'Mo-Fr 08:00-21:00; Sa,Su 09:00-20:00';
  assert.deepEqual(openingState(hours, at('2026-11-09T10:00:00Z')), {
    open: true,
    closes: '21:00',
  });
  assert.deepEqual(openingState(hours, at('2026-11-09T06:00:00Z')), {
    open: false,
    opens: '08:00',
    inDays: 0,
  });
  assert.deepEqual(openingState(hours, at('2026-11-09T21:30:00Z')), {
    open: false,
    opens: '08:00',
    inDays: 1,
  });
  assert.deepEqual(openingState('24/7', at('2026-11-09T03:00:00Z')), {
    open: true,
    closes: null,
  });
  assert.deepEqual(
    openingState('Mo-Su 07:00-24:00', at('2026-11-09T21:30:00Z')),
    {
      open: true,
      closes: '00:00',
    },
  );
  assert.deepEqual(openingState('Mo-Su off', at('2026-11-09T10:00:00Z')), {
    open: false,
    opens: null,
    inDays: null,
  });
});

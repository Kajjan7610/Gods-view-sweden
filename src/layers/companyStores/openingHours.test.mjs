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

test('forms it does not read are unknown, not guessed', () => {
  assert.equal(parseOpeningHours(''), null);
  assert.equal(parseOpeningHours(null), null);
  assert.equal(parseOpeningHours('Jan-Mar Mo-Fr 08:00-17:00'), null);
  assert.equal(parseOpeningHours('Mo-Fr sunrise-sunset'), null);
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

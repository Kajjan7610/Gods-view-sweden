/**
 * The common forms of OpenStreetMap `opening_hours` ("Mo-Fr 08:00-21:00;
 * Sa,Su 09:00-20:00", "24/7", "Mo-Su 07:00-22:00; PH off"), read into a
 * week of open intervals, and whether a store is open at a moment. Anything
 * richer (months, week numbers, "sunrise", fallbacks) reads as unknown, so the
 * card says nothing rather than guessing. Pure — no Cesium, no Node built-ins.
 */

const DAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const DAY = '(?:Mo|Tu|We|Th|Fr|Sa|Su|PH|SH)';
const DAY_LIST = new RegExp(
  `^(${DAY}(?:-${DAY})?(?:,${DAY}(?:-${DAY})?)*)\\s+(.+)$`,
);
const SPAN = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/;

/** The weekday indexes (Monday 0) a day list like "Mo-Fr,Su" names. */
function dayIndexes(list) {
  const days = [];
  for (const part of list.split(',')) {
    const [from, to = from] = part.split('-');
    // Public and school holidays are not on the calendar this reads.
    if (!DAYS.includes(from) || !DAYS.includes(to)) continue;
    for (let i = DAYS.indexOf(from); ; i = (i + 1) % 7) {
      days.push(i);
      if (i === DAYS.indexOf(to)) break;
    }
  }
  return days;
}

/**
 * A week of open intervals in minutes after midnight, `week[0]` Monday, or
 * null when the value is missing or in a form this does not read. Later
 * rules replace earlier ones for the days they name; a span past midnight
 * runs on into the next morning.
 */
export function parseOpeningHours(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (value.trim() === '24/7')
    return Array.from({ length: 7 }, () => [[0, 1440]]);
  const week = Array.from({ length: 7 }, () => []);
  const spill = Array.from({ length: 7 }, () => []);
  for (const raw of value.split(';')) {
    const rule = raw.trim();
    if (!rule) continue;
    const match = rule.match(DAY_LIST);
    const days = match ? dayIndexes(match[1]) : [0, 1, 2, 3, 4, 5, 6];
    const times = (match ? match[2] : rule).trim();
    if (match && !days.length) continue;
    const spans = [];
    if (!/^(off|closed)$/i.test(times))
      for (const part of times.split(',')) {
        const span = part.trim().match(SPAN);
        if (!span) return null;
        const start = Number(span[1]) * 60 + Number(span[2]);
        const end = Number(span[3]) * 60 + Number(span[4]);
        if (start > 1440 || end > 1440 || span[2] > '59' || span[4] > '59')
          return null;
        spans.push([start, end]);
      }
    for (const day of days) {
      week[day] = [];
      spill[(day + 1) % 7] = spill[(day + 1) % 7].filter(
        (entry) => entry.from !== day,
      );
      for (const [start, end] of spans) {
        if (end > start) week[day].push([start, end]);
        else {
          week[day].push([start, 1440]);
          if (end > 0) spill[(day + 1) % 7].push({ from: day, span: [0, end] });
        }
      }
    }
  }
  for (let day = 0; day < 7; day++)
    week[day].push(...spill[day].map((entry) => entry.span));
  for (const spans of week) spans.sort((a, b) => a[0] - b[0]);
  return week;
}

/** The weekday (Monday 0) and minute of the day at `date` in `timeZone`. */
function localClock(date, timeZone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return {
    day: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(
      parts.weekday,
    ),
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

const clock = (minute) =>
  `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/**
 * Whether a store is open at `date` by its `opening_hours`, or null when they
 * are not readable:
 * `{open: true, closes: 'HH:MM' | null}` (null: open around the clock) or
 * `{open: false, opens: 'HH:MM' | null, inDays}` (null: no opening this week).
 */
export function openingState(
  value,
  date = new Date(),
  timeZone = 'Europe/Stockholm',
) {
  const week = parseOpeningHours(value);
  if (!week) return null;
  const { day, minute } = localClock(date, timeZone);
  if (day < 0) return null;
  const current = week[day].find(
    ([start, end]) => start <= minute && minute < end,
  );
  if (current) {
    // Follow a span that runs on past midnight into the next days.
    let end = current[1];
    let step = 0;
    while (end === 1440 && step < 7) {
      step++;
      const next = week[(day + step) % 7].find(([start]) => start === 0);
      if (!next) break;
      end = next[1];
    }
    return {
      open: true,
      closes: end === 1440 && step >= 7 ? null : clock(end),
    };
  }
  for (let step = 0; step < 7; step++) {
    const next = week[(day + step) % 7].find(
      ([start]) => step > 0 || start > minute,
    );
    if (next) return { open: false, opens: clock(next[0]), inDays: step };
  }
  return { open: false, opens: null, inDays: null };
}

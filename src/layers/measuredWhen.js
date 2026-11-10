/** When a station measured, in Swedish time. Pure — no Cesium, no i18n. */

const CLOCK = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  hour: '2-digit',
  minute: '2-digit',
});
const DAY = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** A time of day: "14:00". */
export function clockTime(ms) {
  return CLOCK.format(ms);
}

/**
 * When a station last reported: the time today, the date and time before
 * that, so a station silent for days never reads as measured just now.
 */
export function measuredWhen(updated, nowMs) {
  const day = DAY.format(updated);
  const time = CLOCK.format(updated);
  return day === DAY.format(nowMs) ? time : `${day} ${time}`;
}

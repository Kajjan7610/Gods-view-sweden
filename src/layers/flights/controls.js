import { formatDate, formatNumber, t, tn } from '../../i18n/index.js';
import { approxDistanceKm } from '../../data/approxDistance.js';

const MINUTE_MS = 60_000;
/** A disc read this far from the point asked about is another place's. */
const ELSEWHERE_KM = 50;
/** A disc read for the point's own 0.25° cell lies within this of it. */
const OWN_CELL_KM = 20;

/** Kilometres between two `{latitude, longitude}` points, or null. */
function distanceKm(a, b) {
  if (!a || !b) return null;
  const km = approxDistanceKm(a.latitude, a.longitude, b.latitude, b.longitude);
  return Number.isFinite(km) ? km : null;
}

/** A lock's end as local time, with the weekday when it is not today. */
function untilText(lockedUntil, now) {
  const sameDay =
    new Date(lockedUntil).toDateString() === new Date(now).toDateString();
  return formatDate(lockedUntil, {
    ...(sameDay ? {} : { weekday: 'short' }),
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** How old the disc is: to the nearest minute, and hour past the first hour. */
function ageText(minutes) {
  return minutes > 60
    ? t('{n} h ago', { n: formatNumber(Math.round(minutes / 60)) })
    : t('{n} min ago', { n: formatNumber(minutes) });
}

/**
 * The Layers row's line for flights from adsb.lol (Swedish fork), or null
 * for another source. One line of at most 72 characters in every language,
 * the first that holds of: the day's quota is used up, and when the feed is
 * back; adsb.lol refused the key; adsb.lol did not answer the last poll, so
 * older data (or none) is shown; it is older data from nearby (read
 * elsewhere, or kept while adsb.lol is not asked); else what is shown and
 * around where. Then how old it is, once that rounds to a minute or more
 * (for a refused key, in the tooltip). The tooltip says why (the day's
 * quota is being saved; nothing new came in; nothing new from adsb.lol just
 * now; how far away it was read), what a key gives or that it is asked
 * without one meanwhile, and how much of the day's budget is used.
 * @param {object} feed
 * @param {string} feed.source The provider the last answer named.
 * @param {number} feed.count Aircraft shown.
 * @param {number|null} feed.observedAtMs When the disc shown was observed.
 * @param {{used: number|null, limit: number|null, keyed: boolean,
 *   keyRefused?: boolean, lockedUntil: number|null, cache: string|null,
 *   anchor: {latitude: number, longitude: number}|null,
 *   asked: {latitude: number, longitude: number}|null,
 *   failed?: boolean}|null} feed.quota
 *   What the server said of adsb.lol's daily quota (see standalone.js), and
 *   after a failed poll what still holds of the disc shown (ingestion.js).
 * @param {boolean} [feed.cockpit] Read around the aircraft flown.
 * @param {number} [feed.now]
 * @returns {{info: string, infoTitle: string}|null}
 */
export function flightsQuotaRow({
  source,
  count,
  observedAtMs,
  quota,
  cockpit = false,
  now = Date.now(),
}) {
  if (source !== 'adsb.lol' && !quota) return null;
  const shown = Number.isFinite(count) && count > 0 ? count : 0;
  const counted = { count: formatNumber(shown) };
  const locked = Number.isFinite(quota?.lockedUntil) && quota.lockedUntil > now;
  const refusedKey = quota?.keyRefused === true;
  const failed = quota?.failed === true;
  const offKm = distanceKm(quota?.asked, quota?.anchor);
  const away = offKm !== null && offKm > ELSEWHERE_KM;
  // Kept while adsb.lol is not asked, or read around another place.
  const older = !locked && (away || quota?.cache === 'STALE');
  const lead = locked
    ? t('adsb.lol: today’s quota is used up, back at {time}', {
        time: untilText(quota.lockedUntil, now),
      })
    : refusedKey
      ? t('adsb.lol refused the key – check it under {panel}', {
          panel: t('POWER UP'),
        })
      : failed
        ? shown > 0
          ? tn(
              shown,
              'adsb.lol is not answering · older data · {count} aircraft',
              'adsb.lol is not answering · older data · {count} aircraft',
              counted,
            )
          : t('adsb.lol is not answering · no aircraft shown')
        : older
          ? tn(
              shown,
              'adsb.lol · older data from nearby · {count} aircraft',
              'adsb.lol · older data from nearby · {count} aircraft',
              counted,
            )
          : cockpit
            ? tn(
                shown,
                'adsb.lol · 250 nm around your aircraft · {count} aircraft',
                'adsb.lol · 250 nm around your aircraft · {count} aircraft',
                counted,
              )
            : tn(
                shown,
                'adsb.lol · 250 nm around the map centre · {count} aircraft',
                'adsb.lol · 250 nm around the map centre · {count} aircraft',
                counted,
              );
  // Under half a minute old, no age is told.
  const minutes = Number.isFinite(observedAtMs)
    ? Math.round((now - observedAtMs) / MINUTE_MS)
    : 0;
  const aged = minutes >= 1 && (shown > 0 || !locked);
  // The refused key's line has no room for the age: the tooltip tells it.
  const age = aged && !refusedKey ? ageText(minutes) : '';
  const why = [
    // Only while the last poll was answered, from a paced disc.
    quota?.cache === 'PACED' && !locked && !failed
      ? t(
          'Saving today’s quota: the same place is asked again only after a pause.',
        )
      : '',
    failed && !locked
      ? t(
          'Nothing new came in; aircraft older than 30 minutes are taken off the map.',
        )
      : '',
    older && !failed
      ? t(
          'Nothing new from adsb.lol just now; data already read nearby is shown.',
        )
      : '',
    offKm !== null && offKm > OWN_CELL_KM
      ? t('Read around a place {km} km away.', {
          km: formatNumber(Math.round(offKm)),
        })
      : '',
    aged && refusedKey
      ? t('The aircraft shown were read {age}.', { age: ageText(minutes) })
      : '',
  ];
  const key = !quota
    ? ''
    : refusedKey
      ? t('Meanwhile the app asks without a key (500 calls a day).')
      : quota.keyed
        ? t('With your adsb.lol key the app asks up to {limit} times a day.', {
            limit: formatNumber(quota.limit ?? 0),
          })
        : t(
            'Without a key 500 calls a day; a free key under {panel} gives more.',
            { panel: t('POWER UP') },
          );
  const budget =
    Number.isFinite(quota?.used) && Number.isFinite(quota?.limit)
      ? t('{used} of {limit} calls used in the last 24 hours.', {
          used: formatNumber(quota.used),
          limit: formatNumber(quota.limit),
        })
      : '';
  return {
    info: [lead, age].filter(Boolean).join(' · '),
    infoTitle: [...why, key, budget].filter(Boolean).join(' '),
  };
}

/** The flights layer's Layers row: the adsb.lol line above, while on. */
export function createControls({ flightState }) {
  const methods = {
    getRowControls() {
      const feed = flightState.feed;
      const row = flightsQuotaRow({
        source: feed._lastSource,
        count: feed._count,
        observedAtMs: feed._lastUpdate,
        quota: feed._lastQuota,
        cockpit: flightState._cockpitContactMode === true,
        now: Date.now(),
      });
      return row ? { chips: [], legend: [], ...row } : null;
    },
  };
  return { methods };
}

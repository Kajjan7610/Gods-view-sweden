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

/** A whole view's gap in whole minutes, at least one. */
const gapMinutes = (ms) => Math.max(1, Math.round(ms / MINUTE_MS));

/** How old the disc is: to the nearest minute, and hour past the first hour. */
function ageText(minutes) {
  return minutes > 60
    ? t('{n} h ago', { n: formatNumber(Math.round(minutes / 60)) })
    : t('{n} min ago', { n: formatNumber(minutes) });
}

/** The view is read at most this far from the map centre (the server's box). */
const VIEW_READ_KM = 1500;

/**
 * Swedish fork: the line for a whole view read from several adsb.lol discs
 * (server/providers/aircraft/adsbLolView.js): the whole view, only when the
 * discs leave none of it out and none of it was cut away, else about how
 * much of it they cover; and how many aircraft, or how many of the nearest
 * of how many when the server kept fewer than the view held.
 */
function wholeViewLead(view, count, capped) {
  const values = {
    percent: formatNumber(view.covered / 100, {
      style: 'percent',
      maximumFractionDigits: 0,
    }),
    count: formatNumber(capped ? capped.count : count),
    seen: formatNumber(capped?.of ?? 0),
  };
  const whole = view.covered >= 100 && !view.clipped;
  if (capped)
    return whole
      ? tn(
          capped.count,
          'adsb.lol · whole view · nearest {count} of {seen} aircraft',
          'adsb.lol · whole view · nearest {count} of {seen} aircraft',
          values,
        )
      : tn(
          capped.count,
          'adsb.lol · about {percent} of the view · nearest {count} of {seen} aircraft',
          'adsb.lol · about {percent} of the view · nearest {count} of {seen} aircraft',
          values,
        );
  return whole
    ? tn(
        count,
        'adsb.lol · whole view · {count} aircraft',
        'adsb.lol · whole view · {count} aircraft',
        values,
      )
    : tn(
        count,
        'adsb.lol · about {percent} of the view · {count} aircraft',
        'adsb.lol · about {percent} of the view · {count} aircraft',
        values,
      );
}

/**
 * The Layers row's line for flights from adsb.lol (Swedish fork), or null
 * for another source. One line of at most 72 characters in every language,
 * the first that holds of: the day's quota is used up, and when the feed is
 * back; adsb.lol refused the key; adsb.lol did not answer the last poll, so
 * older data (or none) is shown; it is older data from nearby (read
 * elsewhere, or kept while adsb.lol is not asked); else what is shown and
 * around where: in a whole view, the whole view when nothing of it is left
 * out or cut away, else about how much of it is covered (and of how many
 * aircraft the nearest, when the server kept fewer). Then how old it is,
 * once that rounds to a minute or more (for a refused key, in the tooltip);
 * in a whole view, up to how old (in the tooltip when the nearest were
 * kept). The tooltip says why (the day's quota is being saved; nothing new
 * came in; nothing new from adsb.lol just now; how far away it was read;
 * zoomed out, how often the middle and the outer areas are read, or that
 * the outer areas are not read just now, how many areas the quota keeps up
 * to date, that the others are read one at a time, and that only the view
 * near the map centre is read), what a key gives or that it is asked
 * without one meanwhile, and how much of the day's budget is used.
 * @param {object} feed
 * @param {string} feed.source The provider the last answer named.
 * @param {number} feed.count Aircraft shown.
 * @param {number|null} feed.observedAtMs When the disc shown was observed.
 * @param {{used: number|null, limit: number|null, keyed: boolean,
 *   keyRefused?: boolean, lockedUntil: number|null, cache: string|null,
 *   anchor: {latitude: number, longitude: number}|null,
 *   asked: {latitude: number, longitude: number}|null,
 *   discs?: {shown: number, total: number, kept?: number},
 *   gaps?: {centreMs: number, outerMs: number|null}, outerHeld?: boolean,
 *   view?: {covered: number, clipped: boolean}, outerReadAt?: number,
 *   capped?: {count: number, of: number},
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
  // A view wider than one disc, its outer areas read from discs of their
  // own: its line unless a line above says more.
  const discs = quota?.discs;
  const whole =
    !cockpit &&
    discs?.total > 1 &&
    Boolean(quota.view) &&
    !locked &&
    !refusedKey &&
    !failed &&
    !older;
  const capped = whole ? (quota?.capped ?? null) : null;
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
          : whole
            ? wholeViewLead(quota.view, shown, capped)
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
  // In a whole view, the oldest disc but the middle's, and the oldest of all.
  const outerMinutes =
    whole && Number.isFinite(quota?.outerReadAt)
      ? Math.round((now - quota.outerReadAt) / MINUTE_MS)
      : 0;
  const oldest = Math.max(aged ? minutes : 0, outerMinutes);
  // The refused key's line has no room for the age: the tooltip tells it;
  // nor has a whole view's line where the nearest aircraft were kept.
  const age =
    refusedKey || capped
      ? ''
      : whole
        ? oldest >= 1
          ? t('up to {n} min old', { n: formatNumber(oldest) })
          : ''
        : aged
          ? ageText(minutes)
          : '';
  const held = whole && quota.outerHeld === true;
  const why = [
    // Only while the last poll was answered, from a paced disc; a whole
    // view says it of its middle and its outer areas.
    quota?.cache === 'PACED' && !locked && !failed && !whole
      ? t(
          'Saving today’s quota: the same place is asked again only after a pause.',
        )
      : '',
    // Zoomed out the middle shares the pace with the outer areas: it is read
    // less often than when the view fits in its disc.
    whole && Number.isFinite(quota.gaps?.outerMs)
      ? held
        ? t(
            'Zoomed out, the middle of the view is read about every {centre} min; the outer areas are not read just now, and what was read stays up to 30 minutes.',
            { centre: formatNumber(gapMinutes(quota.gaps.centreMs)) },
          )
        : t(
            'Zoomed out, the middle of the view is read about every {centre} min and the outer areas about every {outer} min, so today’s quota lasts all day.',
            {
              centre: formatNumber(gapMinutes(quota.gaps.centreMs)),
              outer: formatNumber(gapMinutes(quota.gaps.outerMs)),
            },
          )
      : '',
    whole && discs.kept < discs.total
      ? discs.kept > 1
        ? t(
            'Today’s quota keeps the areas nearest the map centre up to date, {count} of {total}; the others are not read.',
            {
              count: formatNumber(discs.kept),
              total: formatNumber(discs.total),
            },
          )
        : t(
            'Today’s quota keeps only the area around the map centre up to date; the others are not read.',
          )
      : '',
    whole &&
    !held &&
    discs.shown < Math.min(discs.kept ?? discs.total, discs.total)
      ? t('The other areas are read one at a time, the nearest first.')
      : '',
    whole && quota.view.clipped
      ? t('Only the view within {km} km of the map centre is read.', {
          km: formatNumber(VIEW_READ_KM),
        })
      : '',
    capped
      ? t(
          'Of {seen} aircraft read around the view, the {count} nearest the map centre are shown.',
          {
            seen: formatNumber(capped.of),
            count: formatNumber(capped.count),
          },
        )
      : '',
    capped && oldest >= 1
      ? t('The aircraft shown were read up to {n} min ago.', {
          n: formatNumber(oldest),
        })
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

/** Card model for a selected bidding zone. Pure — no Cesium types. */
import { formatNumber, t } from '../../i18n/index.js';
import { priceAt, priceColor, summarizeDay } from './records.js';

export const ELECTRICITY_OVERLAY_SOURCE_ID = 'electricity-prices';

// Swedish market, Swedish clock.
const CLOCK = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  hour: '2-digit',
  minute: '2-digit',
});

/** "1.95" (two decimals, locale separator). */
export function formatSek(value) {
  return formatNumber(value, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/**
 * Card for one zone: the price now, today's range and tomorrow's.
 * @param {object} zone {id, name, today, tomorrow}
 * @param {number} nowMs
 */
export function buildZoneCard(zone, nowMs) {
  const details = [];
  const current = priceAt(zone.today, nowMs);
  if (current)
    details.push(
      t('Now {price} kr/kWh ({from}–{to})', {
        price: formatSek(current.sek),
        from: CLOCK.format(current.start),
        to: CLOCK.format(current.end),
      }),
    );
  const today = summarizeDay(zone.today);
  if (today)
    details.push(
      t('Today: low {low} at {lowAt}, high {high} at {highAt}, mean {mean}', {
        low: formatSek(today.min),
        lowAt: CLOCK.format(today.minAt),
        high: formatSek(today.max),
        highAt: CLOCK.format(today.maxAt),
        mean: formatSek(today.mean),
      }),
    );
  const tomorrow = summarizeDay(zone.tomorrow);
  details.push(
    tomorrow
      ? t('Tomorrow: low {low}, high {high}, mean {mean}', {
          low: formatSek(tomorrow.min),
          high: formatSek(tomorrow.max),
          mean: formatSek(tomorrow.mean),
        })
      : t(
          'Tomorrow’s prices come after the day-ahead auction, early afternoon',
        ),
  );
  details.push(
    t(
      'Spot price in kr/kWh, excluding VAT, grid fee and energy tax · elprisetjustnu.se',
    ),
  );
  return {
    ...CARD_BASE,
    id: `electricity-card:${zone.id}`,
    // Always hit-testable, so a click on the card is never the ground.
    interactive: true,
    title: t('ELECTRICITY PRICE · {zone} {name}', {
      zone: zone.id,
      name: zone.name.toUpperCase(),
    }),
    details,
    accent: priceColor(current?.sek),
  };
}

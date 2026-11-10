/** Card model for a selected SMHI station. Pure — no Cesium types. */
import { formatNumber, getLocale, t } from '../../i18n/index.js';
import { formatCelsius } from '../roadWeather/cards.js';
import { temperatureColor } from '../roadWeather/records.js';
import { symbolEmoji } from './records.js';

export const SMHI_WEATHER_OVERLAY_SOURCE_ID = 'smhi-weather';

const CLOCK = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  hour: '2-digit',
  minute: '2-digit',
});
const oneDecimal = (value) =>
  formatNumber(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/** "tor" / "Thu": the weekday in the UI language. */
function weekday(ms) {
  try {
    return new Intl.DateTimeFormat(getLocale() || 'en', {
      timeZone: 'Europe/Stockholm',
      weekday: 'short',
    }).format(ms);
  } catch {
    return '';
  }
}

/**
 * Card for one station: the latest observation, then SMHI's forecast for
 * the spot once it has arrived.
 * @param {object} row A merged station.
 * @param {{forecast?: object|null, forecastState?: 'loading'|'ready'|'failed'}} [options]
 */
export function buildWeatherCard(
  row,
  { forecast = null, forecastState = 'loading' } = {},
) {
  const details = [];
  const now = [];
  if (row.airTemp != null) now.push(formatCelsius(row.airTemp));
  if (row.wind != null)
    now.push(
      row.gust != null
        ? t('wind {speed} m/s, gusts {gust}', {
            speed: oneDecimal(row.wind),
            gust: oneDecimal(row.gust),
          })
        : t('wind {speed} m/s', { speed: oneDecimal(row.wind) }),
    );
  if (row.precipitation != null)
    now.push(
      t('{amount} mm last hour', { amount: oneDecimal(row.precipitation) }),
    );
  if (now.length)
    details.push(t('Now: {weather}', { weather: now.join(', ') }));
  if (forecastState === 'loading') details.push(t('Loading SMHI forecast …'));
  else if (forecastState === 'failed' || !forecast)
    details.push(t('SMHI forecast unavailable'));
  else {
    const next = forecast.next24;
    if (next)
      details.push(
        t(
          'Next 24 h: {emoji} {min} to {max}, gusts up to {gust} m/s, {rain} mm',
          {
            emoji: symbolEmoji(next.symbol),
            min: formatCelsius(next.min),
            max: formatCelsius(next.max),
            gust: next.gust != null ? oneDecimal(next.gust) : '–',
            rain:
              next.precipitation != null ? oneDecimal(next.precipitation) : '–',
          },
        ).replace(/\s+/g, ' '),
      );
    const days = (forecast.days || [])
      .slice(0, 3)
      .map(
        (day) =>
          `${weekday(day.at)} ${symbolEmoji(day.symbol)} ${formatCelsius(day.min)} … ${formatCelsius(day.max)}`,
      );
    if (days.length) details.push(days.join(' · '));
  }
  details.push(
    Number.isFinite(row.updated)
      ? t('Measured {time} · SMHI', { time: CLOCK.format(row.updated) })
      : 'SMHI',
  );
  return {
    ...CARD_BASE,
    id: `smhi-weather-card:${row.id}`,
    // Always hit-testable, so a click on the card is never the ground.
    interactive: true,
    title: t('WEATHER · {station}', { station: row.name.toUpperCase() }),
    details,
    accent: temperatureColor(row.airTemp),
  };
}

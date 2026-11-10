/** Card model for a selected ViVa station. Pure — no Cesium types. */
import { formatNumber, t } from '../../i18n/index.js';
import { formatCelsius } from '../roadWeather/cards.js';
import {
  LEVEL_CLASSES,
  NO_VALUE_COLOR,
  WIND_CLASSES,
  classOf,
} from './records.js';

export const SEA_WEATHER_OVERLAY_SOURCE_ID = 'sea-weather';

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

/** The colour a station takes for the shown quantity ('wind' or 'level'). */
export function seaColor(row, mode) {
  const entry =
    mode === 'level'
      ? classOf(LEVEL_CLASSES, row.level)
      : classOf(WIND_CLASSES, row.meanWind);
  return entry?.color || NO_VALUE_COLOR;
}

function windLine(row) {
  const speed = oneDecimal(row.meanWind);
  const direction =
    row.windHeading != null ? `${Math.round(row.windHeading) % 360}°` : null;
  if (row.gust != null && direction)
    return t('Wind {speed} m/s, gusts {gust} m/s, from {direction}', {
      speed,
      gust: oneDecimal(row.gust),
      direction,
    });
  if (direction)
    return t('Wind {speed} m/s from {direction}', { speed, direction });
  return t('Wind {speed} m/s', { speed });
}

/** Card for one station. */
export function buildSeaCard(row, { mode = 'wind' } = {}) {
  const details = [];
  if (row.meanWind != null) details.push(windLine(row));
  if (row.level != null)
    details.push(
      t('Water level {level} cm against mean water', {
        level: formatNumber(row.level, { signDisplay: 'exceptZero' }),
      }),
    );
  if (row.waterTemp != null)
    details.push(t('Water {value}', { value: formatCelsius(row.waterTemp) }));
  if (row.airTemp != null)
    details.push(t('Air {air}', { air: formatCelsius(row.airTemp) }));
  if (row.waveHeight != null)
    details.push(
      t('Wave height {height} m', { height: oneDecimal(row.waveHeight) }),
    );
  details.push(
    Number.isFinite(row.updated)
      ? t('Measured {time} · Sjöfartsverket ViVa', {
          time: CLOCK.format(row.updated),
        })
      : 'Sjöfartsverket ViVa',
  );
  return {
    ...CARD_BASE,
    id: `sea-weather-card:${row.id}`,
    // Always hit-testable, so a click on the card is never the ground.
    interactive: true,
    title: t('SEA WEATHER · {station}', { station: row.name.toUpperCase() }),
    details,
    accent: seaColor(row, mode),
  };
}

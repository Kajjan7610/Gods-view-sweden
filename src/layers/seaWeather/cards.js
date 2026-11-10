/** Card model for a selected ViVa station. Pure — no Cesium types. */
import { formatNumber, t } from '../../i18n/index.js';
import { measuredWhen } from '../measuredWhen.js';
import { formatCelsius } from '../roadWeather/cards.js';
import {
  LEVEL_CLASSES,
  NO_VALUE_COLOR,
  WIND_CLASSES,
  classOf,
  isMeanWater,
  meanWaterLevel,
} from './records.js';

export const SEA_WEATHER_OVERLAY_SOURCE_ID = 'sea-weather';

const oneDecimal = (value) =>
  formatNumber(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/**
 * The colour a station takes for the shown quantity ('wind' or 'level'). A
 * level against another zero than mean water has no class, so no colour.
 */
export function seaColor(row, mode) {
  const entry =
    mode === 'level'
      ? classOf(LEVEL_CLASSES, meanWaterLevel(row))
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

/** ViVa's reference as it reads in a sentence: "sjökortsnivå", "RH 2000". */
function referenceName(reference) {
  if (/^RH\s?\d+$/i.test(reference))
    return reference.toUpperCase().replace(/^RH\s?/, 'RH ');
  return /^\p{Lu}\p{Ll}+$/u.test(reference)
    ? reference.toLocaleLowerCase('sv-SE')
    : reference;
}

/** The water level against the zero the station itself measures from. */
function levelLine(row) {
  const level = formatNumber(row.level, { signDisplay: 'exceptZero' });
  if (isMeanWater(row.levelReference))
    return t('Water level {level} cm against mean water', { level });
  if (row.levelReference)
    return t('Water level {level} cm against {reference}', {
      level,
      reference: referenceName(row.levelReference),
    });
  return t('Water level {level} cm', { level });
}

/**
 * Card for one station.
 * @param {object} row A normalized station.
 * @param {{mode?: string, nowMs?: number}} [options] The shown quantity, and
 *   the clock the reading's age is judged by.
 */
export function buildSeaCard(row, { mode = 'wind', nowMs = Date.now() } = {}) {
  const details = [];
  if (row.meanWind != null) details.push(windLine(row));
  if (row.level != null) details.push(levelLine(row));
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
          time: measuredWhen(row.updated, nowMs),
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

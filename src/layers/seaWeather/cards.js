/** Card model for a selected sea weather station. Pure — no Cesium types. */
import { formatNumber, t } from '../../i18n/index.js';
import { measuredWhen } from '../measuredWhen.js';
import { formatCelsius } from '../roadWeather/cards.js';
import {
  LEVEL_CLASSES,
  NO_VALUE_COLOR,
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
 * The colour a station takes by its water level. A level against another
 * zero than mean water has no class, so no colour.
 */
export function seaColor(row) {
  return classOf(LEVEL_CLASSES, meanWaterLevel(row))?.color || NO_VALUE_COLOR;
}

/** A level reference as it reads in a sentence: "sjökortsnivå", "RH 2000". */
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
 * @param {{nowMs?: number}} [options] The clock the reading's age is judged
 *   by.
 */
export function buildSeaCard(row, { nowMs = Date.now() } = {}) {
  const details = [];
  if (row.level != null) details.push(levelLine(row));
  if (row.waterTemp != null)
    details.push(t('Water {value}', { value: formatCelsius(row.waterTemp) }));
  if (row.waveHeight != null)
    details.push(
      t('Wave height {height} m', { height: oneDecimal(row.waveHeight) }),
    );
  details.push(
    Number.isFinite(row.updated)
      ? t('Measured {time} · SMHI', { time: measuredWhen(row.updated, nowMs) })
      : 'SMHI', // i18n-ignore: agency name
  );
  return {
    ...CARD_BASE,
    id: `sea-weather-card:${row.id}`,
    // Always hit-testable, so a click on the card is never the ground.
    interactive: true,
    title: t('SEA WEATHER · {station}', { station: row.name.toUpperCase() }),
    details,
    accent: seaColor(row),
  };
}

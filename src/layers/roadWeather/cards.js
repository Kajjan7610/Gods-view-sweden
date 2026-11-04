/** Card model for a selected road weather station. Pure — no Cesium types. */
import { formatNumber, msg, t } from '../../i18n/index.js';
import { temperatureColor } from './records.js';

export const ROAD_WEATHER_OVERLAY_SOURCE_ID = 'trafikverket-weather';

// Swedish data, Swedish clock: the sample time reads as Trafikverket's.
const CLOCK = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  hour: '2-digit',
  minute: '2-digit',
});

/** "-1.2 °C", "+3.0 °C", "0.0 °C" (the minus sign follows the UI locale). */
export function formatCelsius(value) {
  return `${formatNumber(value, {
    signDisplay: 'exceptZero',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} °C`;
}

const oneDecimal = (value) =>
  formatNumber(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const known = Number.isFinite;

const RISK_TEXT = Object.freeze({
  measured: msg('Risk of ice: ice or snow measured on the road'),
  precipitation: msg('Risk of ice: precipitation on a road at or below 0 °C'),
  frost: msg('Risk of ice: frost (road colder than the dew point)'),
});
const PRECIPITATION_TEXT = Object.freeze({
  rain: msg('Rain'),
  drizzle: msg('Drizzle'),
  sleet: msg('Sleet'),
  snow: msg('Snow'),
  hail: msg('Hail'),
  freezingrain: msg('Freezing rain'),
});

function airLine(row) {
  if (!known(row.airTemp)) return null;
  const air = formatCelsius(row.airTemp);
  if (known(row.dewpoint) && known(row.humidity))
    return t('Air {air}, dew point {dewpoint}, humidity {humidity} %', {
      air,
      dewpoint: formatCelsius(row.dewpoint),
      humidity: formatNumber(Math.round(row.humidity)),
    });
  return t('Air {air}', { air });
}

function windLine(row) {
  if (!known(row.windSpeed)) return null;
  const speed = oneDecimal(row.windSpeed);
  const direction = known(row.windDirection)
    ? `${Math.round(row.windDirection) % 360}°`
    : null;
  if (known(row.windGust) && direction)
    return t('Wind {speed} m/s, gusts {gust} m/s, from {direction}', {
      speed,
      gust: oneDecimal(row.windGust),
      direction,
    });
  if (direction)
    return t('Wind {speed} m/s from {direction}', { speed, direction });
  return t('Wind {speed} m/s', { speed });
}

function precipitationLine(row) {
  if (!row.precipitation || row.precipitation === 'no') return null;
  const kind = PRECIPITATION_TEXT[row.precipitation.replace(/[\s_-]/g, '')];
  const label = kind ? t(kind) : row.precipitation;
  if (known(row.precipitation30))
    return t('Precipitation: {kind}, {amount} mm in the last 30 min', {
      kind: label,
      amount: oneDecimal(row.precipitation30),
    });
  return t('Precipitation: {kind}', { kind: label });
}

function sensorLine(row) {
  if (
    row.surfaceIce == null &&
    row.surfaceSnow == null &&
    row.surfaceWater == null
  )
    return null;
  const state = row.surfaceIce
    ? t('ice')
    : row.surfaceSnow
      ? t('snow')
      : row.surfaceWater
        ? t('wet')
        : t('dry');
  return known(row.grip)
    ? t('Surface sensor: {state}, grip {grip}', {
        state,
        grip: formatNumber(row.grip, {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        }),
      })
    : t('Surface sensor: {state}', { state });
}

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/**
 * Card for one station.
 * @param {object} row A normalized station.
 * @param {{mode?: 'surface'|'air'}} [options] Which temperature colours the accent.
 */
export function buildStationCard(row, { mode = 'surface' } = {}) {
  const details = [];
  if (known(row.surfaceTemp))
    details.push(
      t('Road surface {value}', { value: formatCelsius(row.surfaceTemp) }),
    );
  const air = airLine(row);
  if (air) details.push(air);
  if (row.risk) details.push(t(RISK_TEXT[row.risk]));
  for (const line of [windLine(row), precipitationLine(row), sensorLine(row)])
    if (line) details.push(line);
  if (known(row.visibility) && row.visibility < 10_000)
    details.push(
      t('Visibility {distance} km', {
        distance: oneDecimal(row.visibility / 1000),
      }),
    );
  details.push(
    t('Measured {time} · Trafikverket road weather station', {
      time: CLOCK.format(row.sampled),
    }),
  );
  const shown = mode === 'air' ? row.airTemp : row.surfaceTemp;
  return {
    ...CARD_BASE,
    id: `trafikverket-weather-card:${row.id}`,
    interactive: false,
    title: t('ROAD WEATHER · {station}', {
      station: row.name.toUpperCase(),
    }),
    details,
    accent: temperatureColor(
      known(shown) ? shown : (row.surfaceTemp ?? row.airTemp),
    ),
  };
}

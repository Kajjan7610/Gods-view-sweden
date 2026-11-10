/** Card model for a selected river flow station. Pure — no Cesium types. */
import { formatNumber, msg, t } from '../../i18n/index.js';
import { clockTime, measuredWhen } from '../measuredWhen.js';
import { flowClass, flowTrend } from './records.js';

export const RIVER_FLOW_OVERLAY_SOURCE_ID = 'river-flow';

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});
/** SMHI's quality codes worth a line; G (checked and approved) needs none. */
const QUALITY_NOTES = Object.freeze({
  O: msg('Unchecked value'),
  Y: msg('Roughly checked value'),
});

/** A discharge with sensible precision: 317, 34.8, 0.62. */
export function formatFlow(value) {
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return formatNumber(value, { maximumFractionDigits: digits });
}

/** An area with a decimal while it is small: 1.8, 49, 23,103. */
export function formatArea(km2) {
  return formatNumber(km2, { maximumFractionDigits: km2 < 10 ? 1 : 0 });
}

export function flowColor(value) {
  return flowClass(value)?.color || '#9e9e9e';
}

/** The change since the hour's first sample, named by that sample's time. */
function trendLine(row) {
  const trend = flowTrend(row);
  if (!trend || !Number.isFinite(row.since)) return null;
  const time = clockTime(row.since);
  const change = formatFlow(Math.abs(row.change));
  if (trend === 'rising')
    return t('Rising {change} m³/s since {time}', { change, time });
  if (trend === 'falling')
    return t('Falling {change} m³/s since {time}', { change, time });
  return t('Steady since {time}', { time });
}

/**
 * Card for one station.
 * @param {object} row A normalized station.
 * @param {number} [nowMs] The clock the reading's age is judged by.
 */
export function buildFlowCard(row, nowMs = Date.now()) {
  const details = [t('{flow} m³/s', { flow: formatFlow(row.flow) })];
  const trend = trendLine(row);
  if (trend) details.push(trend);
  // The name is the main river basin; the area is the station's own.
  const basin = [
    row.river,
    row.catchmentKm2 &&
      t('{area} km² upstream of the station', {
        area: formatArea(row.catchmentKm2),
      }),
  ].filter(Boolean);
  if (basin.length) details.push(basin.join(' · '));
  if (QUALITY_NOTES[row.quality]) details.push(t(QUALITY_NOTES[row.quality]));
  // i18n-ignore: agency names
  const credit =
    row.owner && row.owner !== 'SMHI' ? `${row.owner} · SMHI` : 'SMHI';
  details.push(
    `${t('Measured {time}', { time: measuredWhen(row.updated, nowMs) })} · ${credit}`,
  );
  return {
    ...CARD_BASE,
    id: `river-flow-card:${row.id}`,
    // Always hit-testable, so a click on the card is never the ground.
    interactive: true,
    title: t('RIVER FLOW · {station}', { station: row.name.toUpperCase() }),
    details,
    accent: flowColor(row.flow),
  };
}

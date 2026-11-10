/** Card model for a selected river flow station. Pure — no Cesium types. */
import { formatNumber, t } from '../../i18n/index.js';
import { flowClass, flowTrend } from './records.js';

export const RIVER_FLOW_OVERLAY_SOURCE_ID = 'river-flow';

const CLOCK = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  hour: '2-digit',
  minute: '2-digit',
});

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/** A discharge with sensible precision: 317, 34.8, 0.62. */
export function formatFlow(value) {
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return formatNumber(value, { maximumFractionDigits: digits });
}

export function flowColor(value) {
  return flowClass(value)?.color || '#9e9e9e';
}

function trendLine(row) {
  const trend = flowTrend(row);
  if (!trend) return null;
  const change = formatFlow(Math.abs(row.change));
  if (trend === 'rising')
    return t('Rising {change} m³/s over the last hour', { change });
  if (trend === 'falling')
    return t('Falling {change} m³/s over the last hour', { change });
  return t('Steady over the last hour');
}

/** Card for one station. */
export function buildFlowCard(row) {
  const details = [t('{flow} m³/s', { flow: formatFlow(row.flow) })];
  const trend = trendLine(row);
  if (trend) details.push(trend);
  if (row.river && row.catchmentKm2)
    details.push(
      t('{river} · catchment {area} km²', {
        river: row.river,
        area: formatNumber(Math.round(row.catchmentKm2)),
      }),
    );
  else if (row.river) details.push(row.river);
  // i18n-ignore: agency name
  details.push(
    `${t('Measured {time}', { time: CLOCK.format(row.updated) })} · SMHI`,
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

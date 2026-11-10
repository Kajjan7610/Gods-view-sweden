/** Card model for a selected gamma station. Pure — no Cesium types. */
import { formatNumber, t } from '../../i18n/index.js';
import { NORMAL_BACKGROUND, doseColor } from './records.js';

export const GAMMA_RADIATION_OVERLAY_SOURCE_ID = 'gamma-radiation';
export const SSM_GAMMA_PAGE = 'https://karttjanst.ssm.se/gammastationer';

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

/** A dose rate as SSM writes it: two or three decimals. */
export function formatDose(value) {
  return formatNumber(value, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 3,
  });
}

/** Card for one station. */
export function buildGammaCard(row) {
  const details = [
    row.value == null
      ? t('Station in service or maintenance')
      : t('{value} µSv/h ambient dose rate', { value: formatDose(row.value) }),
    t('Normal background in Sweden: {min}–{max} µSv/h', {
      min: formatDose(NORMAL_BACKGROUND.min),
      max: formatDose(NORMAL_BACKGROUND.max),
    }),
    // i18n-ignore: agency name
    `${t('Measured {time}', { time: CLOCK.format(row.updated) })} · Strålsäkerhetsmyndigheten`,
  ];
  return {
    ...CARD_BASE,
    id: `gamma-radiation-card:${row.id}`,
    // Always hit-testable, so a click on the card is never the ground.
    interactive: true,
    title: t('RADIATION · {station}', { station: row.name.toUpperCase() }),
    details,
    accent: doseColor(row.value),
  };
}

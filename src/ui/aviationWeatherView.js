/**
 * Aviation weather as the airport board and the cockpit say it (Swedish
 * fork): a one-line summary and the decoded rows of a METAR report from
 * /api/aviation-weather (server/providers/aviationWeather.js).
 */
import { formatNumber, getLocale, msg, t } from '../i18n/index.js';

const COVERS = Object.freeze({
  FEW: msg('few clouds'),
  SCT: msg('scattered clouds'),
  BKN: msg('broken clouds'),
  OVC: msg('overcast'),
  VV: msg('sky obscured'),
});
/** The flight categories' customary colours. */
export const CATEGORY_COLORS = Object.freeze({
  VFR: '#69f0ae',
  MVFR: '#4fc3f7',
  IFR: '#ff5252',
  LIFR: '#e040fb',
});

const clock = (ms) =>
  new Intl.DateTimeFormat(getLocale(), {
    timeZone: 'Europe/Stockholm',
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms);

/** "260° 7 kt", "variable 3 kt", "calm", with gusts when reported. */
export function windText(report) {
  if (report.windKt === null) return '';
  if (report.windKt === 0) return t('calm');
  const base = report.windVariable
    ? t('variable {kt} kt', { kt: report.windKt })
    : t('{dir}° {kt} kt', {
        dir: String(report.windDir ?? 0).padStart(3, '0'),
        kt: report.windKt,
      });
  return report.gustKt
    ? `${base} ${t('gusts {kt} kt', { kt: report.gustKt })}`
    : base;
}

/** "10 km or more", "2.5 km", "800 m". */
export function visibilityText(report) {
  const m = report.visibilityM;
  if (m === null) return '';
  if (m >= 9999) return t('10 km or more');
  if (m < 1000) return t('{m} m', { m: formatNumber(m) });
  return t('{km} km', {
    km: formatNumber(m / 1000, { maximumFractionDigits: 1 }),
  });
}

/** One cloud layer, "broken clouds 2,400 ft". */
const layerText = (layer) =>
  [
    COVERS[layer.cover] ? t(COVERS[layer.cover]) : layer.cover,
    layer.baseFt !== null
      ? t('{ft} ft', { ft: formatNumber(layer.baseFt) })
      : '',
  ]
    .filter(Boolean)
    .join(' ');

/** The lowest layer that matters: the ceiling, else the lowest reported. */
export function cloudText(report) {
  if (report.cavok) return 'CAVOK'; // i18n-ignore: aviation code
  const lead =
    report.clouds.find((layer) => ['BKN', 'OVC', 'VV'].includes(layer.cover)) ??
    report.clouds[0];
  return lead ? layerText(lead) : '';
}

/** One line for a header or a cockpit row. */
export function weatherLine(report) {
  if (!report) return '';
  return [
    windText(report),
    visibilityText(report),
    cloudText(report),
    report.temperatureC !== null
      ? t('{c} °C', { c: formatNumber(report.temperatureC) })
      : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Every decoded row, for the board's weather tab. */
export function weatherRows(report) {
  if (!report) return [];
  return [
    [t('Observed'), report.observed ? clock(report.observed) : ''],
    [t('Wind'), windText(report)],
    [t('Visibility'), visibilityText(report)],
    [
      t('Clouds'),
      report.cavok
        ? 'CAVOK' // i18n-ignore: aviation code
        : report.clouds.map(layerText).join(', '),
    ],
    [t('Weather'), report.weather ?? ''],
    [
      t('Temperature'),
      report.temperatureC !== null
        ? [
            t('{c} °C', { c: formatNumber(report.temperatureC) }),
            report.dewpointC !== null
              ? t('dew point {c} °C', { c: formatNumber(report.dewpointC) })
              : '',
          ]
            .filter(Boolean)
            .join(' · ')
        : '',
    ],
    ['QNH', report.qnhHpa !== null ? `${report.qnhHpa} hPa` : ''], // i18n-ignore: aviation code
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => ({ label, value }));
}

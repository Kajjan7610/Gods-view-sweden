/** Card text for a wind turbine. Pure — no Cesium types. */
import { formatDate, formatNumber, msg, t } from '../../i18n/index.js';
import { yearText } from '../analystRows.js';
import { wrapLine } from '../frostDepth/cards.js';
import { TURBINE_KIND, TURBINE_STATUSES } from './records.js';

export const WIND_TURBINES_OVERLAY_SOURCE_ID = 'wind-turbines';

/** The legend kinds in the reader's language. */
export const TURBINE_KIND_LABELS = Object.freeze({
  built: msg('Built turbines'),
  planned: msg('Planned – not built'),
  dismantled: msg('Dismantled turbines'),
  rejected: msg('Application rejected'),
  withdrawn: msg('Not current or withdrawn'),
  unknown: msg('Status not given'),
});

/**
 * Each register status in words, neutrally and as the register states it:
 * never why a case went the way it did.
 */
const STATUS_WORDS = Object.freeze({
  Uppfört: msg('Erected'),
  Beviljat: msg('Planned – not built (permit granted)'),
  Handläggs: msg('Planned – not built (application being processed)'),
  Överklagat: msg('Planned – not built (decision appealed)'),
  Avslag: msg('Application rejected (per Vindbrukskollen)'),
  'Inte aktuellt eller återkallat': msg(
    'Not current or withdrawn (per Vindbrukskollen)',
  ),
  Nedmonterat: msg('Dismantled'),
  'Uppgift saknas': msg('Status not given'),
});

/** A turbine's status in the reader's language. */
export const statusWords = (row) =>
  t(
    STATUS_WORDS[TURBINE_STATUSES[row?.status]?.status] ??
      STATUS_WORDS['Uppgift saknas'],
  );

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/** What a turbine is called: its project, else its municipality. */
export const turbineName = (row) =>
  row?.project || row?.municipality || t('Wind turbine');

/** A register date (yyyy-mm-dd) as the reader writes it, or ''. */
export function formatRegisterDate(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''));
  if (!match) return '';
  return formatDate(Date.UTC(+match[1], +match[2] - 1, +match[3]), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * The year a turbine was built, as text, or null: only a built or
 * dismantled turbine has one (a planned one's date is not a build year).
 */
export const builtYear = (row) =>
  row?.kind === 'built' || row?.kind === 'dismantled'
    ? yearText(Number(String(row?.built ?? '').slice(0, 4)) || null)
    : null;

const metres = (value) => formatNumber(value, { maximumFractionDigits: 0 });

/**
 * Card for one turbine.
 * @param {object} row A turbine: a view's row, or its full row once read.
 * @param {{snapshotAt?: number|null}} [options] When the snapshot was made.
 */
export function buildTurbineCard(row, { snapshotAt = null } = {}) {
  const size = [
    ...(row.totalHeightM
      ? [t('Total height {value} m', { value: metres(row.totalHeightM) })]
      : []),
    ...(row.hubHeightM
      ? [t('Hub height {value} m', { value: metres(row.hubHeightM) })]
      : []),
  ].join(' · ');
  const output = [
    ...(row.powerMW
      ? [
          t('{power} MW rated', {
            power: formatNumber(row.powerMW, { maximumFractionDigits: 2 }),
          }),
        ]
      : []),
    ...(row.productionGWh
      ? [
          t('Calculated production {value} GWh/yr', {
            value: formatNumber(row.productionGWh, {
              maximumFractionDigits: 1,
            }),
          }),
        ]
      : []),
  ].join(' · ');
  const year = builtYear(row);
  const updated = formatRegisterDate(row.updated);
  const snapshot = Number.isFinite(snapshotAt)
    ? formatRegisterDate(new Date(snapshotAt).toISOString().slice(0, 10))
    : '';
  const makeModel = [row.make, row.model].filter(Boolean).join(' ');
  const details = [
    t('Status: {status}', { status: statusWords(row) }),
    size,
    ...(row.rotorM
      ? [t('Rotor diameter {value} m', { value: metres(row.rotorM) })]
      : []),
    output,
    ...(makeModel ? [t('Make: {make}', { make: makeModel })] : []),
    ...(year ? [t('Built in {year}', { year })] : []),
    [row.municipality, row.county].filter(Boolean).join(', '),
    ...(row.zone ? [t('Bidding zone {zone}', { zone: row.zone })] : []),
    ...(row.operator ? [t('Operator: {name}', { name: row.operator })] : []),
    ...(updated
      ? [t('Updated in Vindbrukskollen {date}', { date: updated })]
      : []),
    t('Source: Länsstyrelserna, Vindbrukskollen (CC0)'),
    ...(snapshot ? [t('Snapshot {date}', { date: snapshot })] : []),
  ].filter(Boolean);
  return {
    ...CARD_BASE,
    id: `wind-turbines-card:${row.id}`,
    interactive: true,
    title: t('WIND TURBINE · {name}', {
      name: turbineName(row).toUpperCase(),
    }),
    details: details.flatMap((line) => wrapLine(line)),
    accent: TURBINE_KIND[row.kind]?.color ?? TURBINE_KIND.unknown.color,
  };
}

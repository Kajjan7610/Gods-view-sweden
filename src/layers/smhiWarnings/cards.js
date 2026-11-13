/** Card model for a selected SMHI warning area. Pure — no Cesium types. */
import { getLocale, msg, t } from '../../i18n/index.js';
import { levelColor } from './records.js';
import { CRISIS_KINDS } from './crisis.js';
import { foldText } from '../../ui/cardText.js';

export { foldText };

export const SMHI_WARNINGS_OVERLAY_SOURCE_ID = 'smhi-warnings';
/** SMHI's own page with every warning and message in full. */
export const SMHI_WARNINGS_PAGE =
  'https://www.smhi.se/vader/prognoser-och-varningar/varningar-och-meddelanden';

export const LEVEL_TITLES = Object.freeze({
  MESSAGE: msg('Message'),
  YELLOW: msg('Yellow warning'),
  ORANGE: msg('Orange warning'),
  RED: msg('Red warning'),
});

// Swedish data, Swedish clock: the times read as SMHI publishes them.
const CLOCK = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});
const when = (ms) => (Number.isFinite(ms) ? CLOCK.format(ms) : null);

/** SMHI writes Swedish and English; other UI languages read the English. */
export function warningLanguage(locale = getLocale()) {
  return String(locale || '').startsWith('sv') ? 'sv' : 'en';
}

function validity(row) {
  const from = when(row.start);
  const to = when(row.end);
  if (from && to) return `${from} → ${to}`;
  if (from) return t('from {time}', { time: from });
  if (to) return t('until {time}', { time: to });
  return null;
}

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/**
 * Card for one warning area; a linked card opens SMHI's warning page.
 * @param {object} row A normalized warning area.
 * @param {{linkable?: boolean, language?: 'sv'|'en'}} [options]
 */
export function buildWarningCard(
  row,
  { linkable = false, language = warningLanguage() } = {},
) {
  const pick = (node) => node?.[language] || node?.en || node?.sv || null;
  const headline = pick(row.description) || pick(row.event) || '';
  const details = [];
  const counties = row.counties.map(pick).filter(Boolean);
  const place = pick(row.area);
  const where = [
    place,
    ...counties.filter((county) => county !== place),
  ].filter(Boolean);
  if (where.length) details.push(where.join(' · '));
  const valid = validity(row);
  if (valid) details.push(valid);
  const textOf = (code) =>
    pick(row.texts.find((entry) => entry.code === code)?.text);
  // SMHI's terms: warnings may be used freely but not altered, so the card
  // carries the whole text (wrapped, never cut short in practice) rather
  // than an excerpt.
  const happens = textOf('HAPPENS') || textOf('INCIDENT');
  if (happens) details.push(...foldText(happens, 12));
  const affect = textOf('AFFECT');
  if (affect)
    for (const line of affect.split('\n').filter((part) => part.trim()))
      details.push(...foldText(line, 6));
  if (Number.isFinite(row.published))
    details.push(t('Published {time} · SMHI', { time: when(row.published) }));
  if (linkable) details.push(t('SMHI ↗ · click card to open'));
  const title = `${t(LEVEL_TITLES[row.level] || LEVEL_TITLES.MESSAGE)}${
    headline ? ` · ${headline}` : ''
  }`.toUpperCase();
  return {
    ...CARD_BASE,
    id: `smhi-warning-card:${row.id}`,
    // Always hit-testable, so a click on the card is never the ground.
    interactive: true,
    ...(linkable
      ? { accessibilityLabel: t('Open {title} at SMHI', { title }) }
      : undefined),
    title,
    details,
    accent: levelColor(row.level),
  };
}

/**
 * Card for one Krisinformation.se message; a linked card opens it there.
 * The texts are Swedish only, as MCF publishes them.
 * @param {object} row A normalized crisis item.
 * @param {{linkable?: boolean}} [options]
 */
export function buildCrisisCard(row, { linkable = false } = {}) {
  const details = [];
  const where =
    row.scope === 'country'
      ? t('Applies to all of Sweden')
      : row.scope === 'county'
        ? t('{place} · drawn at the county centre', { place: row.place })
        : row.scope === 'unplaced'
          ? row.place || t('Krisinformation names no place')
          : row.place;
  if (where) details.push(where);
  if (row.preamble) details.push(...foldText(row.preamble, 4));
  const stamp = [
    Number.isFinite(row.published) ? when(row.published) : null,
    row.sender,
  ].filter(Boolean);
  if (stamp.length) details.push(stamp.join(' · '));
  const link = linkable && row.link;
  if (link) details.push(t('krisinformation.se ↗ · click card to open'));
  const title =
    `${row.kind === 'vma' ? 'VMA' : t('CRISIS INFORMATION')} · ${row.headline}`.toUpperCase();
  return {
    ...CARD_BASE,
    id: `krisinformation-card:${row.id}`,
    // Always hit-testable, so a click on the card is never the ground.
    interactive: true,
    ...(link
      ? {
          accessibilityLabel: t('Open {title} at krisinformation.se', {
            title,
          }),
        }
      : undefined),
    title,
    details,
    accent:
      CRISIS_KINDS.find((kind) => kind.id === row.kind)?.color || '#40c4ff',
  };
}

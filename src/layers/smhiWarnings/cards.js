/** Card model for a selected SMHI warning area. Pure — no Cesium types. */
import { getLocale, msg, t } from '../../i18n/index.js';
import { levelColor } from './records.js';

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

/** Card lines never wrap, so long SMHI prose is folded into short ones. */
const LINE_CHARS = 80;

/**
 * Word-wrap text into at most `maxLines` lines of LINE_CHARS; an ellipsis
 * marks what was left out.
 */
export function foldText(value, maxLines) {
  const words = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length <= LINE_CHARS || !line) {
      line = next.slice(0, LINE_CHARS);
      continue;
    }
    lines.push(line);
    line = word.slice(0, LINE_CHARS);
    if (lines.length === maxLines) {
      lines[maxLines - 1] = `${lines[maxLines - 1].slice(0, LINE_CHARS - 1)}…`;
      return lines;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, maxLines);
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
  const happens = textOf('HAPPENS') || textOf('INCIDENT');
  if (happens) details.push(...foldText(happens, 3));
  const affect = textOf('AFFECT');
  if (affect) details.push(...foldText(affect.split('\n')[0], 2));
  if (Number.isFinite(row.published))
    details.push(t('Published {time} · SMHI', { time: when(row.published) }));
  if (linkable) details.push(t('SMHI ↗ · click card to open'));
  const title = `${t(LEVEL_TITLES[row.level] || LEVEL_TITLES.MESSAGE)}${
    headline ? ` · ${headline}` : ''
  }`.toUpperCase();
  return {
    ...CARD_BASE,
    id: `smhi-warning-card:${row.id}`,
    interactive: Boolean(linkable),
    ...(linkable
      ? { accessibilityLabel: t('Open {title} at SMHI', { title }) }
      : undefined),
    title,
    details,
    accent: levelColor(row.level),
  };
}

// Swedish fork: a shipped story's chapter caption may quote live numbers
// from the layers it shows ("Kp 4 right now"). A chapter lists its caption
// candidates in order; the first whose numbers are all known now, and whose
// condition holds, is shown. The last candidate quotes nothing, so a chapter
// always has a true caption, also when a feed is down.
import { formatNumber, t } from '../i18n/index.js';

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * One live number from a layer: `aurora.kp` asks the aurora layer's
 * `storyFacts()` for `kp`, `aurora.chance.Kiruna` for `chance.Kiruna`.
 * @param {{layers?: Map<string, {module?: object}>}|null} dataManager
 * @param {string} key
 * @returns {number|null}
 */
export function readStoryFact(dataManager, key) {
  const dot = typeof key === 'string' ? key.indexOf('.') : -1;
  if (dot <= 0) return null;
  const layerId = key.slice(0, dot);
  // A layer the person (or the shot) turned off says nothing.
  if (dataManager?.isEnabled && !dataManager.isEnabled(layerId)) return null;
  const layer = dataManager?.layers?.get?.(layerId);
  let facts;
  try {
    facts = layer?.module?.storyFacts?.();
  } catch {
    return null;
  }
  const value = facts?.[key.slice(dot + 1)];
  return Number.isFinite(value) ? value : null;
}

/** Whether a candidate's condition holds for the numbers it reads. */
function holds(when, values) {
  for (const [name, test] of Object.entries(when ?? {})) {
    const value = values[name];
    if (!Number.isFinite(value)) return false;
    if (test.below != null && !(value < test.below)) return false;
    if (test.atLeast != null && !(value >= test.atLeast)) return false;
  }
  return true;
}

/**
 * A chapter's caption in the page's language.
 * @param {{caption?: string, captions?: {text: string, when?: object}[],
 *   facts?: Record<string, string>}} chapter `facts` names the layer fact
 *   behind each placeholder (`{kp: 'aurora.kp'}`).
 * @param {(key: string) => number|null} factOf
 * @param {typeof t} [translate]
 * @returns {string}
 */
export function chapterCaption(chapter, factOf, translate = t) {
  const candidates = chapter?.captions;
  if (!Array.isArray(candidates) || !candidates.length)
    return chapter?.caption ? translate(chapter.caption) : '';
  const values = {};
  for (const [name, key] of Object.entries(chapter.facts ?? {})) {
    const value = factOf?.(key);
    if (Number.isFinite(value)) values[name] = value;
  }
  for (const candidate of candidates) {
    const names = [...candidate.text.matchAll(PLACEHOLDER)].map((m) => m[1]);
    if (!names.every((name) => name in values)) continue;
    if (!holds(candidate.when, values)) continue;
    return translate(
      candidate.text,
      Object.fromEntries(
        names.map((name) => [
          name,
          formatNumber(values[name], { maximumFractionDigits: 1 }),
        ]),
      ),
    );
  }
  return '';
}

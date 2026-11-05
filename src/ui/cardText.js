/** Text helpers for overlay cards. Pure — no Cesium types. */

/** Card lines never wrap, so long prose is folded into short ones. */
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

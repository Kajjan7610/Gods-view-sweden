/**
 * The text size (Swedish fork): Normal keeps the original look, Larger and
 * Largest lift the cockpit's and the panels' smallest and faintest text
 * (src/ui/styles/sverige-legibility.css). The choice is the viewer's own and
 * lives in this browser; it shows as `data-text-size` on the root element.
 */
export const TEXT_SIZES = Object.freeze(['normal', 'large', 'largest']);
export const TEXT_SIZE_STORAGE_KEY = 'gev:text-size:v1';
export const DEFAULT_TEXT_SIZE = 'large';

/** The stored size, or the default when none (or an unknown one) is kept. */
export function readTextSize(storage) {
  try {
    const value = storage?.getItem(TEXT_SIZE_STORAGE_KEY);
    return TEXT_SIZES.includes(value) ? value : DEFAULT_TEXT_SIZE;
  } catch {
    return DEFAULT_TEXT_SIZE;
  }
}

/** Keep a size; storage may be missing or refuse (private windows). */
export function saveTextSize(storage, size) {
  try {
    storage?.setItem(TEXT_SIZE_STORAGE_KEY, size);
  } catch {
    /* no-op */
  }
}

/** The size after `size`, round to Normal after Largest. */
export const nextTextSize = (size) =>
  TEXT_SIZES[(TEXT_SIZES.indexOf(size) + 1) % TEXT_SIZES.length];

/** Show a size on the root element, where the stylesheet reads it. */
export function applyTextSize(
  size,
  root = globalThis.document?.documentElement,
) {
  if (root?.dataset) root.dataset.textSize = size;
}

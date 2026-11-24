// Swedish fork: a rail's tooltips draw above the rail they belong to and
// above the city arrival card, which sits below the rails and their panels.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readStylesheet } from '../testSupport/readStylesheet.mjs';

const css = readStylesheet(new URL('../../style.css', import.meta.url)).replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

/**
 * The z-index the application's stylesheet gives `selector` in the end: the
 * last one declared by a rule whose selector list holds it exactly.
 */
function zIndexOf(selector) {
  const wanted = selector.replace(/\s+/g, ' ').trim();
  let found = null;
  for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const list = selectors
      .split(',')
      .map((part) => part.replace(/\s+/g, ' ').trim());
    if (!list.includes(wanted)) continue;
    const value = /(?:^|;)\s*z-index:\s*(-?\d+)/.exec(body)?.[1];
    if (value !== undefined) found = Number(value);
  }
  assert.notEqual(found, null, `no z-index for ${selector}`);
  return found;
}

test("a rail item's tip draws above the rail's other items and names", () => {
  const tip = zIndexOf('.ui-tooltip__tip');
  // While the open panel's highlight shows, every item sits at this level.
  assert.ok(tip > zIndexOf('.ui-rail--glide .ui-rail__item'));
  // In the labelled left rail, the names beside the icons.
  assert.ok(
    tip > zIndexOf('.gev-panel-rail--left .ui-rail--expanded .ui-rail__label'),
  );
});

test('the city arrival card sits below both rails and their panels', () => {
  const card = zIndexOf('.city-arrival');
  assert.ok(card < zIndexOf('#left-panel-stack'));
  assert.ok(card < zIndexOf('#right-context-rail'));
  // Still above the map's own labels and cards.
  assert.ok(card > zIndexOf('#world-overlay-root'));
});

// Swedish fork: the HUD's plain summary line says only what the HUD shows.
// The off-nadir angle (ONA) is hidden with the other satellite figures
// (IntelHudView.vue), so the line leaves it out too, in every language.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './testSupport/stubMgrs.mjs';
import { hudReadouts } from './testSupport/hudReadouts.mjs';
import { fakeCameraPort } from './testSupport/fakeCameraPort.mjs';

const { IntelHUD } = await import('./hud.js');
const { setLocale } = await import('./i18n/index.js');

/** A HUD over Stockholm with its latest metrics as the telemetry tick leaves them. */
function stockholmHud(t) {
  const { elements, publish } = hudReadouts();
  const previous = globalThis.document;
  globalThis.document = {
    hidden: false,
    visibilityState: 'visible',
    getElementById: (id) => elements.get(id) ?? null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  const hud = new IntelHUD(
    {},
    {
      camera: fakeCameraPort({
        pose: { lat: 59.33, lon: 18.07, height: 1200, pitch: -0.6 },
      }).port,
      publish,
    },
  );
  t.after(() => {
    hud.destroy();
    setLocale('en');
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  // A tilted camera: an off-nadir angle the old line printed as "ONA 56°".
  hud._latestMetrics = {
    latDeg: 59.33,
    lonDeg: 18.07,
    altM: 1200,
    altMslM: 1176,
    sunEl: 8.4,
    ona: 55.6,
  };
  return hud;
}

for (const [locale, sun] of [
  ['en', /\| SUN 8° \|/],
  ['sv', /\| SOL 8° \|/],
]) {
  test(`the ${locale} summary line has no off-nadir angle`, (t) => {
    const hud = stockholmHud(t);
    setLocale(locale);
    const line = hud._composeSummary();
    assert.match(line, sun, line);
    assert.doesNotMatch(line, /\bONA\b/, line);
    assert.doesNotMatch(line, /56°/, line);
  });
}

// Swedish fork: over Sweden the zone is Sweden's own clock at the HUD's world
// time, UTC+2 in summer, not the longitude's UTC+1.
test('over Stockholm in summer the summary names UTC+2', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.UTC(2026, 6, 15, 12) });
  const hud = stockholmHud(t);
  setLocale('sv');
  const line = hud._composeSummary();
  assert.match(line, /\| UTC\+2$/, line);
});

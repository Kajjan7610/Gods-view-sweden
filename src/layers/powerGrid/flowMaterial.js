/**
 * A polyline material for a power flow: chevrons pointing the way the power
 * runs, moving along the line faster the larger the flow. Readers who ask the
 * system for reduced motion get still chevrons.
 */
import * as Cesium from 'cesium';

const MATERIAL_TYPE = 'GevPowerFlow';

// st.s runs along the line from its first position, st.t across it. A
// chevron is a band whose edges sit behind its middle, so it points forward.
const MATERIAL_SOURCE = `czm_material czm_getMaterial(czm_materialInput materialInput)
{
  czm_material material = czm_getDefaultMaterial(materialInput);
  vec2 st = materialInput.st;
  float across = abs(st.t - 0.5) * 2.0;
  float along = fract(st.s * repeat - offset);
  float chevron = along + across * 0.35;
  float mark = step(0.55, chevron) * step(chevron, 0.85);
  material.diffuse = czm_gammaCorrect(color.rgb);
  material.alpha = color.a * mix(0.35, 1.0, mark);
  return material;
}
`;

function registerMaterial() {
  const cache = Cesium.Material._materialCache;
  if (cache.getMaterial(MATERIAL_TYPE)) return;
  cache.addMaterial(MATERIAL_TYPE, {
    fabric: {
      type: MATERIAL_TYPE,
      uniforms: {
        color: new Cesium.Color(1, 1, 1, 1),
        repeat: 6,
        offset: 0,
      },
      source: MATERIAL_SOURCE,
    },
    translucent: () => true,
  });
}

/** Whether the reader asked the system for reduced motion. */
export const reducedMotion = () =>
  globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true;

/** Chevron cycles per second for a flow: a crawl at a trickle, brisk at 6 GW. */
export function flowSpeed(mw) {
  return Math.min(2.5, 0.25 + Math.max(0, mw) / 3000);
}

/** Chevrons along a line of this many kilometres: about one per 120 km. */
export function flowRepeat(km) {
  return Math.max(3, Math.round(km / 120));
}

/**
 * The entity material for one flow. Not constant: its offset moves with the
 * clock, so Cesium asks for it every frame.
 */
export class FlowMaterialProperty {
  /**
   * @param {Cesium.Color} color
   * @param {number} repeat Chevrons along the line.
   * @param {number} speed Chevron cycles per second.
   */
  constructor(color, repeat, speed) {
    registerMaterial();
    this.color = color;
    this.repeat = repeat;
    this.speed = reducedMotion() ? 0 : speed;
    this.definitionChanged = new Cesium.Event();
  }

  get isConstant() {
    return this.speed === 0;
  }

  getType() {
    return MATERIAL_TYPE;
  }

  getValue(time, result = {}) {
    result.color = this.color;
    result.repeat = this.repeat;
    result.offset = ((performance.now() / 1000) * this.speed) % 1;
    return result;
  }

  equals(other) {
    return this === other;
  }
}

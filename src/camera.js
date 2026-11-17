import { toRadians } from './geo/index.js';
import { cameraOf } from './render/rendererOf.js';

/**
 * The view the renderer starts from: the whole planet, looking straight
 * down, centred where Cesium's default view rectangle is.
 */
export const START_VIEW = Object.freeze({
  lon: -82.5,
  lat: 35,
  height: 23000000,
});

/**
 * Swedish fork: a fresh load (no share link) starts over Västerås, about a
 * kilometre south of the centre, looking north across it.
 */
export const SWEDISH_START_VIEW = Object.freeze({
  name: 'Västerås',
  lon: 16.5448,
  lat: 59.6005,
  height: 700,
  heading: 10,
  pitch: -30,
});

/**
 * Put the camera at a start view without a flight. A host may pass a city
 * (`{ lon, lat, height, heading?, pitch? }`, angles in degrees) instead of
 * the planet.
 */
export function applyStartView(viewer, view = START_VIEW) {
  const { lon, lat, height, heading = 0, pitch = -90 } = view;
  cameraOf(viewer).setView({
    destination: { lon, lat, height },
    orientation: {
      heading: toRadians(heading),
      pitch: toRadians(pitch),
      roll: 0,
    },
  });
}

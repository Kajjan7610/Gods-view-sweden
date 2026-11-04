import * as Cesium from 'cesium';

/**
 * Where a fresh load (no share link) flies to. The Swedish fork starts over
 * Västerås; upstream starts over Austin, TX (-97.7431, 30.2672). The camera
 * lands about a kilometre south of the centre, looking north across it.
 */
export const HOME_VIEW = Object.freeze({
  name: 'Västerås',
  lon: 16.5448,
  lat: 59.6005,
  heightM: 700,
  headingDeg: 10,
  pitchDeg: -30,
});

/**
 * Set camera over the home view on load with a cinematic fly-in.
 * @returns {Function} Cancels the pending or active startup flight.
 */
export function flyToHome(viewer, home = HOME_VIEW) {
  // Start from a high altitude, then fly down
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(home.lon, home.lat, 25000),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-90),
      roll: 0.0,
    },
  });

  // Cinematic fly-in after a brief pause
  const timer = setTimeout(() => {
    if (viewer.isDestroyed()) return;
    viewer.camera.flyTo({
      destination: Cesium.Cartesian3.fromDegrees(
        home.lon,
        home.lat,
        home.heightM,
      ),
      orientation: {
        heading: Cesium.Math.toRadians(home.headingDeg),
        pitch: Cesium.Math.toRadians(home.pitchDeg),
        roll: 0.0,
      },
      duration: 4.0,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
  }, 500);
  return () => {
    clearTimeout(timer);
    if (!viewer.isDestroyed()) viewer.camera.cancelFlight();
  };
}

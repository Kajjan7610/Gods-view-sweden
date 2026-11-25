import { createTransitLayer } from '../../layers/transit/index.js';
import * as render from '../../renderGovernor.js';
import { fleetModelServices } from './fleetModels.js';
import * as sprites from '../../data/spriteOrder.js';
import * as picking from '../../data/pickRegistry.js';
import * as overlays from '../../overlays/worldOverlay.js';
import {
  registerDynamicCredit,
  transitFeedCredit,
} from '../../data/dataCredits.js';

// Swedish fork: buses and trams turn from icon into model nearer the camera
// than the aircraft distances the fleet service carries (3 km, kept to
// 3.6 km): a 12 m bus drawn life size 2 km away is a few pixels across, too
// small to see or click, while its 20 px icon is hidden. Measured in the
// app, it is still about 10 px at 530 m; within 300 m it is about as big
// as its icon; 400 m is the hysteresis band's outer edge, so a model on the
// edge is not dropped and loaded again as the camera moves. Every vehicle
// this layer draws takes them, its metro, rail and ferry modes too; the Rail
// layer's trains keep the aircraft distances (rail.js): they are long.
// Metres, eye to vehicle.
const TRANSIT_MODEL_ADD_M = 300;
const TRANSIT_MODEL_KEEP_M = 400;

/**
 * Swedish fork: `services` with the fleet-model service's add and keep
 * distances replaced by transit's own; its 3D preference, altitude ceiling,
 * caps, cadence and asset resolver stay the shared service's.
 * @param {object} services
 * @returns {object}
 */
function withTransitModelDistances(services) {
  const fleet = services.fleet;
  if (!fleet) return services;
  return {
    ...services,
    fleet: Object.freeze({
      ...fleet,
      policy: Object.freeze({
        ...fleet.policy,
        addM: TRANSIT_MODEL_ADD_M,
        keepM: TRANSIT_MODEL_KEEP_M,
      }),
    }),
  };
}

/**
 * Construct one layer using the application scene owners and the
 * application's surface services.
 *
 * The floor comes from `surface.groundFloor` — the ONE instance aircraft,
 * trails, fires and camera geometry stand on — and the rendered-mesh sampler
 * from `surface.meshFloor`, so a mesh floor the application resolves for a
 * cell is the floor transit draws on, and a transit-only session warms its
 * own mesh floors. An earlier cut imported the legacy module-level singleton
 * instead and could not see either.
 *
 * `displayParams` reads the Flights layer's DISPLAY-rail 3D preference, under
 * which nearby vehicles are drawn as fleet models (Swedish fork: within
 * transit's own distances, TRANSIT_MODEL_ADD_M and TRANSIT_MODEL_KEEP_M).
 *
 * `placement` is a host-supplied placement for its live vehicles, or null.
 * @param {{surface: object, source?: object, placement?: object|null,
 *   displayParams?: () => object|null, resolveAsset?: (url: string) => string}} options
 * @returns {object}
 */
export function createApplicationTransit({
  surface,
  source,
  placement = null,
  displayParams = null,
  resolveAsset,
}) {
  if (!surface?.groundFloor || !surface?.meshFloor)
    throw new TypeError('Transit needs the application surface services');
  const { groundFloor, meshFloor } = surface;
  return createTransitLayer({
    source,
    // Swedish fork: with transit's own model distances.
    services: withTransitModelDistances({
      render,
      sprites,
      picking,
      overlays,
      placement,
      credits: { registerDynamicCredit, transitFeedCredit },
      ground: {
        GROUND_FLOOR_LIFT_M: groundFloor.GROUND_FLOOR_LIFT_M,
        cachedGroundFloor: groundFloor.cachedGroundFloor,
        coarseFloorCoord: groundFloor.coarseFloorCoord,
        neighborFloorM: groundFloor.neighborFloorM,
        warmGroundFloor: groundFloor.warmGroundFloor,
        corridorFloorCells: groundFloor.corridorFloorCells,
        allocateCorridorCells: groundFloor.allocateCorridorCells,
      },
      mesh: { sampleMeshFloorCells: meshFloor.sampleMeshFloorCells },
      fleet: fleetModelServices({
        display: displayParams,
        ...(resolveAsset ? { resolveAsset } : {}),
      }),
    }),
  });
}

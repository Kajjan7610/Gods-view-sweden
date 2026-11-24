import { createApplicationControls } from '../app/controls.js';
import { getStandaloneCatalog } from './catalog.js';
// Swedish fork: the driver's view on buses, trams and trains.
import { createCockpitRides } from './cockpitRides.js';
import { requestWorldFocus } from '../worldFocus.js';
export function createStandaloneControls(options) {
  const catalog = options?.catalog ?? getStandaloneCatalog();
  const given = options?.services?.cockpitSubjects;
  return createApplicationControls({
    catalog,
    ...options,
    // Swedish fork: the Cockpit also rides the bus, tram or train selected
    // on the map (cockpitRides.js), after any subjects a caller gives.
    services: {
      ...options?.services,
      cockpitSubjects: [
        ...(Array.isArray(given) ? given : []),
        ...createCockpitRides({
          rail: catalog?.get?.('rail'),
          transit: catalog?.get?.('transit'),
          requestWorldFocus,
        }),
      ],
    },
  });
}

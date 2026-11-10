// The city dossier's controller: the live picture is fetched only for someone
// looking at it, a part that does not answer is named, and a first visit
// glides into its orbit instead of cutting to it.
import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createCityDossier } from './cityDossier.js';

const NOW = Date.parse('2026-11-05T14:00:00Z');
const TOWNS = {
  arboga: {
    code: '1984',
    name: 'Arboga',
    municipality: 'Arboga',
    county: 'Västmanlands län',
    point: [15.8269, 59.3994],
  },
  koping: {
    code: '1983',
    name: 'Köping',
    municipality: 'Köping',
    county: 'Västmanlands län',
    point: [15.9977, 59.514],
  },
  orebro: {
    code: '1880',
    name: 'Örebro',
    municipality: 'Örebro',
    county: 'Örebro län',
    point: [15.2134, 59.2741],
  },
};
const LIVE_ROUTES = [
  '/api/regional-brief',
  '/api/air-quality-se',
  '/api/polisen-events',
  '/api/city-transit',
  '/api/aurora-outlook',
  '/api/speed-cameras',
  '/api/krisinformation',
];
const route = (url) => String(url).split('?')[0];
/** Let the fetches that were started, and what follows them, run. */
const settle = async () => {
  for (let i = 0; i < 8; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

function harness(t, { stamps = {} } = {}) {
  // The settle timer, the orbit's watch and the title card never fire alone.
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  t.mock.method(console, 'warn', () => {});
  const state = {
    now: NOW,
    town: TOWNS.arboga,
    height: 3000,
    panelOpen: false,
    panelChanged: null,
    urls: [],
    down: new Set(),
    view: null,
    actions: null,
    flights: [],
    cancelled: 0,
    orbits: [],
    stops: 0,
    listeners: new Map(),
  };
  const viewer = {
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600 },
      requestRender() {},
    },
    dataSources: { add() {}, remove() {} },
    camera: {
      heading: 0.5,
      get positionCartographic() {
        return { height: state.height };
      },
      get positionWC() {
        return Cesium.Cartesian3.fromDegrees(...state.town.point, 3000);
      },
      pickEllipsoid: () =>
        Cesium.Cartesian3.fromDegrees(...state.town.point, 0),
      moveEnd: { addEventListener: () => () => {} },
      flyToBoundingSphere: (sphere, options) =>
        state.flights.push({ sphere, options }),
      cancelFlight: () => {
        state.cancelled += 1;
      },
    },
  };
  const store = new Map([
    ['gev:visit-passport:v1', JSON.stringify({ stamps, cinematic: true })],
  ]);
  const dossier = createCityDossier({
    viewer,
    dataManager: null,
    publish: (view) => {
      state.view = view;
    },
    connect: (actions) => {
      state.actions = actions;
      return () => {};
    },
    fetchImpl: async (url) => {
      state.urls.push(String(url));
      const path = route(url);
      if (state.down.has(path)) return { ok: false, status: 503 };
      const body =
        path === '/api/city-dossier'
          ? { city: state.town, town: { population: 10807 } }
          : path === '/api/air-quality-se'
            ? { stations: [] }
            : path === '/api/polisen-events'
              ? { events: [] }
              : {};
      return { ok: true, status: 200, json: async () => body };
    },
    now: () => state.now,
    documentRef: {
      body: { classList: { contains: () => false } },
      getElementById: () => null,
      addEventListener: (type, listener) => state.listeners.set(type, listener),
      removeEventListener: (type) => state.listeners.delete(type),
    },
    storage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
    },
    isPanelOpen: () => state.panelOpen,
    watchPanel: (onChange) => {
      state.panelChanged = onChange;
      return () => {};
    },
    createSights: () => ({ show() {}, hide() {}, destroy() {} }),
    createOrbit: () => ({
      active: false,
      start(target, options) {
        this.active = true;
        state.orbits.push({ target, options });
      },
      stop() {
        this.active = false;
        state.stops += 1;
      },
    }),
  });
  t.after(() => dossier.destroy());
  /** The routes asked since the last look, in order. */
  const asked = () => state.urls.splice(0).map(route);
  const visit = async (town) => {
    state.town = town;
    await dossier.visit();
    await settle();
  };
  return { dossier, state, asked, visit };
}

test('the live picture is fetched only while the panel shows the NOW tab', async (t) => {
  const { state, asked, visit } = harness(t);
  // The panel is closed: the town's facts, nothing of the live picture.
  await visit(TOWNS.arboga);
  assert.deepEqual(asked(), ['/api/city-dossier']);
  assert.equal(state.view.name, 'Arboga');
  // Opened on its first tab: still nothing.
  state.panelOpen = true;
  state.panelChanged();
  await settle();
  assert.deepEqual(asked(), []);
  // The NOW tab: the seven parts, once.
  state.actions.setTab('now');
  await settle();
  assert.deepEqual(asked(), LIVE_ROUTES);
  state.actions.setTab('about');
  state.actions.setTab('now');
  await settle();
  assert.deepEqual(asked(), [], 'fresh for ten minutes');
  // Another town while NOW shows: its facts and its live picture.
  await visit(TOWNS.koping);
  assert.deepEqual(asked(), ['/api/city-dossier', ...LIVE_ROUTES]);
  // The panel closed: a third town costs its facts alone…
  state.panelOpen = false;
  state.panelChanged();
  await visit(TOWNS.orebro);
  assert.deepEqual(asked(), ['/api/city-dossier']);
  // …until the panel opens again on NOW.
  state.panelOpen = true;
  state.panelChanged();
  await settle();
  assert.deepEqual(asked(), LIVE_ROUTES);
});

test('a part that does not answer is named, and asked for again after a minute', async (t) => {
  const { state, asked, visit } = harness(t);
  state.panelOpen = true;
  state.down.add('/api/polisen-events').add('/api/krisinformation');
  await visit(TOWNS.arboga);
  state.actions.setTab('now');
  await settle();
  asked();
  assert.equal(state.view.now.pending, '');
  assert.equal(
    state.view.now.failed,
    'No answer from: Polisen, Crisis information',
  );
  assert.equal(state.view.now.police, null);
  // Half a minute on nothing is asked; after the minute everything is.
  state.now += 30_000;
  await visit(TOWNS.arboga);
  assert.deepEqual(asked(), ['/api/city-dossier']);
  state.now += 31_000;
  state.down.clear();
  await visit(TOWNS.arboga);
  assert.deepEqual(asked(), ['/api/city-dossier', ...LIVE_ROUTES]);
  assert.equal(state.view.now.failed, '');
  assert.equal(
    state.view.now.police.summary,
    'No notices in the last 24 hours',
  );
  // With every part answered the picture stands for ten minutes.
  state.now += 9 * 60_000;
  await visit(TOWNS.arboga);
  assert.deepEqual(asked(), ['/api/city-dossier']);
});

test('a first visit offers the flight in; nothing moves until it is taken', async (t) => {
  const { state, visit } = harness(t);
  // Past the quiet start: the view was travelled to.
  state.now += 21_000;
  await visit(TOWNS.arboga);
  // The card at the side with the town and its facts, and the camera left
  // where it is.
  assert.equal(state.view.arrival.name, 'Arboga');
  assert.equal(state.view.arrival.county, 'Västmanlands län');
  assert.deepEqual(state.view.arrival.stats, [
    { label: 'POPULATION', value: '10,807' },
  ]);
  assert.equal(state.flights.length, 0);
  assert.equal(state.orbits.length, 0);
  // The offer taken: one glide to the orbit's first position, the card
  // giving way to the panel, and the orbit not yet begun.
  state.actions.flyIn();
  assert.equal(state.view.arrival, null);
  assert.equal(state.flights.length, 1);
  assert.equal(state.orbits.length, 0);
  const [{ sphere, options }] = state.flights;
  assert.ok(
    Cesium.Cartesian3.equalsEpsilon(
      sphere.center,
      Cesium.Cartesian3.fromDegrees(...TOWNS.arboga.point, 0),
      1e-9,
    ),
  );
  assert.equal(options.duration, 1.5);
  assert.equal(options.offset.heading, 0.5, 'on the heading the camera has');
  assert.equal(Math.round(Cesium.Math.toDegrees(options.offset.pitch)), -32);
  assert.equal(Math.round(options.offset.range), 3000);
  // The glide ends where the orbit begins: same range, same tilt.
  options.complete();
  assert.equal(state.orbits.length, 1);
  assert.deepEqual(
    {
      ...state.orbits[0].options,
      radius: Math.round(state.orbits[0].options.radius),
    },
    { radius: 3000, pitch: -32, speed: 12 },
  );
  // A key pressed in the middle of the next town's glide ends it: the
  // flight is cancelled and no orbit follows.
  state.now += 60_000;
  await visit(TOWNS.koping);
  assert.equal(state.flights.length, 1, 'no flight without the offer taken');
  state.actions.flyIn();
  assert.equal(state.flights.length, 2);
  assert.ok(
    Cesium.Cartesian3.equalsEpsilon(
      state.flights[1].sphere.center,
      Cesium.Cartesian3.fromDegrees(...TOWNS.koping.point, 0),
      1e-9,
    ),
  );
  state.listeners.get('keydown')();
  assert.equal(state.cancelled, 1);
  state.flights[1].options.complete();
  assert.equal(state.orbits.length, 1);
  // Another flight taking the camera during a glide is left alone.
  state.now += 60_000;
  await visit(TOWNS.orebro);
  state.actions.flyIn();
  assert.equal(state.flights.length, 3);
  state.flights[2].options.cancel();
  assert.equal(state.cancelled, 1, 'theirs is not cancelled');
  state.flights[2].options.complete();
  assert.equal(state.orbits.length, 1);
});

test('without a card there is nothing to fly in to', async (t) => {
  const { state, visit } = harness(t, {
    stamps: {
      1984: { name: 'Arboga', count: 1, first: NOW - 864e5, last: NOW - 864e5 },
    },
  });
  // A town already stamped: no card, and the action does nothing.
  state.now += 21_000;
  await visit(TOWNS.arboga);
  assert.equal(state.view.arrival, null);
  state.actions.flyIn();
  assert.equal(state.flights.length, 0);
  // A first visit: the card stays while the town is looked at…
  await visit(TOWNS.koping);
  assert.equal(state.view.arrival.name, 'Köping');
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(state.view.arrival.name, 'Köping');
  // …until it is dismissed; then there is nothing to fly in to.
  state.actions.dismissArrival();
  assert.equal(state.view.arrival, null);
  state.actions.flyIn();
  assert.equal(state.flights.length, 0);
});

test('the card goes when the view leaves its town', async (t) => {
  const { state, visit } = harness(t, {
    stamps: {
      1984: { name: 'Arboga', count: 1, first: NOW - 864e5, last: NOW - 864e5 },
    },
  });
  state.now += 21_000;
  // On to a town already stamped: the first town's card is not that town's.
  await visit(TOWNS.koping);
  assert.equal(state.view.arrival.name, 'Köping');
  await visit(TOWNS.arboga);
  assert.equal(state.view.name, 'Arboga');
  assert.equal(state.view.arrival, null);
  // Zoomed far out over a new town's card: no town is visited, no card shown.
  await visit(TOWNS.orebro);
  assert.equal(state.view.arrival.name, 'Örebro');
  state.height = 200_000;
  await visit(TOWNS.orebro);
  assert.equal(state.view.arrival, null);
});

test('an image names its Wikimedia Commons page, where author and licence stand', async () => {
  const { commonsPage } = await import('./cityDossier.js');
  const page = 'https://commons.wikimedia.org/wiki/File:';
  assert.equal(
    commonsPage(
      'https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Arboga_town.jpg/320px-Arboga_town.jpg',
    ),
    `${page}Arboga_town.jpg`,
  );
  assert.equal(
    commonsPage(
      'https://upload.wikimedia.org/wikipedia/commons/a/ab/Arboga_town.jpg',
    ),
    `${page}Arboga_town.jpg`,
  );
  assert.equal(
    commonsPage(
      'https://upload.wikimedia.org/wikipedia/commons/thumb/c/cd/Arboga_vapen.svg/120px-Arboga_vapen.svg.png',
    ),
    `${page}Arboga_vapen.svg`,
  );
  assert.equal(
    commonsPage(
      'https://commons.wikimedia.org/wiki/Special:FilePath/Arboga%20vapen.svg',
    ),
    `${page}Arboga%20vapen.svg`,
  );
  // The thumbnail host Wikipedia's summaries name, with its tracking query.
  assert.equal(
    commonsPage(
      'https://thumb.wikimedia.org/wikipedia/commons/thumb/d/de/Arboga_1.jpg/330px-Arboga_1.jpg?utm_source=sv.wikipedia.org',
    ),
    `${page}Arboga_1.jpg`,
  );
  // A file kept by one Wikipedia only, or no address at all: no Commons page.
  assert.equal(
    commonsPage('https://upload.wikimedia.org/wikipedia/sv/a/ab/Lokal.jpg'),
    null,
  );
  assert.equal(commonsPage('https://example.com/a.jpg'), null);
  assert.equal(commonsPage(null), null);
});

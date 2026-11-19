// The city dossier's controller: the live picture is fetched only for someone
// looking at it, a part that does not answer is named, a first visit glides
// into its orbit instead of cutting to it, and the passport's towns are drawn.
import assert from 'node:assert/strict';
import test from 'node:test';
import { fromDegrees, toLonLatH } from '../geo/ellipsoid.js';
import { distance, toDegrees } from '../geo/vector.js';
import { bindFakeDraw } from '../testSupport/fakeDrawPort.mjs';
import { fakeCameraPort } from '../testSupport/fakeCameraPort.mjs';
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
  '/api/wastewater-se',
];
const route = (url) => String(url).split('?')[0];
/** Let the fetches that were started, and what follows them, run. */
const settle = async () => {
  for (let i = 0; i < 8; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

/** Whether two ECEF points are the same to a millimetre. */
const samePoint = (a, b) => distance(a, b) < 1e-3;

function harness(t, { stamps = {}, showMap = false } = {}) {
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
    // Flights to a place (a sight, a camera), as `camera.flyTo` is given them.
    flyTos: [],
    sightsShown: [],
    orbits: [],
    stops: 0,
    listeners: new Map(),
    bodies: {},
  };
  // The scene object, with the renderer's camera and query bound to it: the
  // eye 3 km over the town, on heading 0.5, the town under the centre.
  const viewer = { canvas: { clientWidth: 800, clientHeight: 600 } };
  const camera = fakeCameraPort();
  const fixed = camera.port.pose;
  Object.assign(camera.port, {
    pose: () => ({
      ...fixed(),
      height: state.height,
      heading: 0.5,
      position: fromDegrees(...state.town.point, 3000),
    }),
    flying: false,
    flyToBounds(sphere, options) {
      state.flights.push({ sphere, options });
      return { done: new Promise(() => {}), cancel() {} };
    },
    cancelFlight() {
      state.cancelled += 1;
    },
    flyTo(destination, options) {
      state.flyTos.push({ destination, options });
      return { done: new Promise(() => {}), cancel() {} };
    },
  });
  const { draw } = bindFakeDraw(viewer, {
    camera: camera.port,
    query: { pickEllipsoid: () => fromDegrees(...state.town.point, 0) },
  });
  const store = new Map([
    [
      'gev:visit-passport:v1',
      JSON.stringify({ stamps, cinematic: true, showMap }),
    ],
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
        path in state.bodies
          ? state.bodies[path]
          : path === '/api/city-dossier'
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
    createSights: (options) => {
      state.sightsOptions = options;
      return {
        show: (items, chosen) => state.sightsShown.push({ items, chosen }),
        hide: () => state.sightsShown.push(null),
        destroy() {},
      };
    },
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
  return { dossier, state, asked, visit, draw, camera };
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
  // The NOW tab: the eight parts, once.
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
  assert.ok(samePoint(sphere.center, fromDegrees(...TOWNS.arboga.point, 0)));
  assert.equal(sphere.radius, 0);
  assert.equal(options.durationS, 1.5);
  assert.equal(options.offset.heading, 0.5, 'on the heading the camera has');
  assert.equal(Math.round(toDegrees(options.offset.pitch)), -32);
  assert.equal(Math.round(options.offset.range), 3000);
  // The glide ends where the orbit begins: same range, same tilt.
  options.onComplete();
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
    samePoint(
      state.flights[1].sphere.center,
      fromDegrees(...TOWNS.koping.point, 0),
    ),
  );
  state.listeners.get('keydown')();
  assert.equal(state.cancelled, 1);
  state.flights[1].options.onComplete();
  assert.equal(state.orbits.length, 1);
  // Another flight taking the camera during a glide is left alone.
  state.now += 60_000;
  await visit(TOWNS.orebro);
  state.actions.flyIn();
  assert.equal(state.flights.length, 3);
  state.flights[2].options.onCancel();
  assert.equal(state.cancelled, 1, 'theirs is not cancelled');
  state.flights[2].options.onComplete();
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

test('a transport source that failed is not shown as an empty one', async (t) => {
  const { state, visit } = harness(t);
  state.panelOpen = true;
  // The route answered, but Trafikverket and Swedavia behind it did not.
  state.bodies['/api/city-transit'] = {
    trains: { station: null, departures: [], error: true },
    flights: { airports: [], error: true },
  };
  await visit(TOWNS.arboga);
  state.actions.setTab('now');
  await settle();
  assert.equal(state.view.now.failed, 'No answer from: Traffic');
  // Asked again after a minute; an answer without its keys is no failure.
  state.bodies['/api/city-transit'] = { trains: null, flights: null };
  state.now += 61_000;
  await visit(TOWNS.arboga);
  assert.equal(state.view.now.failed, '');
});

test('the dossier lists no queues and names no TomTom, whatever the route answers', async (t) => {
  const { state, visit } = harness(t);
  state.panelOpen = true;
  // An answer that still carries jams is neither shown nor credited.
  state.bodies['/api/city-transit'] = {
    trains: null,
    jams: { items: [{ roads: ['E20'], delaySeconds: 400 }] },
    flights: null,
  };
  await visit(TOWNS.arboga);
  state.actions.setTab('now');
  await settle();
  assert.equal('jams' in state.view.now, false);
  assert.doesNotMatch(state.view.source, /TomTom/);
  assert.equal(state.view.now.failed, '');
});
/** The NOW tab of Arboga with the given queues in the transport answer. */
async function queuesShown(t, queues) {
  const { state, visit } = harness(t);
  state.panelOpen = true;
  state.bodies['/api/city-transit'] = { trains: null, flights: null, queues };
  await visit(TOWNS.arboga);
  state.actions.setTab('now');
  await settle();
  return state.view;
}

test('the queues around the town are Trafikverket’s, worst first, and credited', async (t) => {
  const view = await queuesShown(t, {
    routes: 12,
    points: 80,
    pointsQueued: 2,
    items: [
      {
        name: 'Sotartunneln',
        status: 'heavy',
        delayS: 50,
        speedKmh: 25.9,
        lengthM: 580,
      },
    ],
  });
  const queues = view.now.queues;
  assert.equal(queues.items.length, 1);
  assert.equal(queues.items[0].title, 'Sotartunneln');
  assert.equal(queues.items[0].status, 'Slow traffic');
  assert.equal(queues.items[0].detail, '+1 min · 26 km/h · 0.6 km');
  assert.equal(queues.empty, '');
  assert.match(view.source, /Trafikverket/);
});

test('with nothing queued the dossier says what was measured', async (t) => {
  const view = await queuesShown(t, {
    routes: 12,
    points: 80,
    pointsQueued: 0,
    items: [],
  });
  assert.equal(
    view.now.queues.empty,
    'No queues right now · 12 stretches and 80 measuring points',
  );
});

test('a failed read of the queues is named, not shown as an empty list', async (t) => {
  const view = await queuesShown(t, { items: [], error: true });
  assert.equal(view.now.queues, null);
  assert.equal(view.now.failed, 'No answer from: Traffic');
});

test('without measured queues the dossier lists the incidents around the town', async (t) => {
  const { state, visit } = harness(t);
  state.panelOpen = true;
  state.bodies['/api/city-transit'] = {
    trains: null,
    flights: null,
    queues: null,
    incidents: {
      count: 3,
      radiusKm: 15,
      items: [
        {
          kind: 'accident',
          title: 'Olycka',
          road: 'E18',
          location: 'Trafikplats Västerås västra',
          severity: 'Stor påverkan',
        },
      ],
    },
  };
  await visit(TOWNS.arboga);
  state.actions.setTab('now');
  await settle();
  const incidents = state.view.now.incidents;
  assert.equal(state.view.now.queues, null);
  assert.equal(incidents.items[0].title, 'E18 · Olycka');
  assert.equal(incidents.items[0].status, 'Accident');
  assert.equal(
    incidents.items[0].detail,
    'Trafikplats Västerås västra · Stor påverkan',
  );
  assert.equal(incidents.more, '2 more on the Road Conditions layer');
  assert.match(incidents.note, /15 km/);
  assert.match(state.view.source, /Trafikverket/);
});

test("a sight's picture names its Wikimedia Commons page too", async () => {
  const { commonsPage } = await import('./cityDossier.js');
  // Wikidata names a picture by its file path, over plain http.
  assert.equal(
    commonsPage(
      'http://commons.wikimedia.org/wiki/Special:FilePath/Arboga%20kyrka.jpg',
    ),
    'https://commons.wikimedia.org/wiki/File:Arboga%20kyrka.jpg',
  );
});

test('the rescue service is shown against Sweden, never ranked among the towns', async (t) => {
  const { state, visit } = harness(t);
  state.bodies['/api/city-dossier/stats'] = {
    code: '1984',
    stats: [
      {
        key: 'rescueResponse',
        year: 2025,
        value: 9.88,
        sweden: 11.2,
        rank: 254,
        count: 290,
      },
      {
        key: 'spreadingFires',
        year: 2024,
        value: 0.195,
        sweden: 0.28,
        rank: 260,
        count: 290,
      },
    ],
  };
  await visit(TOWNS.arboga);
  state.actions.setTab('stats');
  await settle();
  const group = state.view.stats.groups.find(
    (g) => g.title === 'Rescue service',
  );
  assert.deepEqual(
    group.rows.map((row) => [row.value, row.detail]),
    [
      ['9.9 min', '2025 · Sweden 11.2 min'],
      ['0.2', '2020–2024 · Sweden 0.3'],
    ],
  );
  assert.match(group.note, /sparsely populated/);
  assert.match(group.note, /SOS Alarm .* five years\.$/);
});

test('SCB figures: births and moves, houses, building, new cars and commuting', async (t) => {
  const { state, asked, visit } = harness(t);
  state.bodies['/api/city-dossier/figures'] = {
    code: '1984',
    failed: 0,
    figures: {
      changes: {
        year: 2026,
        month: 9,
        births: 153,
        deaths: 90,
        netMoves: -49,
      },
      houses: { year: 2025, sold: 784, meanPrice: 4182000 },
      starts: { from: '2025K3', to: '2026K2', started: 361 },
      cars: {
        from: { year: 2025, month: 11 },
        to: { year: 2026, month: 10 },
        total: 3970,
        electric: 1414,
        share: 35.6,
      },
      commuting: {
        year: 2024,
        local: 64291,
        out: 14830,
        in: 17621,
        topOut: { name: 'Stockholm', count: 2996 },
        topIn: { name: 'Hallstahammar', count: 2983 },
      },
    },
  };
  // The card itself never waits for SCB: the figures come with their tabs.
  await visit(TOWNS.arboga);
  assert.deepEqual(asked(), ['/api/city-dossier']);
  state.actions.setTab('people');
  await settle();
  assert.deepEqual(asked(), ['/api/city-dossier/figures']);
  const people = Object.fromEntries(
    state.view.people.rows.map((row) => [row.label, row.value]),
  );
  assert.equal(people['Born / died'], '153 / 90');
  assert.equal(state.view.people.loading, '', 'no "Fetching" once read');
  assert.equal(people['Net moves'], '-49');
  state.actions.setTab('society');
  await settle();
  assert.deepEqual(asked(), [], 'read once per town');
  const society = Object.fromEntries(
    state.view.society.rows.map((row) => [row.label, [row.value, row.detail]]),
  );
  assert.deepEqual(society['House, mean price'], [
    '4.2 million kr',
    '784 sold · 2025',
  ]);
  assert.deepEqual(society['Dwellings started, last four quarters'], [
    '361',
    'Q3 2025–Q2 2026 · latest quarters preliminary',
  ]);
  assert.equal(
    society['Newly registered cars that are fully electric'][0],
    '35.6 %',
  );
  assert.match(
    society['Newly registered cars that are fully electric'][1],
    /^1,414 of 3,970 · Nov 2025–Oct 2026 · computed by the app from Trafikanalys statistics$/,
  );
  assert.deepEqual(society['Commute in / out'], ['17,621 / 14,830', '2024']);
  assert.deepEqual(society['Most commute to'], [
    'Stockholm',
    '2,996 people · 2024',
  ]);
});

test('the STATISTICS tab reads the town once, with year, Sweden and place', async (t) => {
  const { state, asked, visit } = harness(t);
  state.bodies['/api/city-dossier/stats'] = {
    code: '1984',
    stats: [
      {
        key: 'meritValue',
        year: 2026,
        value: 224.5,
        sweden: 229.7,
        rank: 86,
        count: 290,
      },
      {
        key: 'reportedCrimes',
        year: 2025,
        value: 13914.7,
        sweden: null,
        rank: 18,
        count: 290,
      },
    ],
  };
  await visit(TOWNS.arboga);
  asked();
  state.actions.setTab('stats');
  await settle();
  assert.deepEqual(asked(), ['/api/city-dossier/stats']);
  const view = state.view.stats;
  assert.deepEqual(
    view.groups.map((group) => [
      group.title,
      group.rows.map((row) => [row.value, row.detail]),
    ]),
    [
      ['School', [['224.5', '2026 · Sweden 229.7 · Place 86 of 290']]],
      ['Safety', [['13,915', '2025 · Place 18 of 290']]],
    ],
  );
  assert.match(view.credit, /^Source: Kolada\./);
  // Back to the tab: no second read for the same town.
  state.actions.setTab('about');
  state.actions.setTab('stats');
  await settle();
  assert.deepEqual(asked(), []);
  // A failed read says so, and is tried again for the next town.
  state.down.add('/api/city-dossier/stats');
  await visit(TOWNS.koping);
  assert.equal(state.view.stats.status, 'Statistics unavailable right now');
});

test("the passport's towns are drawn on the ground, joined in order, while the map is on", async (t) => {
  const { state, visit, draw, dossier } = harness(t, { showMap: true });
  const towns = () => draw.set('visit-passport');
  const way = () => draw.set('visit-passport-route');
  assert.equal(towns().kind, 'points');
  assert.equal(towns().spec.clampTo, 'both');
  assert.equal(towns().items.size, 0);
  state.now += 21_000;
  await visit(TOWNS.arboga);
  const arboga = towns().items.get('visit-passport:1984');
  assert.deepEqual(arboga.pos, { lon: 15.8269, lat: 59.3994, height: 0 });
  assert.equal(arboga.height, 'clampGround');
  assert.equal(arboga.pixelSize, 9);
  assert.equal(arboga.color, '#ffc94d');
  assert.deepEqual(arboga.outlineColor, [0, 0, 0, 0.6]);
  assert.equal(arboga.disableDepthTest, Number.POSITIVE_INFINITY);
  assert.equal(way().items.size, 0, 'one town is no journey');
  state.now += 60_000;
  await visit(TOWNS.koping);
  assert.equal(towns().items.size, 2);
  const [route] = way().items.values();
  assert.equal(route.mode, 'draped');
  assert.equal(route.widthPx, 2);
  assert.equal(route.style.kind, 'dash');
  assert.equal(route.style.length, 14);
  assert.equal(route.style.color[3], 0.8);
  assert.equal(route.positions.length, 2);
  const [from, to] = route.positions.map((p) => toLonLatH(p));
  assert.ok(Math.abs(from.lon - TOWNS.arboga.point[0]) < 1e-9);
  assert.ok(Math.abs(to.lon - TOWNS.koping.point[0]) < 1e-9);
  // The map off: the sets go; on again, they come back.
  state.actions.togglePassMap();
  assert.equal(towns(), undefined);
  assert.equal(way(), undefined);
  state.actions.togglePassMap();
  assert.equal(towns().items.size, 2);
  assert.equal(way().items.size, 1);
  dossier.destroy();
  assert.equal(towns(), undefined);
  assert.equal(way(), undefined);
});

test('a settled camera is a visit; a sight chosen is flown to from the south', async (t) => {
  const { state, asked, camera } = harness(t);
  // A view already over a town is a visit, half a second after the start.
  t.mock.timers.tick(500);
  await settle();
  assert.deepEqual(asked(), ['/api/city-dossier']);
  assert.equal(state.view.name, 'Arboga');
  // The sights get the scene object itself.
  assert.ok(state.sightsOptions.viewer.canvas);
  // The camera comes to rest over the next town: a visit, half a second on.
  state.town = TOWNS.koping;
  camera.emit('moveEnd');
  t.mock.timers.tick(499);
  await settle();
  assert.deepEqual(asked(), []);
  t.mock.timers.tick(1);
  await settle();
  assert.deepEqual(asked(), ['/api/city-dossier']);
  assert.equal(state.view.name, 'Köping');
  // Its sights on the SIGHTS tab, and one of them chosen.
  state.bodies['/api/city-sights'] = {
    sights: [
      {
        id: 'q1',
        name: 'Kungsörs kungsgård',
        kind: 'manor',
        lat: 59.42,
        lon: 16.1,
      },
    ],
  };
  state.actions.setTab('sights');
  await settle();
  assert.equal(state.sightsShown.at(-1).items[0].id, 'q1');
  state.actions.chooseSight('q1');
  assert.equal(state.sightsShown.at(-1).chosen, 'q1');
  assert.equal(state.flyTos.length, 1);
  const [{ destination, options }] = state.flyTos;
  assert.equal(destination.lon, 16.1);
  assert.ok(Math.abs(destination.lat - (59.42 - 0.011)) < 1e-9);
  assert.equal(destination.height, 900);
  assert.equal(Math.round(toDegrees(options.orientation.pitch)), -35);
  assert.equal(options.orientation.heading, 0);
  assert.equal(options.durationS, 2);
  // Away from the tab: the markers go.
  state.actions.setTab('about');
  assert.equal(state.sightsShown.at(-1), null);
});

test("wastewater: each virus's trend at the town's plants, one column per plant", async (t) => {
  const { state, visit } = harness(t);
  const plant = (city, place, name, trends) => ({
    city,
    key: city.toLowerCase(),
    place,
    plant: name,
    latest: '2026-11-09',
    outOfDate: false,
    viruses: Object.entries(trends).map(([virus, trend]) => ({
      virus,
      trend,
      date: '2026-11-09',
    })),
  });
  state.bodies['/api/wastewater-se'] = {
    latestWeek: '2026-11-09',
    plants: [
      plant('Orebro', 'Örebro', null, { covid: 'steady', fluA: 'rising' }),
      plant('Stockholm-Bromma', 'Stockholm', 'Bromma', { covid: 'rising' }),
    ],
  };
  state.panelOpen = true;
  await visit(TOWNS.orebro);
  state.actions.setTab('now');
  await settle();
  const view = state.view.now.wastewater;
  // One plant: no columns, the trend in words.
  assert.deepEqual(view.columns, []);
  assert.equal(view.legend, '', 'the words stand in the cells');
  assert.deepEqual(
    view.rows.map((row) => [row.label, row.cells[0].text]),
    [
      ['COVID-19', 'steady'],
      ['Influenza A', 'rising'],
      ['Influenza B', '—'],
      ['RSV', '—'],
    ],
  );
  assert.match(
    view.note,
    /^Sample November 9\. .* towns are not compared\. .* still being developed\.$/,
  );
  assert.match(
    view.credit,
    /SciLifeLab Pathogens Portal · CC BY 4\.0 · trends computed by the app$/,
  );
  assert.match(view.creditUrl, /^https:\/\/www\.pathogens\.se\//);
  // A town without a plant: no block.
  await visit(TOWNS.arboga);
  state.actions.setTab('now');
  await settle();
  assert.equal(state.view.now.wastewater, null);
});

test('back in a town, its figures are read again for the new card', async (t) => {
  const { state, asked, visit } = harness(t);
  state.bodies['/api/city-dossier/figures'] = {
    figures: { changes: { year: 2026, month: 9, births: 1, deaths: 2 } },
  };
  await visit(TOWNS.arboga);
  state.actions.setTab('people');
  await settle();
  // Away on the first tab while the map moves to Köping and back.
  state.actions.setTab('about');
  await visit(TOWNS.koping);
  await visit(TOWNS.arboga);
  asked();
  state.actions.setTab('people');
  await settle();
  assert.deepEqual(asked(), ['/api/city-dossier/figures']);
  assert.ok(state.view.people.rows.some((row) => row.label === 'Born / died'));
});

test("Kiruna's all-sky camera: near Kiruna and only while its sky is dark", async (t) => {
  const { state, visit } = harness(t);
  const KIRUNA = {
    code: '2584',
    name: 'Kiruna',
    municipality: 'Kiruna',
    county: 'Norrbottens län',
    point: [20.2253, 67.8558],
  };
  state.bodies['/api/aurora-outlook'] = { level: 'possible', maxKp: 3 };
  state.panelOpen = true;
  state.now = Date.parse('2026-11-05T20:00:00Z');
  await visit(KIRUNA);
  state.actions.setTab('now');
  await settle();
  const camera = state.view.now.aurora.camera;
  assert.match(camera.src, /^\/api\/kiruna-allsky\?minute=\d+$/);
  assert.match(camera.credit, /^Data from Kiruna allsky camera provided by/);
  assert.equal(camera.licenseText, 'this license');
  // Far from Kiruna: the camera's sky is not the town's.
  await visit(TOWNS.arboga);
  state.actions.setTab('now');
  await settle();
  assert.equal(state.view.now.aurora.camera, null);
  // In Kiruna by day: nothing to see.
  state.now = Date.parse('2026-11-05T10:30:00Z');
  await visit(KIRUNA);
  state.actions.setTab('now');
  await settle();
  assert.equal(state.view.now.aurora.camera, null);
});

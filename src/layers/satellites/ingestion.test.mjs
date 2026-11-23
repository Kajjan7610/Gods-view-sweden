import test from 'node:test';
import assert from 'node:assert/strict';
import { createGpSatrecCache, parseGpCsv } from '../../sources/gp.js';
import { gpCsv } from '../../testSupport/gpFixtures.mjs';
import {
  CELESTRAK_READS_AT_ONCE,
  SATCAT_KEEP_MS,
  SATCAT_WAIT_MS,
  TLE_WAIT_MS,
  celestrakGroupsStatus,
  celestrakPausedError,
  createIngestion,
} from './ingestion.js';
import { CATALOG_GROUPS } from './policy.js';
import { createOrbits } from './orbits.js';
import { createControls } from './controls.js';
import { setLocale } from '../../i18n/index.js';

// The ISS set (1 January 2024), CelesTrak GP fields written by hand, with
// its catalog number swapped per satellite.
const ISS = Object.freeze({
  OBJECT_ID: '1998-067A',
  EPOCH: '2024-01-01T12:00:00.000000',
  MEAN_MOTION: '15.50377579',
  ECCENTRICITY: '.0006703',
  INCLINATION: '51.6416',
  RA_OF_ASC_NODE: '247.4627',
  ARG_OF_PERICENTER: '130.5360',
  MEAN_ANOMALY: '325.0288',
  EPHEMERIS_TYPE: '0',
  CLASSIFICATION_TYPE: 'U',
  ELEMENT_SET_NO: '999',
  REV_AT_EPOCH: '43232',
  BSTAR: '.30370E-3',
  MEAN_MOTION_DOT: '.00016717',
  MEAN_MOTION_DDOT: '0',
});

/** One satellite's fields: the ISS set under its own name and number. */
const satellite = (name, noradId) => ({
  ...ISS,
  OBJECT_NAME: name,
  NORAD_CAT_ID: String(noradId),
});

/** A group's GP CSV holding one satellite. */
const gpSet = (name, noradId) => gpCsv(satellite(name, noradId));

// SXM-11, international designator 2026-148A, in the geostationary belt.
const SXM_11 = Object.freeze({
  OBJECT_NAME: 'SXM-11',
  OBJECT_ID: '2026-148A',
  EPOCH: '2026-07-27T15:38:24.009792',
  MEAN_MOTION: '1.00271527',
  ECCENTRICITY: '.0001797',
  INCLINATION: '0.0784',
  RA_OF_ASC_NODE: '264.9826',
  ARG_OF_PERICENTER: '240.4588',
  MEAN_ANOMALY: '273.9506',
  EPHEMERIS_TYPE: '0',
  CLASSIFICATION_TYPE: 'U',
  NORAD_CAT_ID: '69728',
  ELEMENT_SET_NO: '999',
  REV_AT_EPOCH: '44',
  BSTAR: '0',
  MEAN_MOTION_DOT: '.00000015',
  MEAN_MOTION_DDOT: '0',
});

// Orbit tracks hand their path to the renderer; positions pass through here.
const orbitParts = {
  rendering: { _rendererPositions: (positions) => positions },
};

function ingestionFor(
  catalogText,
  { source: sourceExtras = {}, orbits: orbitExtras = {} } = {},
) {
  const state = {
    _trackingRefreshEpoch: 0,
    _activeUpdateControllers: new Set(),
    _points: new Map(),
    _orbitPaths: new Map(),
    _catalog: new Map(),
    _detectionObjects: new Map(),
    _denseLoadToken: 0,
    _catalogRevision: 0,
    _params: { catalog: 'core', showOrbits: false },
    _satcat: new Map(),
    _ucs: null,
    _coreSatrecs: createGpSatrecCache(),
    _denseSatrecs: createGpSatrecCache(),
    now: Date.now,
    coverageChanged() {},
  };
  const parts = {
    orbits: {
      parseGp: parseGpCsv,
      propagatePosition: () => ({ longitude: 0, latitude: 0, altitude: 4e5 }),
      ...orbitExtras,
    },
    labels: { _syncIssOverlay() {} },
    controls: {
      _pointStyleFor: () => ({}),
      _classVisible: () => true,
      _syncIssOrbit() {},
      _applyClassVisibility() {
        state.visibilityApplied = (state.visibilityApplied || 0) + 1;
      },
      _notifyRowControls() {
        state.rowNotified = (state.rowNotified || 0) + 1;
      },
    },
    rendering: {
      _clearPoints() {
        state._points.clear();
      },
      _clearOrbitPaths() {
        state._orbitPaths.clear();
      },
      _addPoint(noradId, position, style, show = true) {
        state._points.set(noradId, { position, show });
      },
      _setPointStyle() {},
      _showOrbitPath() {},
      _setOrbitPathShown() {},
    },
    tracking: {
      async _reconcileTrackedSubjectContext() {},
      _applyPendingTrackingRestore() {},
    },
    catalog: {},
  };
  const source = {
    async readGroup(path) {
      const text =
        typeof catalogText === 'function' ? catalogText(path) : catalogText;
      return { ok: true, text };
    },
    ...sourceExtras,
  };
  const { methods } = createIngestion({ state, services: {}, parts, source });
  return { state, update: () => methods.update({}) };
}

test('every satellite numbered 100000 and up keeps its own catalog entry, propagated and drawn', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  // Real SGP4, at the elements' epoch: each dot is where its orbit puts it.
  const { propagatePosition } = createOrbits({ state: {}, parts: orbitParts });
  const { state, update } = ingestionFor(
    gpCsv(
      satellite('FIRST', 100000),
      satellite('SECOND', 110001),
      satellite('THIRD', 339999),
      // Past what a TLE could spell even in Alpha-5.
      satellite('FOURTH', 412345),
    ),
    { orbits: { propagatePosition } },
  );
  state.now = () => Date.parse('2024-01-01T13:00:00Z');
  await update();
  assert.deepEqual(
    [...state._catalog].map(([id, entry]) => [id, entry.name]),
    [
      [100000, 'FIRST'],
      [110001, 'SECOND'],
      [339999, 'THIRD'],
      [412345, 'FOURTH'],
    ],
  );
  assert.deepEqual([...state._points.keys()], [100000, 110001, 339999, 412345]);
  for (const [id, { position }] of state._points) {
    const radiusKm = Math.hypot(position.x, position.y, position.z) / 1000;
    assert.ok(radiusKm > 6700 && radiusKm < 6900, `${id}: ${radiusKm} km`);
  }
  assert.equal(state._count, 4);
  assert.equal(state._catalog.get(412345).satrec.satnum, '412345');
});

// Swedish fork: the proxy serves the same rows for 6 h and the catalog is
// rebuilt every 5 min.
test('a rebuild reuses the satrec of an unchanged row, and keeps only its own catalog', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  let text = gpCsv(satellite('FIRST', 40100), satellite('SECOND', 40101));
  const { state, update } = ingestionFor(() => text);
  const satrecOf = (id) => state._catalog.get(id)?.satrec;
  await update();
  const [first, second] = [satrecOf(40100), satrecOf(40101)];
  assert.ok(first && second && first !== second);
  // The same rows: the same satrecs, in new catalog entries.
  const entry = state._catalog.get(40100);
  await update();
  assert.equal(satrecOf(40100), first);
  assert.equal(satrecOf(40101), second);
  assert.notEqual(state._catalog.get(40100), entry, 'the entry is rebuilt');
  // A new element set (a new epoch) is built anew; the other is kept.
  text = gpCsv(satellite('FIRST', 40100), {
    ...satellite('SECOND', 40101),
    EPOCH: '2024-01-02T00:00:00.000000',
  });
  await update();
  assert.equal(satrecOf(40100), first);
  assert.notEqual(satrecOf(40101), second);
  // An object the catalog no longer holds is forgotten with it.
  text = gpCsv(satellite('SECOND', 40101));
  await update();
  assert.equal(state._catalog.has(40100), false);
  text = gpCsv(satellite('FIRST', 40100), satellite('SECOND', 40101));
  await update();
  assert.ok(satrecOf(40100));
  assert.notEqual(satrecOf(40100), first, 'not held while it was gone');
});

test('a mission payload does not match a loaded satellite from another launch year', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const { state, update } = ingestionFor(gpCsv(SXM_11));
  await update();
  const { getSatelliteOrbitTrack } = createOrbits({ state, parts: orbitParts });
  const track = (launchTime) =>
    getSatelliteOrbitTrack('Sirius SXM-11', { launchTime });
  assert.equal(track('2026-06-29T02:25:00Z')?.noradId, 69728);
  assert.equal(track('2030-06-29T02:25:00Z'), null);
});

test('a satellite with a blank designator keeps matching by name', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const text = gpCsv({ ...SXM_11, OBJECT_ID: '' });
  const { state, update } = ingestionFor(text);
  await update();
  const { getSatelliteOrbitTrack } = createOrbits({ state, parts: orbitParts });
  assert.equal(parseGpCsv(text)[0].launchYear, null);
  assert.equal(
    getSatelliteOrbitTrack('Sirius SXM-11', {
      launchTime: '2030-06-29T02:25:00Z',
    })?.noradId,
    69728,
  );
});

test('a hanging SATCAT read neither holds the catalog nor is lost when it lands', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let answer;
  const satcatAnswer = new Promise((resolve) => {
    answer = resolve;
  });
  const { state, update } = ingestionFor(
    (path) => (path === 'stations' ? gpSet('OLD STAGE', '40115') : ''),
    { source: { readSatcat: () => satcatAnswer } },
  );
  state._enabled = true;
  const settle = async () => {
    for (let turn = 0; turn < 20; turn += 1)
      await new Promise((resolve) => setImmediate(resolve));
  };
  const rebuilt = update();
  await settle();
  t.mock.timers.tick(SATCAT_WAIT_MS);
  await rebuilt;
  // Built without SATCAT: neither name nor group says what it is (the
  // stations group alone makes no station).
  assert.equal(state._catalog.get(40115).satelliteClass, 'probes');
  const revision = state._catalogRevision;
  // SATCAT lands late: a rocket body.
  answer({
    ok: true,
    stale: true,
    text: 'OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER\nOLD STAGE,2014-048B,40115,R/B,,US',
  });
  await settle();
  assert.equal(state._catalog.get(40115).satelliteClass, 'debris');
  assert.equal(state._catalogRevision, revision + 1, 'the legend refreshes');
  assert.ok(state.visibilityApplied >= 1 && state.rowNotified >= 1);
  assert.equal(state._satcatState, 'stale', 'its staleness is kept');
});

test('a satellite in visual and resource is imaging, whichever group shows it', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  // A name no pattern knows, no UCS record and no SATCAT: only its groups.
  const { state, update } = ingestionFor((path) =>
    path === 'visual' || path === 'resource'
      ? gpSet('ZZ TESTSAT', '50001')
      : '',
  );
  await update();
  const sat = state._catalog.get(50001);
  assert.equal(sat.group, 'visual', 'shown under the first group');
  assert.deepEqual(sat.groups, ['visual', 'resource']);
  assert.equal(sat.satelliteClass, 'imaging');
});

test('a stale SATCAT copy never overrules a current read of the same object', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const header =
    'OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE,OWNER\n';
  const { state, update } = ingestionFor(gpSet('ZZ TESTSAT', '50002'), {
    source: {
      // visual is current and says it died; resource, a cached copy, still
      // says it works.
      readSatcat: async (path) =>
        path === 'visual'
          ? { ok: true, text: `${header}ZZ TESTSAT,2015-001A,50002,PAY,-,US` }
          : path === 'resource'
            ? {
                ok: true,
                stale: true,
                text: `${header}ZZ TESTSAT,2015-001A,50002,PAY,+,US`,
              }
            : { ok: true, text: header },
    },
  });
  await update();
  assert.equal(state._catalog.get(50002).satelliteClass, 'debris');
});

test('a failed SATCAT read is told on the layer row, not only the console', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const { state, update } = ingestionFor(gpSet('OLD STAGE', '40115'), {
    source: { readSatcat: async () => ({ ok: false, text: '' }) },
  });
  await update();
  assert.equal(state._satcatState, 'unavailable');
  assert.ok(state.rowNotified >= 1, 'the row repaints');
  const controls = createControls({
    state: {
      ...state,
      _params: { ...state._params, showPoints: true },
      _classTallyCache: {},
    },
    services: { layerState: { isExplicitLayerStateOrigin: () => false } },
    parts: {},
    source: {},
  });
  const row = controls.methods.getRowControls();
  assert.equal(row.info, 'Classes may lag: SATCAT unavailable');
  assert.match(row.infoTitle, /SATCAT/);
  const current = createControls({
    state: {
      ...state,
      _satcatState: 'current',
      _params: { ...state._params, showPoints: true },
      _classTallyCache: {},
    },
    services: { layerState: { isExplicitLayerStateOrigin: () => false } },
    parts: {},
    source: {},
  });
  assert.equal(current.methods.getRowControls().info, '');
});

test('a current SATCAT read is kept between updates; a failed one is asked again', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const header =
    'OBJECT_NAME,OBJECT_ID,NORAD_CAT_ID,OBJECT_TYPE,OPS_STATUS_CODE\n';
  let reads = 0;
  let ok = true;
  const { state, update } = ingestionFor(gpSet('ZZ TESTSAT', '50003'), {
    source: {
      readSatcat: async () => {
        reads++;
        return ok
          ? { ok: true, text: `${header}ZZ TESTSAT,2015-001A,50003,PAY,-` }
          : { ok: false, text: '' };
      },
    },
  });
  await update();
  const perUpdate = reads;
  assert.ok(perUpdate > 0);
  await update();
  assert.equal(reads, perUpdate, 'a fresh read is not asked again');
  assert.equal(
    state._catalog.get(50003).satelliteClass,
    'debris',
    'the held records still class the rebuilt catalog',
  );

  state._satcatReadAtMs -= SATCAT_KEEP_MS;
  ok = false;
  await update();
  assert.equal(reads, 2 * perUpdate, 'an old read is asked again');
  assert.equal(state._satcatState, 'unavailable');
  await update();
  assert.equal(reads, 3 * perUpdate, 'a failed read is asked again');
});

/** The layer's row controls over an ingestion state (controls.js). */
function controlsOf(state) {
  return createControls({
    state: {
      ...state,
      _params: { ...state._params, showPoints: true },
      _classTallyCache: {},
    },
    services: { layerState: { isExplicitLayerStateOrigin: () => false } },
    parts: {},
    source: {},
  }).methods;
}

/** One satellite per group path, its own catalog number. */
const groupIds = new Map();
function gpFor(path) {
  if (!groupIds.has(path)) groupIds.set(path, String(40200 + groupIds.size));
  return gpSet(`SAT ${path}`, groupIds.get(path));
}

/** Each core group's read, as `answer(path)` says. */
const groupsAnswering = (answer) =>
  CATALOG_GROUPS.map(({ path }) => ({ path, ...answer(path) }));

// Swedish fork: what the row says of the groups while CelesTrak's usage
// policy keeps the proxy from asking (server/providers/space/celestrak.js).
test('the row says CelesTrak is paused only while every group still asked for is held, until the first may be asked', () => {
  const now = Date.parse('2026-11-22T12:00:00Z');
  const soon = now + 15 * 60_000;
  const later = now + 2 * 60 * 60_000;
  // Every group held, the one that failed for its own 2 h: the pause ends
  // with the others'.
  assert.deepEqual(
    celestrakGroupsStatus(
      groupsAnswering((path) => ({
        ok: true,
        stale: true,
        heldUntil: path === 'visual' ? later : soon,
      })),
      now,
    ),
    { pausedUntil: soon, error: null },
  );
  // One stray group still held, the others refreshed: no pause.
  assert.deepEqual(
    celestrakGroupsStatus(
      groupsAnswering((path) =>
        path === 'visual'
          ? { ok: true, stale: true, heldUntil: later }
          : {
              ok: true,
            },
      ),
      now,
    ),
    { pausedUntil: 0, error: null },
  );
  assert.deepEqual(
    celestrakGroupsStatus(
      groupsAnswering((path) =>
        path === 'visual' ? { ok: false, heldUntil: later } : { ok: true },
      ),
      now,
    ),
    { pausedUntil: 0, error: '1 CelesTrak group unavailable' },
  );
  // Every group held without a copy: paused, and every group unavailable
  // meanwhile, never "unreachable".
  assert.deepEqual(
    celestrakGroupsStatus(
      groupsAnswering(() => ({ ok: false, heldUntil: soon })),
      now,
    ),
    { pausedUntil: soon, error: '11 CelesTrak groups unavailable' },
  );
  // Nothing held and nothing came: unreachable.
  assert.deepEqual(
    celestrakGroupsStatus(
      groupsAnswering(() => ({ ok: false })),
      now,
    ),
    { pausedUntil: 0, error: 'CelesTrak unreachable' },
  );
});

test('groups CelesTrak answered 404 for are missing, even shown from their last copy', () => {
  const now = Date.parse('2026-11-22T12:00:00Z');
  const soon = now + 15 * 60_000;
  assert.deepEqual(
    celestrakGroupsStatus(
      groupsAnswering((path) =>
        path === 'geo' ? { ok: true, stale: true, gone: true } : { ok: true },
      ),
      now,
    ),
    {
      pausedUntil: 0,
      error: '1 CelesTrak group missing (CelesTrak answered 404)',
    },
  );
  // An empty cache and a 404 for every group: missing, not unreachable.
  assert.deepEqual(
    celestrakGroupsStatus(
      groupsAnswering(() => ({ ok: false, gone: true })),
      now,
    ),
    {
      pausedUntil: 0,
      error: '11 CelesTrak groups missing (CelesTrak answered 404)',
    },
  );
  // A 404 among other failures: all of them unavailable.
  assert.deepEqual(
    celestrakGroupsStatus(
      groupsAnswering((path) =>
        path === 'geo'
          ? { ok: false, gone: true }
          : path === 'sar'
            ? { ok: false }
            : { ok: true },
      ),
      now,
    ),
    { pausedUntil: 0, error: '2 CelesTrak groups unavailable' },
  );
  // Paused, with a group missing: the pause holds every group still asked
  // for, and the missing one is said beside it.
  assert.deepEqual(
    celestrakGroupsStatus(
      groupsAnswering((path) =>
        path === 'geo'
          ? { ok: false, gone: true }
          : { ok: true, stale: true, heldUntil: soon },
      ),
      now,
    ),
    {
      pausedUntil: soon,
      error: '1 CelesTrak group missing (CelesTrak answered 404)',
    },
  );
});

test('the pause is told until its end as the row is drawn, the missing groups on the info line meanwhile', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  let now = Date.parse('2026-11-22T12:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const soon = now + 15 * 60_000;
  const { state, update } = ingestionFor('', {
    source: {
      readGroup: async (path) =>
        path === 'geo'
          ? { ok: false, status: 502, text: '', heldUntil: soon }
          : {
              ok: true,
              status: 200,
              text: gpFor(path),
              stale: true,
              heldUntil: soon,
            },
    },
  });
  await update();
  const row = controlsOf(state);
  assert.equal(row.getStats().error, celestrakPausedError(soon));
  assert.equal(
    row.getStats().error,
    'CelesTrak paused until 2026-11-22T12:15:00.000Z (its usage policy)',
  );
  assert.equal(row.getStats().status, 'degraded');
  assert.equal(row.getRowControls().info, '1 CelesTrak group unavailable');
  // The end passes before the next update: what holds without the pause.
  now = soon;
  assert.equal(row.getStats().error, '1 CelesTrak group unavailable');
  assert.equal(row.getRowControls().info, '');
  // No group at all is unavailable, whatever the text.
  const cold = ingestionFor('', {
    source: {
      readGroup: async () => ({
        ok: false,
        status: 502,
        text: '',
        heldUntil: now + 60_000,
      }),
    },
  });
  await cold.update();
  assert.equal(controlsOf(cold.state).getStats().status, 'unavailable');
});

test('the groups are read two at a time, and SATCAT, two at a time too, only once they are in', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const asked = [];
  const reading = { gp: 0, satcat: 0 };
  const most = { gp: 0, satcat: 0 };
  const read = async (kind, path, answer) => {
    asked.push(`${kind} ${path}`);
    reading[kind]++;
    most[kind] = Math.max(most[kind], reading[kind]);
    await new Promise(setImmediate);
    reading[kind]--;
    return answer;
  };
  const { update } = ingestionFor('', {
    source: {
      readGroup: (path) => read('gp', path, { ok: true, text: gpFor(path) }),
      readSatcat: (path) => {
        assert.equal(reading.gp, 0, 'every GP read is in');
        return read('satcat', path, { ok: false, text: '' });
      },
    },
  });
  await update();
  assert.deepEqual(most, {
    gp: CELESTRAK_READS_AT_ONCE,
    satcat: CELESTRAK_READS_AT_ONCE,
  });
  assert.deepEqual(asked, [
    ...CATALOG_GROUPS.map(({ path }) => `gp ${path}`),
    ...CATALOG_GROUPS.map(({ path }) => `satcat ${path}`),
  ]);
});

test('while paused, the info line keeps to 72 characters in every language, a SATCAT notice that does not fit in its tooltip', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const heldUntil = Date.now() + 60 * 60_000;
  const { state, update } = ingestionFor('', {
    source: {
      readGroup: async (path) =>
        path === 'geo'
          ? { ok: false, status: 502, text: '', heldUntil }
          : { ok: true, text: gpFor(path), stale: true, heldUntil },
      readSatcat: async () => ({ ok: false, text: '' }),
    },
  });
  await update();
  assert.equal(state._satcatState, 'unavailable');
  t.after(() => setLocale('en'));
  for (const locale of [
    'en',
    'sv',
    'ar',
    'de',
    'es',
    'fr',
    'he',
    'it',
    'ja',
    'pt',
    'ru',
    'uk',
    'zh-CN',
    'zh-Hant',
  ]) {
    setLocale(locale);
    const { info, infoTitle } = controlsOf(state).getRowControls();
    const satcat = controlsOf({ ...state, _pausedUntil: 0 }).getRowControls();
    assert.ok(info.length <= 72, `${locale}: ${info.length} ${info}`);
    // The unavailable group is on the line, in the language.
    assert.match(info, /CelesTrak/, `${locale}: ${info}`);
    assert.doesNotMatch(
      info,
      locale === 'en' ? /paused/ : /unavailable|paused/,
      `${locale}: ${info}`,
    );
    // The SATCAT notice is on the line, or first in the tooltip.
    assert.ok(
      info.endsWith(satcat.info) || infoTitle.startsWith(satcat.info),
      `${locale}: ${info} | ${infoTitle}`,
    );
  }
});

test('a group not in within TLE_WAIT_MS is told as unavailable, so the layer still settles', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const asked = [];
  const { state, update } = ingestionFor('', {
    source: {
      readGroup: (path, { signal }) => {
        asked.push(path);
        if (path === 'stations')
          return Promise.resolve({ ok: true, text: gpFor(path) });
        // The others hang, as a slow CelesTrak behind the proxy's queue.
        return new Promise((resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          }),
        );
      },
    },
  });
  let settled = false;
  const rebuilt = update().then(() => {
    settled = true;
  });
  for (let turn = 0; turn < 20; turn += 1)
    await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'still waiting');
  t.mock.timers.tick(TLE_WAIT_MS);
  await rebuilt;
  // Two at a time: stations came, visual and gps-ops were given up, and
  // the rest were not asked for in this update.
  assert.deepEqual(asked, ['stations', 'visual', 'gps-ops']);
  assert.equal(state._count, 1);
  assert.equal(state._lastError, '10 CelesTrak groups unavailable');
});

test('a failed imaging-sensor pack is warned about, as the UCS pack is', async (t) => {
  t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});
  const { state, update } = ingestionFor(gpSet('OLD STAGE', '40115'), {
    source: {
      readSensors: async () => {
        throw new Error('chunk failed');
      },
    },
  });
  await update();
  assert.ok(
    warn.mock.calls.some((call) =>
      /sensor pack unavailable/i.test(call.arguments[0]),
    ),
    'the failure is not swallowed',
  );
  assert.equal(state._catalog.get(40115).sensor, null, 'base zoom steps');
});

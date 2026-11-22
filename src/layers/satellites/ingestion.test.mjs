import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTleText, tleLineLaunchYear } from '../../sources/tle.js';
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

// The ISS set (1 January 2024) with its catalog field swapped per satellite.
const ISS_LINE1 =
  '1 25544U 98067A   24001.50000000  .00016717  00000-0  30370-3 0  9993';
const ISS_LINE2 =
  '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.50377579432323';

function tleSet(name, field) {
  return [
    name,
    ISS_LINE1.replace('25544', field),
    ISS_LINE2.replace('25544', field),
  ].join('\n');
}

// Orbit tracks hand their path to the renderer; positions pass through here.
const orbitParts = {
  rendering: { _rendererPositions: (positions) => positions },
};

function ingestionFor(catalogText, { source: sourceExtras = {} } = {}) {
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
    now: Date.now,
    coverageChanged() {},
  };
  const parts = {
    orbits: {
      parseTLE: parseTleText,
      propagatePosition: () => ({ longitude: 0, latitude: 0, altitude: 4e5 }),
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

test('every Alpha-5 satellite keeps its own catalog entry through dedupe', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  const { state, update } = ingestionFor(
    [
      tleSet('FIRST', 'A0000'),
      tleSet('SECOND', 'B0001'),
      tleSet('THIRD', 'Z9999'),
    ].join('\n'),
  );
  await update();
  assert.deepEqual(
    [...state._catalog].map(([id, entry]) => [id, entry.name]),
    [
      [100000, 'FIRST'],
      [110001, 'SECOND'],
      [339999, 'THIRD'],
    ],
  );
  assert.deepEqual([...state._points.keys()], [100000, 110001, 339999]);
  assert.equal(state._count, 3);
});

test('a mission payload does not match a loaded satellite from another launch year', async (t) => {
  t.mock.method(console, 'log', () => {});
  t.mock.method(console, 'warn', () => {});
  // SXM-11, international designator 2026-148A.
  const { state, update } = ingestionFor(
    [
      'SXM-11',
      '1 69728U 26148A   26208.65166678  .00000015  00000+0  00000+0 0  9990',
      '2 69728   0.0784 264.9826 0001797 240.4588 273.9506  1.00271527   440',
    ].join('\n'),
  );
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
  const { state, update } = ingestionFor(
    [
      'SXM-11',
      '1 69728U          26208.65166678  .00000015  00000+0  00000+0 0  9990',
      '2 69728   0.0784 264.9826 0001797 240.4588 273.9506  1.00271527   440',
    ].join('\n'),
  );
  await update();
  const { getSatelliteOrbitTrack } = createOrbits({ state, parts: orbitParts });
  assert.equal(tleLineLaunchYear('1 69728U          26208.65166678'), null);
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
    (path) => (path === 'stations' ? tleSet('OLD STAGE', '40115') : ''),
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
      ? tleSet('ZZ TESTSAT', '50001')
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
  const { state, update } = ingestionFor(tleSet('ZZ TESTSAT', '50002'), {
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
  const { state, update } = ingestionFor(tleSet('OLD STAGE', '40115'), {
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
  const { state, update } = ingestionFor(tleSet('ZZ TESTSAT', '50003'), {
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
function tleFor(path) {
  if (!groupIds.has(path)) groupIds.set(path, String(40200 + groupIds.size));
  return tleSet(`SAT ${path}`, groupIds.get(path));
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
              text: tleFor(path),
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
  const reading = { tle: 0, satcat: 0 };
  const most = { tle: 0, satcat: 0 };
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
      readGroup: (path) => read('tle', path, { ok: true, text: tleFor(path) }),
      readSatcat: (path) => {
        assert.equal(reading.tle, 0, 'every TLE read is in');
        return read('satcat', path, { ok: false, text: '' });
      },
    },
  });
  await update();
  assert.deepEqual(most, {
    tle: CELESTRAK_READS_AT_ONCE,
    satcat: CELESTRAK_READS_AT_ONCE,
  });
  assert.deepEqual(asked, [
    ...CATALOG_GROUPS.map(({ path }) => `tle ${path}`),
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
          : { ok: true, text: tleFor(path), stale: true, heldUntil },
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
          return Promise.resolve({ ok: true, text: tleFor(path) });
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
  const { state, update } = ingestionFor(tleSet('OLD STAGE', '40115'), {
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

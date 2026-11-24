/**
 * Swedish fork: the Cockpit's driver's view ("Förarvy") from the bus, tram
 * or train selected on the map. Two subject providers
 * (src/cockpitSubjectProviders.js; docs/APPLICATION.md, "Cockpit subjects"):
 * one rides the Transit layer's selected vehicle, one the Rail layer's
 * selected train, through their read and hold APIs
 * (src/layers/transit/cockpitSubject.js, src/layers/rail/cockpitSubject.js).
 * src/standalone/controls.js hands them to the controls.
 *
 * The eye sits where the layer draws the vehicle (`anchor: 'exact'`: the
 * layer already moves it smoothly), at a driver's height above the floor it
 * stands on, and turns with its drawn course. The layers draw a vehicle 25 to
 * 120 s behind real time, in a straight line from one position report to the
 * next unless a train runs along its line. The HUD says so, says whether its
 * speed was reported or worked out between two reports, and gives a stop only
 * as the id the newest report named. Nothing on it is guessed.
 *
 * Leaving the view brings the map back to the vehicle, seen from above: Rail's
 * focusTrain does that for a train, and a Transit vehicle is framed through
 * `requestWorldFocus` (src/worldFocus.js), since Transit's focusVehicle only
 * selects it.
 *
 * `candidate()` runs four times a second for each provider, its layer on or
 * off, so every layer call is guarded: a layer that throws or lacks a method
 * has nothing to ride. No timers, listeners or network requests of its own: a
 * held vehicle's feed is polled by the layer's hold, on the layer's own tick.
 */
import { formatNumber, getLocale, msg, t } from '../i18n/index.js';
import { pointAtS } from '../data/railPaths.js';
import { getRegisteredTransitFeed } from '../data/transitFeeds.js';
import { fromDegrees } from '../geo/ellipsoid.js';
import { lookReadoutParts } from '../cockpitLook.js';

/**
 * A driver's eye above the floor the layer draws the vehicle on (m): the
 * road under a bus or coach, the rail top under a tram or train, the street
 * over a metro (the layers draw an underground train at street level: no feed
 * gives its depth, and the HUD says so), the waterline under a ferry.
 * Proposals, not published figures: no source gives these heights. A
 * trolleybus is a bus; Transit names no coach (GTFS 200s are buses), so
 * `coach` waits for a layer that does.
 */
const EYE_HEIGHTS_M = Object.freeze({
  bus: 2.4,
  coach: 2.6,
  trolleybus: 2.4,
  tram: 2.5,
  subway: 2.4,
  metro: 2.4,
  rail: 3,
  ferry: 6,
});
/** Any other vehicle's eye (m). */
const OTHER_EYE_HEIGHT_M = 2.5;
/** The view rests a little down the road ahead. */
const REST_PITCH_DEG = -3;
/** The eye keeps at least this far above the floor under it (m). */
const MIN_CLEARANCE_M = 1.5;

/**
 * An eye `upM` above the vehicle's reported place. It is not moved forward
 * to a windscreen: where on the vehicle its GPS sits is not known, and the
 * layer hides the held vehicle's model.
 */
const eyeAt = (upM) =>
  Object.freeze({
    upM,
    forwardM: 0,
    pitchDeg: REST_PITCH_DEG,
    minClearanceM: MIN_CLEARANCE_M,
  });
const EYES = new Map(
  Object.entries(EYE_HEIGHTS_M).map(([mode, upM]) => [mode, eyeAt(upM)]),
);
const OTHER_EYE = eyeAt(OTHER_EYE_HEIGHT_M);

/** Entry glyphs, each in the page's Material Symbols subset. */
const BUS_GLYPH = Object.freeze({ icon: 'directions_bus' });
const TRAIN_GLYPH = Object.freeze({ icon: 'train' });
const BOAT_GLYPH = Object.freeze({ icon: 'directions_boat' });
/** The entry's glyph by mode; any other mode takes its provider's. */
const GLYPHS = Object.freeze({
  bus: BUS_GLYPH,
  coach: BUS_GLYPH,
  trolleybus: BUS_GLYPH,
  tram: TRAIN_GLYPH,
  cable_tram: TRAIN_GLYPH,
  subway: TRAIN_GLYPH,
  metro: TRAIN_GLYPH,
  monorail: TRAIN_GLYPH,
  rail: TRAIN_GLYPH,
  funicular: TRAIN_GLYPH,
  ferry: BOAT_GLYPH,
});

/** What runs, in the Transit and Rail cards' words. */
const MODE_WORDS = Object.freeze({
  bus: msg('Bus'),
  coach: msg('Bus'),
  trolleybus: msg('Trolleybus'),
  tram: msg('Tram'),
  cable_tram: msg('Cable car'),
  subway: msg('Subway'),
  metro: msg('Subway'),
  monorail: msg('Monorail'),
  rail: msg('Train'),
  funicular: msg('Funicular'),
  aerial_lift: msg('Gondola'),
  ferry: msg('Ferry'),
});

/** A stop's caption by its GTFS-RT status in the newest report. */
const STOP_LABELS = Object.freeze({
  IN_TRANSIT_TO: msg('NEXT STOP'),
  INCOMING_AT: msg('ARRIVING AT'),
  STOPPED_AT: msg('AT STOP'),
});

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const textOf = (value) =>
  typeof value === 'string' && value.trim() ? value.trim() : '';
/** `table`'s own entry for `key`, else undefined: a mode is layer data. */
const entryOf = (table, key) =>
  typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : undefined;
const eyeOf = (mode, fallback) => EYES.get(mode) ?? fallback;

/**
 * `layer[method](arg)`, or `fallback` when the layer has no such method or
 * it throws: a layer that fails has nothing to ride.
 */
function ask(layer, method, arg, fallback = null) {
  try {
    const call = layer?.[method];
    return typeof call === 'function' ? call.call(layer, arg) : fallback;
  } catch {
    return fallback;
  }
}

/** A layer's snapshot of a vehicle (it has a key), or null; never throws. */
function subjectOf(value) {
  try {
    return value !== null &&
      typeof value === 'object' &&
      typeof value.key === 'string' &&
      value.key
      ? value
      : null;
  } catch {
    return null;
  }
}

/** Whether `previous` holds each of `next`'s values (the layers' `reuse`). */
function sameValues(previous, next) {
  if (!previous) return false;
  for (const name in next)
    if (!Object.is(previous[name], next[name])) return false;
  return true;
}

/**
 * The speed the view moves at (m/s): worked out between the two reports
 * playback draws the vehicle between, which is the motion shown, else as the
 * newest report gives it (a report playback has not reached). Null when
 * neither is known. The snapshot's `speedSource` prefers the report, which
 * would put a speed the picture does not show beside it.
 */
function speedOf(motion) {
  if (finite(motion?.derivedSpeedMps) && motion.derivedSpeedMps >= 0)
    return motion.derivedSpeedMps;
  return finite(motion?.reportedSpeedMps) && motion.reportedSpeedMps >= 0
    ? motion.reportedSpeedMps
    : null;
}

/** Where speedOf's speed comes from: 'derived', 'reported' or null. */
function speedSourceOf(motion) {
  if (finite(motion?.derivedSpeedMps) && motion.derivedSpeedMps >= 0)
    return 'derived';
  return finite(motion?.reportedSpeedMps) && motion.reportedSpeedMps >= 0
    ? 'reported'
    : null;
}

/** Whole seconds in `ms`, or null when it is not known. */
const secondsOf = (ms) =>
  finite(ms) ? Math.max(0, Math.round(ms / 1000)) : null;

/** A report's age as the cards give it: seconds under 90 s, then minutes. */
function ageText(seconds) {
  return seconds < 90
    ? t('{n} s ago', { n: seconds })
    : t('{n} min ago', { n: Math.floor(seconds / 60) });
}

/** The layer's motion word (transit/movement.js) in the cards' words. */
function motionText(word) {
  if (word === 'EN ROUTE') return t('Moving');
  if (word === 'STOPPED') return t('Stopped', { context: 'vehicle motion' });
  if (word === 'NO FIX') return t('No recent fix');
  if (word === 'WAITING') return t('Waiting for update');
  return '';
}

/** The speed's tag: whether it was reported or worked out. */
function speedTag(source) {
  if (source === 'derived') return t('COMPUTED');
  if (source === 'reported') return t('REPORTED');
  return '';
}

/**
 * The feed's credit as the layer gives it ("Trafiklab / Samtrafiken GTFS
 * Regional (CC0 1.0)"), and its licence on a row of its own unless the credit
 * names it: together they can pass the 120 characters a row shows. None
 * without a feed.
 */
function sourceRows(feed, locale) {
  const credit =
    textOf(feed?.attribution) || textOf(feed?.operator) || textOf(feed?.name);
  const licence = textOf(feed?.license);
  const rows = [];
  if (credit) rows.push({ id: 'feed', label: t('SOURCE'), text: credit });
  if (licence && !credit.includes(licence))
    rows.push({
      id: 'licence',
      label: t('Licence').toLocaleUpperCase(locale),
      text: licence,
    });
  return rows;
}

/** A turned view in a driver's words: right, left or back, up or down. */
function lookText(look) {
  const { side, bearingDeg, elevation, angleDeg } = lookReadoutParts(
    look,
    REST_PITCH_DEG,
  );
  const bearing = formatNumber(bearingDeg);
  const angle = formatNumber(angleDeg);
  let direction = '';
  if (side === 'starboard') direction = t('LOOK RIGHT {bearing}°', { bearing });
  else if (side === 'port') direction = t('LOOK LEFT {bearing}°', { bearing });
  else if (side === 'astern') direction = t('LOOK BACK');
  let tilt = '';
  if (elevation === 'up') tilt = t('UP {angle}°', { angle });
  else if (elevation === 'down') tilt = t('DOWN {angle}°', { angle });
  else if (elevation === 'level') tilt = t('LEVEL');
  if (direction && tilt)
    return t('{direction} · {elevation}', { direction, elevation: tilt });
  if (tilt) return t('LOOK {elevation}', { elevation: tilt });
  return direction;
}

/** A frame's place, filled by a ride's `place` (read() copies it at once). */
const scratchPlace = { latitude: NaN, longitude: NaN, headingDeg: NaN };
const scratchPoint = {};

/** Where the layer draws the vehicle, facing its drawn course. */
function placeAtPosition(subject, out) {
  out.latitude = subject.position?.latitude;
  out.longitude = subject.position?.longitude;
  out.headingDeg = subject.motion?.courseDeg;
  return out;
}

/**
 * A train bound to its line stands where the line puts it, facing the way it
 * runs along it (docs/APPLICATION.md). A Swedish train has no line: it stands
 * where it is drawn, facing its drawn course.
 */
function placeOnLine(subject, out) {
  const path = subject.path;
  const point = path ? pointAtS(path.line, path.s, scratchPoint) : null;
  if (!point || !finite(point.lat) || !finite(point.lon))
    return placeAtPosition(subject, out);
  out.latitude = point.lat;
  out.longitude = point.lon;
  out.headingDeg = finite(point.bearingDeg)
    ? path.direction < 0
      ? point.bearingDeg + 180
      : point.bearingDeg
    : subject.motion?.courseDeg;
  return out;
}

/** Trafikverket's trains in Transit: their route id is the train's number. */
const SWEDISH_TRAINS_FEED_ID = 'trafikverket-trains';
/** A route id of this many digits is a database key, never a line's name. */
const ROUTE_KEY_PATTERN = /^\d{8,}$/;
/** The last line transitLine worked out, by feed and route. */
const lastLine = { feedId: null, routeId: null, line: '' };

/**
 * A Transit vehicle's line as its feed names it ("4"), or ''. Only a feed
 * with route names of its own (`routeLabel`, src/data/transitFeeds.js) has
 * lines: for any other the snapshot's `routeLabel` is the bare route id,
 * Trafikverket's train number or a 16-digit GTFS key.
 */
function transitLine(subject) {
  const feedId = subject.feedId ?? subject.feed?.id ?? null;
  const routeId = subject.routeId ?? null;
  if (lastLine.feedId === feedId && lastLine.routeId === routeId)
    return lastLine.line;
  let line = '';
  try {
    const feed = getRegisteredTransitFeed(feedId);
    if (routeId && typeof feed?.routeLabel === 'function')
      line = textOf(feed.routeLabel(routeId));
  } catch {
    line = '';
  }
  if (ROUTE_KEY_PATTERN.test(line)) line = '';
  lastLine.feedId = feedId;
  lastLine.routeId = routeId;
  lastLine.line = line;
  return line;
}

/**
 * A Transit vehicle's name, as its card heads it ("Linje 4"), with the
 * vehicle's own label when the feed gives one. A vehicle with no line goes by
 * its label, a Swedish train by its number ("Tåg 2861").
 */
function transitName(subject, word) {
  const line = transitLine(subject);
  const label = textOf(subject.label);
  if (line) {
    const named = t('Route {route}', { route: line });
    return label && label !== line ? `${named} · ${label}` : named;
  }
  const number = textOf(subject.routeId);
  if (subject.feedId === SWEDISH_TRAINS_FEED_ID && number)
    return t('Train {number}', { number });
  return label ? t('Vehicle {vehicle}', { vehicle: label }) : t(word);
}

/**
 * A train's name as the Rail layer gives it to Context (`named`: "Tåg 2861
 * mot Stockholm C"), else its label.
 */
function railName(subject, word, named) {
  return named || textOf(subject.label) || t(word);
}

/**
 * Ask the camera to frame a vehicle from above once its view is left, as
 * Rail's follow frames a train. Framed by its kind, not from the view the
 * camera has (`keepView`), which would leave it at street level where the eye
 * was. No framing is a road vehicle's; a train's (WORLD_FOCUS_FRAMING.train,
 * 2.5 km off and 35° down) shows the vehicle and the streets around it, and
 * is what a train ride ends on. A vehicle whose floor is not known yet is
 * aimed at the ellipsoid; from 2.5 km off the frame hardly moves.
 */
function frameFromAbove(requestFocus, subject, label) {
  const position = subject?.position;
  if (!finite(position?.latitude) || !finite(position?.longitude)) return;
  const heightM = finite(position.groundHeightM) ? position.groundHeightM : 0;
  const at = fromDegrees(position.longitude, position.latitude, heightM);
  requestFocus({
    kind: 'train',
    id: subject.key,
    label: label || subject.key,
    position: { x: at.x, y: at.y, z: at.z },
  });
}

/**
 * What sets the Transit ride apart from the Rail one. `modeWord` names what
 * runs when its mode is not known (Transit: nothing, the kicker then names
 * the view); `vehicleWord` names a vehicle nothing else names.
 */
const TRANSIT_RIDE = Object.freeze({
  kind: 'transit-ride',
  layerId: 'transit',
  select: 'getSelectedVehicle',
  focus: 'focusVehicle',
  glyph: BUS_GLYPH,
  modeWord: null,
  vehicleWord: msg('Transit vehicle'),
  eye: OTHER_EYE,
  name: transitName,
  // Its name needs no layer call.
  namedOf: () => '',
  place: placeAtPosition,
  heightOf: (subject) => subject.position?.groundHeightM,
  routeOf: transitLine,
  stopOf: (subject) => subject.stop ?? null,
  straight: () => true,
  // Drawn at street level, as the Transit card says (UNDERGROUND_MODES).
  underground: (subject) => subject.mode === 'subway',
  // focusVehicle only selects: the camera would stay at street level.
  framesOnExit: true,
});

const RAIL_RIDE = Object.freeze({
  kind: 'rail-ride',
  layerId: 'rail',
  select: 'getSelectedTrain',
  focus: 'focusTrain',
  glyph: TRAIN_GLYPH,
  // Rail draws trains, metros and trams; one of no mode is a train, as on
  // its card.
  modeWord: msg('Train'),
  vehicleWord: msg('Train'),
  eye: EYES.get('rail'),
  name: railName,
  // The name Rail gives Context, with the destination once Trafikverket's
  // station calls name it: read again for each view, so a later one shows.
  namedOf: (layer, subject) =>
    textOf(ask(layer, 'findByQuery', subject.key)?.name),
  place: placeOnLine,
  heightOf: (subject) => subject.position?.railHeightM,
  // The timetable's route name; a Swedish train has none, and its route id
  // is its number, not a line.
  routeOf: (subject) => textOf(subject.routeName),
  // Rail snapshots name no stop of the newest report.
  stopOf: () => null,
  straight: (subject) => !subject.path,
  // Drawn at street level, as the Rail card says.
  underground: (subject) => subject.mode === 'metro',
  // focusTrain follows or flies to the train itself.
  framesOnExit: false,
});

/**
 * One ride: a subject provider on `layer`, the Transit or Rail layer
 * instance, as `spec` (TRANSIT_RIDE, RAIL_RIDE) sets it apart.
 * `requestFocus` is src/worldFocus.js's `requestWorldFocus`, or null.
 */
function createRide(spec, layer, requestFocus) {
  /** The vehicle hold() took, and its name for the frame. */
  let heldKey = null;
  let heldName = '';
  /** The snapshot the last read() placed the view on, for hud(). */
  let held = null;
  /** The last candidate and HUD view, returned again while unchanged. */
  let candidate = null;
  let candidateInputs = null;
  const candidateDraft = {};
  let view = null;
  let viewInputs = null;
  const viewDraft = {};
  /** The words outside the HUD, worded again when the language changes. */
  let words = null;
  let wordsLocale = '';

  function wordsNow() {
    const locale = getLocale();
    if (words && wordsLocale === locale) return words;
    wordsLocale = locale;
    const label = t("DRIVER'S VIEW");
    words = {
      label,
      face: Object.freeze({ icon: spec.glyph.icon, label }),
      labels: Object.freeze({
        view: t("Driver's view"),
        exit: t("Exit driver's view"),
        exitText: t('EXIT', { context: 'driver view' }),
        kicker: label,
      }),
      look: Object.freeze({
        restPitchDeg: REST_PITCH_DEG,
        aheadLabel: t('Look ahead'),
      }),
    };
    return words;
  }

  /**
   * What runs, as a word, or null: a mode a feed only defaults to is no
   * fact, so it is not said.
   */
  const wordOf = (subject) =>
    subject.modeInferred === true
      ? null
      : (entryOf(MODE_WORDS, subject.mode) ?? spec.modeWord);
  /**
   * The vehicle's name; `word` is what runs, if known, and `named` the name
   * the layer gives it (Rail's findByQuery).
   */
  const nameOf = (subject, word, named = spec.namedOf(layer, subject)) =>
    spec.name(subject, word ?? spec.vehicleWord, named);

  /** The HUD view for `subject` (see the module comment). */
  function hudOf(subject, look) {
    const motion = subject.motion ?? null;
    const stop = spec.stopOf(subject);
    const looking = look?.offset === true;
    const draft = viewDraft;
    draft.locale = getLocale();
    draft.key = subject.key;
    draft.feed = subject.feed ?? null;
    draft.word = wordOf(subject);
    draft.label = subject.label ?? null;
    draft.named = spec.namedOf(layer, subject);
    draft.route = spec.routeOf(subject);
    draft.straight = spec.straight(subject);
    draft.underground = spec.underground(subject);
    draft.behindS = secondsOf(motion?.shownBehindMs);
    const speedMps = speedOf(motion);
    draft.kmh = speedMps === null ? null : Math.round(speedMps * 3.6);
    draft.speedSource = speedSourceOf(motion);
    draft.ageS = secondsOf(motion?.reportAgeMs);
    draft.stopId = textOf(stop?.stopId);
    draft.stopStatus = stop?.status ?? null;
    draft.motion = typeof motion?.word === 'string' ? motion.word : '';
    draft.stale = motion?.feedStale === true;
    draft.lookYaw = looking ? look.yawDeg : null;
    draft.lookPitch = looking ? look.pitchDeg : null;
    if (view && sameValues(viewInputs, draft)) return view;

    const feedName = textOf(draft.feed?.name);
    const kind = draft.word
      ? t(draft.word).toLocaleUpperCase(draft.locale)
      : wordsNow().label;
    const lag =
      draft.behindS === null
        ? t('SHOWN BEHIND REAL TIME')
        : t('SHOWN {seconds} S BEHIND REAL TIME', { seconds: draft.behindS });
    const readouts = [];
    if (draft.route)
      readouts.push({ id: 'line', label: t('LINE'), value: draft.route });
    if (draft.ageS !== null)
      readouts.push({
        id: 'last-report',
        label: t('LAST REPORT'),
        value: ageText(draft.ageS),
      });
    // The id the newest report gives, never a name: none is in the feed.
    if (draft.stopId) {
      const caption = entryOf(STOP_LABELS, draft.stopStatus);
      readouts.push({
        id: 'stop',
        label: caption ? t(caption) : t('STOP', { context: 'transit stop' }),
        value: draft.stopId,
        detail: t('PER THE LAST REPORT'),
      });
    }
    const moving = motionText(draft.motion);
    if (moving)
      readouts.push({
        id: 'motion',
        label: t('STATUS', { context: 'vehicle motion' }),
        value: moving,
      });
    const signals = [];
    if (draft.stale)
      signals.push({
        id: 'feed-stale',
        tone: 'warning',
        title: t('FEED NOT UPDATED'),
        detail: feedName,
      });
    // An underground train drawn on the street above it, as its card says.
    if (draft.underground)
      signals.push({
        id: 'street-level',
        tone: 'estimate',
        title: kind,
        detail: t('Shown at street level · depth not in the feed'),
      });
    const name = nameOf(subject, draft.word, draft.named);
    const next = Object.freeze({
      kicker: feedName ? `${kind} · ${feedName}` : kind,
      title: name,
      meta: {
        text: draft.straight
          ? `${lag} · ${t('STRAIGHT LINE BETWEEN POSITION REPORTS')}`
          : lag,
        tone: 'estimate',
      },
      speed: {
        value: draft.kmh,
        unit: t('km/h'),
        tag: speedTag(draft.speedSource),
        tone:
          draft.speedSource === 'derived'
            ? 'estimate'
            : draft.speedSource
              ? 'normal'
              : 'muted',
      },
      readouts,
      sources: sourceRows(draft.feed, draft.locale),
      signals,
      lookReadout: looking ? lookText(look) : '',
    });
    // Kept only once built: a view that failed is worded again next time.
    view = next;
    viewInputs = { ...draft };
    heldName = name;
    return view;
  }

  return {
    kind: spec.kind,
    layerId: spec.layerId,
    entryFace: () => wordsNow().face,
    labels: () => wordsNow().labels,
    look: () => wordsNow().look,
    // The layer moves the vehicle every rendered frame; so does the eye.
    cameraIntervalMs: 0,
    candidate() {
      try {
        const subject = subjectOf(ask(layer, spec.select));
        if (!subject) return null;
        const draft = candidateDraft;
        draft.key = subject.key;
        draft.selectedAt = finite(subject.selectedAtMs)
          ? subject.selectedAtMs
          : null;
        draft.mode = subject.mode ?? null;
        draft.word = wordOf(subject);
        draft.label = subject.label ?? null;
        draft.route = spec.routeOf(subject);
        draft.locale = getLocale();
        if (candidate && sameValues(candidateInputs, draft)) return candidate;
        const glyph = entryOf(GLYPHS, draft.mode) ?? spec.glyph;
        const next = Object.freeze({
          id: subject.key,
          name: nameOf(subject, draft.word),
          selectedAt: draft.selectedAt,
          face: Object.freeze({ icon: glyph.icon, label: wordsNow().label }),
        });
        candidate = next;
        candidateInputs = { ...draft };
        return candidate;
      } catch {
        return null;
      }
    },
    isEntryAllowed(entry) {
      try {
        const subject = subjectOf(ask(layer, spec.select));
        return (
          subject !== null &&
          subject.key === entry?.id &&
          finite(subject.position?.latitude) &&
          finite(subject.position?.longitude)
        );
      } catch {
        return false;
      }
    },
    hold(id) {
      const took = ask(layer, 'setCockpitSubject', id, false) === true;
      if (!took) return false;
      heldKey = id;
      held = null;
      view = null;
      viewInputs = null;
      try {
        const subject = subjectOf(ask(layer, 'getCockpitSubject'));
        heldName = subject ? nameOf(subject, wordOf(subject)) : '';
      } catch {
        heldName = '';
      }
      return true;
    },
    read() {
      try {
        const subject = subjectOf(ask(layer, 'getCockpitSubject'));
        // Gone, or another vehicle held: the view ends.
        if (!subject || subject.key !== heldKey) {
          held = null;
          return null;
        }
        held = subject;
        const place = spec.place(subject, scratchPlace);
        const heightM = spec.heightOf(subject);
        return {
          id: subject.key,
          name: heldName,
          latitude: place.latitude,
          longitude: place.longitude,
          // Null while the layer knows no floor there: the Cockpit waits.
          heightM: finite(heightM) ? heightM : null,
          headingDeg: finite(place.headingDeg) ? place.headingDeg : null,
          speedMps: speedOf(subject.motion),
          stale: subject.motion?.feedStale === true,
          anchor: 'exact',
          eye: eyeOf(subject.mode, spec.eye),
        };
      } catch {
        held = null;
        return null;
      }
    },
    hud(frame, ctx) {
      try {
        // The snapshot the frame came from, else the layer's now.
        let subject = held;
        if (!subject || subject.key !== frame?.id) {
          subject = subjectOf(ask(layer, 'getCockpitSubject'));
          if (!subject || subject.key !== frame?.id) return null;
        }
        return hudOf(subject, ctx?.look);
      } catch {
        return null;
      }
    },
    release(id, options) {
      try {
        // What the view last showed of it, for the camera on the way out.
        const last = held?.key === id ? held : null;
        const lastName = heldKey === id ? heldName : '';
        const holding = subjectOf(ask(layer, 'getCockpitSubject'));
        // Harmless for a vehicle it does not hold: another held one stays.
        if (!holding || holding.key === id)
          ask(layer, 'setCockpitSubject', null);
        if (heldKey === id) {
          heldKey = null;
          heldName = '';
          held = null;
          view = null;
          viewInputs = null;
        }
        if (options?.restore !== true) return;
        ask(layer, spec.focus, id);
        if (spec.framesOnExit && typeof requestFocus === 'function') {
          const selected = subjectOf(ask(layer, spec.select));
          frameFromAbove(
            requestFocus,
            selected?.key === id ? selected : last,
            lastName,
          );
        }
      } catch {
        // A getter on `options` or a snapshot, or the camera's request:
        // the view is gone either way.
      }
    },
  };
}

/**
 * The Cockpit's rides on the selected Transit vehicle and Rail train, as
 * subject providers for `services.cockpitSubjects`: 0–2 of them, none for a
 * layer that is missing.
 * @param {{rail?: object|null, transit?: object|null,
 *   requestWorldFocus?: Function|null}} [options] The catalog's Rail and
 *   Transit layer instances, and src/worldFocus.js's `requestWorldFocus`,
 *   which frames a Transit vehicle from above when its view is left.
 * @returns {object[]}
 */
export function createCockpitRides({
  rail,
  transit,
  requestWorldFocus = null,
} = {}) {
  const isLayer = (layer) => layer !== null && typeof layer === 'object';
  const rides = [];
  if (isLayer(transit))
    rides.push(createRide(TRANSIT_RIDE, transit, requestWorldFocus));
  if (isLayer(rail)) rides.push(createRide(RAIL_RIDE, rail, requestWorldFocus));
  return rides;
}

/**
 * Swedish fork: Trafikverket's current railway disruptions in the Rail
 * layer (`GET /api/rail/disruptions`, src/sources/trafikverketRailDisruptions.js).
 *
 * One points set: a red dot on each Swedish station (or place) an ongoing
 * disruption affects, a chip to show or hide them (on by default when the
 * server offers Sweden's trains, that is when it has the Trafikverket key)
 * and a legend row. A click on a dot opens a world-overlay card with what
 * Trafikverket publishes for the disruptions there: its message, cause,
 * stretch, affected stations, start, forecast and last update.
 *
 * Asked for at most once every RAIL_DISRUPTIONS_REFRESH_MS, and only while
 * Sweden's train feed is in use (the camera over Sweden, low enough for the
 * layer's feeds). The set is written only when the snapshot changes; there is
 * no per-frame work.
 */
import { t } from '../../i18n/index.js';
import { drawOf } from '../../render/rendererOf.js';
import { fromDegrees } from '../../geo/ellipsoid.js';

/** The Rail feed whose presence in the catalog means the server has the key. */
export const RAIL_DISRUPTIONS_FEED_ID = 'trafikverket-trains';
export const RAIL_DISRUPTIONS_OVERLAY_SOURCE_ID = 'rail-disruptions';
/** Shortest time between two asks; the server refreshes no faster. */
export const RAIL_DISRUPTIONS_REFRESH_MS = 2 * 60_000;
/** After a failed ask. */
const RETRY_MS = 2 * 60_000;
export const RAIL_DISRUPTION_COLOR = '#FF3B30';
/** Disruptions one card lists before it counts the rest. */
const CARD_MAX_DISRUPTIONS = 2;
/**
 * Longest card line. Trafikverket's texts run to several hundred characters,
 * and a card taller than the screen is never drawn at all.
 */
const CARD_LINE_MAX = 72;

/** A card line cut at a word, with an ellipsis when it was longer. */
function cardLine(text) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  if (s.length <= CARD_LINE_MAX) return s;
  const cut = s.slice(0, CARD_LINE_MAX - 2);
  const space = cut.lastIndexOf(' ');
  return `${(space > CARD_LINE_MAX / 2 ? cut.slice(0, space) : cut).trimEnd()} …`;
}
const PICK_PREFIX = 'se-rail-disruption:';
const CARD_HOST_OPTIONS = Object.freeze({
  cohortLimit: 1,
  collisionCapacity: 1,
  moving: false,
});

/** Layers built so far, so each one's set has an id of its own. */
let instances = 0;

const CLOCK = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  hour: '2-digit',
  minute: '2-digit',
});
const DAY = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Stockholm',
  day: 'numeric',
  month: 'numeric',
});

/**
 * A time on Swedish clocks: "17:34" today, "18/11 06:00" on another day.
 * @param {number} ms
 * @param {number} now
 * @returns {string}
 */
export function disruptionClock(ms, now) {
  if (!Number.isFinite(ms)) return '';
  const clock = CLOCK.format(ms);
  return DAY.format(ms) === DAY.format(now)
    ? clock
    : `${DAY.format(ms).replace('.', '/')} ${clock}`;
}

/**
 * The card lines of one disruption: what happened, where, and until when.
 * The card stays short enough to fit on the screen.
 */
function disruptionLines(record, now, t) {
  const lines = [];
  const first = record.header ?? record.reason ?? t('Rail disruption');
  lines.push(cardLine(first));
  if (record.description) lines.push(cardLine(record.description));
  if (record.stretch)
    lines.push(cardLine(t('Stretch: {stretch}', { stretch: record.stretch })));
  if (Number.isFinite(record.end))
    lines.push(
      record.endKind === 'impact'
        ? t('Expected to last until {time}', {
            time: disruptionClock(record.end, now),
          })
        : t('Next forecast expected {time}', {
            time: disruptionClock(record.end, now),
          }),
    );
  else if (Number.isFinite(record.start))
    lines.push(t('Since {time}', { time: disruptionClock(record.start, now) }));
  return lines;
}

/**
 * The card of one place: the disruptions there, newest first.
 * @param {{id: string, name: string}} place
 * @param {object[]} records The place's disruptions, newest first.
 * @param {number} now
 * @param {typeof t} [translate]
 * @returns {{title: string, details: string[]}}
 */
export function buildRailDisruptionCopy(place, records, now, translate = t) {
  return disruptionCopy(place, records, now, translate);
}

/** buildRailDisruptionCopy with its translation as `t`, as the catalog reads it. */
function disruptionCopy(place, records, now, t) {
  const details = [];
  const shown = records.slice(0, CARD_MAX_DISRUPTIONS);
  shown.forEach((record, index) => {
    if (index > 0) details.push('—');
    details.push(...disruptionLines(record, now, t));
  });
  const more = records.length - shown.length;
  if (more > 0)
    details.push(t('More disruptions here: {count}', { count: more }));
  // i18n-ignore: agency name
  details.push(t('Source: {value}', { value: 'Trafikverket' }));
  return {
    title: `⚠ ${t('Rail disruption · {place}', { place: place.name })}`,
    details,
  };
}

/**
 * The disruptions part of one Rail layer.
 * @param {object} context
 * @returns {object}
 */
export function createRailDisruptions({ state, services, source }) {
  const setId = `rail-disruptions-${(instances += 1)}`;
  let dots = null;
  let shown = true;
  let records = new Map();
  let places = [];
  const placeById = new Map();
  let signature = null;
  let selectedId = null;
  let nextAskAt = 0;
  let request = null;
  let lastError = null;

  /** Whether the server offers Sweden's trains, so has the key. */
  const available = () =>
    typeof source?.requestDisruptions === 'function' &&
    Array.isArray(state._catalog) &&
    state._catalog.some((feed) => feed.id === RAIL_DISRUPTIONS_FEED_ID);

  const requestRender = () =>
    services.render.governorRequestRender('rail-disruptions');

  const dotOf = (place) => ({
    id: `${PICK_PREFIX}${place.id}`,
    pos: {
      lon: place.lon,
      lat: place.lat,
      height: 0,
    },
    height: 'clampGround',
    pixelSize: 11,
    color: RAIL_DISRUPTION_COLOR,
    outlineColor: '#ffffff',
    outlineWidth: 2,
    disableDepthTest: Number.POSITIVE_INFINITY,
  });

  function createSet(viewer) {
    if (dots) return;
    dots = drawOf(viewer).points({
      id: setId,
      // A few hundred dots at most: terrain only, never the 3D tiles
      // (src/layers/groundHeights.js).
      clampTo: 'terrain',
      horizonCull: true,
      show: false,
    });
  }

  function applyShow() {
    if (dots) dots.show = state._enabled && shown && available();
  }

  function publishCard() {
    const place = selectedId ? placeById.get(selectedId) : null;
    if (!place || !shown || !state._enabled) {
      selectedId = null;
      state._overlayHost.setEntries(
        RAIL_DISRUPTIONS_OVERLAY_SOURCE_ID,
        [],
        CARD_HOST_OPTIONS,
      );
      return;
    }
    const copy = buildRailDisruptionCopy(
      place,
      place.disruptions.map((id) => records.get(id)).filter(Boolean),
      Date.now(),
    );
    state._overlayHost.setEntries(
      RAIL_DISRUPTIONS_OVERLAY_SOURCE_ID,
      [
        {
          id: `rail-disruption-card:${place.id}`,
          position: fromDegrees(place.lon, place.lat, 0),
          variant: 'selected',
          selected: true,
          protected: true,
          paintLane: 'selected',
          collisionGroup: 'ambient-card',
          priority: Number.MAX_SAFE_INTEGER,
          title: copy.title,
          details: copy.details,
          accent: RAIL_DISRUPTION_COLOR,
          interactive: false,
          anchorRadiusPx: 7,
          minAnchorGapPx: 11,
          verticalOnly: true,
          placement: 'above',
          edgeFade: 'keyhole',
          horizonCull: true,
          terrainOcclusion: false,
        },
      ],
      CARD_HOST_OPTIONS,
    );
  }

  /** Take a snapshot from the server; the set is written only on change. */
  function accept(snapshot) {
    const nextPlaces = (
      Array.isArray(snapshot?.places) ? snapshot.places : []
    ).filter(
      (place) =>
        typeof place?.id === 'string' &&
        Number.isFinite(place.lat) &&
        Number.isFinite(place.lon) &&
        Array.isArray(place.disruptions),
    );
    const nextRecords = new Map(
      (Array.isArray(snapshot?.disruptions) ? snapshot.disruptions : [])
        .filter((record) => typeof record?.id === 'string')
        .map((record) => [record.id, record]),
    );
    const next = JSON.stringify([nextPlaces, [...nextRecords.values()]]);
    if (next === signature) return;
    signature = next;
    records = nextRecords;
    places = nextPlaces;
    placeById.clear();
    for (const place of places) placeById.set(place.id, place);
    dots?.set(places.map(dotOf));
    if (selectedId) publishCard();
    requestRender();
  }

  /**
   * Ask the server again when it is time: the layer is on, the chip is on
   * and Sweden's train feed is in use.
   */
  async function refresh() {
    if (!state._enabled || !shown || !available() || request) return;
    if (!state._activeFeeds.has(RAIL_DISRUPTIONS_FEED_ID)) return;
    const now = Date.now();
    if (now < nextAskAt) return;
    const controller = new AbortController();
    const generation = state._generation;
    request = controller;
    nextAskAt = now + RAIL_DISRUPTIONS_REFRESH_MS;
    try {
      const snapshot = await source.requestDisruptions({
        signal: controller.signal,
      });
      if (controller.signal.aborted || generation !== state._generation) return;
      lastError = null;
      accept(snapshot);
      state._controlsListener?.();
    } catch (error) {
      if (controller.signal.aborted || generation !== state._generation) return;
      lastError = String(error?.message || error);
      nextAskAt = Date.now() + RETRY_MS;
      console.warn('[Data:Rail] disruptions:', lastError);
    } finally {
      if (request === controller) request = null;
    }
  }

  /** The place a click's hit names, or null. */
  function placeOf(hit) {
    if (!hit || !dots || hit.set !== dots.id) return null;
    const id =
      typeof hit.id === 'string' && hit.id.startsWith(PICK_PREFIX)
        ? hit.id.slice(PICK_PREFIX.length)
        : null;
    return id && placeById.has(id) ? id : null;
  }

  function disable() {
    request?.abort();
    request = null;
    nextAskAt = 0;
    selectedId = null;
    signature = null;
    records = new Map();
    places = [];
    placeById.clear();
    lastError = null;
    dots?.clear();
    applyShow();
    state._overlayHost.setEntries(
      RAIL_DISRUPTIONS_OVERLAY_SOURCE_ID,
      [],
      CARD_HOST_OPTIONS,
    );
    state._overlayHost.setVisible(RAIL_DISRUPTIONS_OVERLAY_SOURCE_ID, false);
  }

  /** Show or hide the dots (the chip). */
  function toggle() {
    shown = !shown;
    if (!shown) {
      selectedId = null;
      publishCard();
    } else void refresh();
    applyShow();
    requestRender();
    state._controlsListener?.();
  }

  return {
    createSet,
    refresh,
    placeOf,
    /**
     * A dot's name and place for the Context panel and the assistant, or
     * null for any other id.
     */
    describe(pickId) {
      if (typeof pickId !== 'string' || !pickId.startsWith(PICK_PREFIX))
        return null;
      const place = placeById.get(pickId.slice(PICK_PREFIX.length));
      return place
        ? {
            name: t('Rail disruption · {place}', { place: place.name }),
            latitude: place.lat,
            longitude: place.lon,
          }
        : null;
    },
    toggle,
    disable,
    /** Whether a pick id is one of this layer's dots. */
    owns: (pickedId) =>
      typeof pickedId === 'string' &&
      pickedId.startsWith(PICK_PREFIX) &&
      placeById.has(pickedId.slice(PICK_PREFIX.length)),
    /** Open the card of a place, or close it with null. */
    select(placeId) {
      const next = placeId && placeById.has(placeId) ? placeId : null;
      if (next === selectedId) return;
      selectedId = next;
      publishCard();
      requestRender();
    },
    selectedId: () => selectedId,
    enable() {
      state._overlayHost.setVisible(RAIL_DISRUPTIONS_OVERLAY_SOURCE_ID, true);
      applyShow();
    },
    /** Called when the catalog or the feeds in use change. */
    sync() {
      applyShow();
      void refresh();
    },
    /** The chip, or null while the server does not offer Sweden's trains. */
    chip() {
      if (!available()) return null;
      return {
        id: 'rail-disruptions',
        label: t('DISRUPTIONS'),
        title: shown
          ? t('Hide railway disruptions')
          : t('Show railway disruptions'),
        active: shown,
        busy: false,
        disabled: false,
        state: shown ? 'active' : 'idle',
        onClick: toggle,
      };
    },
    /** The legend row, while there are disruptions to show. */
    legend() {
      if (!available() || !shown || !records.size) return null;
      return {
        label: t('Railway disruptions (Trafikverket)'),
        color: RAIL_DISRUPTION_COLOR,
        count: records.size,
        blurb: t(
          'Red dots are the stations Trafikverket names in its current railway traffic messages (track work, train faults, faults in the infrastructure). Click a dot for what Trafikverket says.',
        ),
      };
    },
    stats: () => ({
      disruptions: records.size,
      places: places.length,
      error: lastError,
    }),
    destroy() {
      disable();
      state._overlayHost.clearSource(RAIL_DISRUPTIONS_OVERLAY_SOURCE_ID);
      dots?.dispose();
      dots = null;
    },
  };
}

/**
 * Trails and outdoor facilities (Sweden): Naturvårdsverket's "Leder och
 * friluftsanordningar" (CC0; Naturvårdsverket welcomes a reference, "Källa:
 * Naturvårdsverket"). Pure parsing, packing and queries shared by the
 * snapshot build (scripts/build-outdoor-trails.mjs), the server route and the
 * layer. No Cesium, no Node built-ins.
 *
 * Only what the protected areas publish is here: the trails and facilities
 * (shelters, cabins, fireplaces, toilets, towers, parking …) inside national
 * parks and nature reserves whose managers have entered them, and the state
 * mountain trails. Much of Sweden's outdoor network is missing. The facility
 * type "Bostad" (a residence) is left out entirely: it is someone's home.
 *
 * Naturvårdsverket names the same fields three ways: the download GeoJSON
 * files (ANORDNING_ID, LEDNAMN, SKYDDATOMRADE …), its WFS (Anordning_ID,
 * Lednamn, Skyddat_område …) and the old shapefiles (ANORD_ID, LNAMN,
 * SKOMRDE …); each is read. Coordinates come in SWEREF 99 TM (EPSG:3006)
 * and are turned to degrees here, whichever axis order or system they are in.
 */

import { clipViewBox, distanceMeters } from '../shelters/records.js';
import { sweref99tmToWgs84 } from '../electionDistricts/records.js';
import {
  decodeLine,
  encodeLine,
  simplifyLine,
} from '../municipalities/records.js';

export { decodeLine, distanceMeters, encodeLine };

/** A view wider than this (degrees) shows nothing: zoom in. */
export const OUTDOOR_MAX_SPAN_DEG = 0.4;
/** Points a trail's lines keep in one answer, in all. */
export const MAX_TRAIL_POINTS = 30_000;
/** Trails one answer carries at most. */
export const MAX_TRAILS = 400;
/** Characters of Naturvårdsverket's description a card shows. */
export const DESCRIPTION_MAX = 180;

/**
 * Legend classes for the some 60 facility types (TYP) and 75 subtypes
 * (UNDERTYP), in legend order, each with the Swedish words that put a
 * facility in it. The subtype is read first, then the type; the first class
 * one of whose words appears wins, the rest are "other" (bastu, lekplats,
 * café, livboj, fyr …). "skydd" alone would catch the 7 000 signs of type
 * "Områdesskyddsinformation", so the shelters are named in full.
 */
export const FACILITY_CLASSES = Object.freeze(
  [
    [
      'shelter',
      '#e53935',
      [
        'vindskydd',
        'rastskydd',
        'väderskydd',
        'stuga',
        'kåta',
        'koja',
        'hydda',
        'övernatt',
        'vandrarhem',
      ],
    ],
    [
      'toilet',
      '#8d6e63',
      ['dass', 'toalett', 'wc', 'latrin', 'avfall', 'sop', 'vatten', 'brunn'],
    ],
    [
      'fire',
      '#ffa000',
      [
        'eld',
        'grill',
        'vedförv',
        'vedbod',
        'tält',
        'läger',
        'rastplats',
        'picknick',
        'bänk',
        'bord',
        'sittplats',
      ],
    ],
    [
      'view',
      '#ec407a',
      [
        'utsikt',
        'torn',
        'observation',
        'gömsle',
        'information',
        'skylt',
        'tavla',
        'naturum',
        'besökscent',
        'entré',
        'karta',
      ],
    ],
    [
      'access',
      '#1e88e5',
      [
        'parkering',
        'p-plats',
        'hållplats',
        'brygga',
        'båt',
        'kanot',
        'kajak',
        'iläggning',
        'bad',
        'hamn',
        'ankring',
        'ramp',
        'helikopter',
      ],
    ],
    [
      'structure',
      '#cfd8dc',
      [
        // A bridge ("Bro", "Hängbro"), not "Broshyrer".
        /bro(?![a-zåäö])/,
        'spång',
        'trappa',
        'stätta',
        'grind',
        'stängsel',
        'färist',
        'räcke',
        'bom',
        'vadställe',
      ],
    ],
    ['other', '#78909c', []],
  ].map(([id, color, words]) => Object.freeze({ id, color, words })),
);
export const FACILITY_CLASS = Object.freeze(
  Object.fromEntries(FACILITY_CLASSES.map((entry) => [entry.id, entry])),
);

/**
 * Legend classes for the trail types (LEDTYP, often several: "Skidled,
 * Skoterled"), the same way: a route snowmobiles may use is a snowmobile
 * trail, one with a ski trail a ski trail, and so on down.
 */
export const TRAIL_CLASSES = Object.freeze(
  [
    ['snowmobile', '#7e57c2', ['skoter']],
    ['ski', '#e1f5fe', ['skid', 'längdspår', 'vinterled']],
    ['paddle', '#26c6da', ['kanot', 'paddel', 'kajak', 'båt', 'snorkel']],
    ['cycleRide', '#fdd835', ['cykel', 'mtb', 'mountainbike', 'rid']],
    ['nature', '#9ccc65', ['natur', 'kultur', 'studie', 'upplevelse']],
    [
      'hike',
      '#ff7043',
      ['vandr', 'fjäll', 'promenad', 'motion', 'elljus', 'led', 'stig'],
    ],
    ['other', '#b0bec5', []],
  ].map(([id, color, words]) => Object.freeze({ id, color, words })),
);
export const TRAIL_CLASS = Object.freeze(
  Object.fromEntries(TRAIL_CLASSES.map((entry) => [entry.id, entry])),
);

const text = (value, max) => {
  if (value === null || value === undefined) return null;
  const s = String(value).replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

/** The first of several names a field goes by that is present. */
const pick = (props, ...names) => {
  for (const name of names)
    if (props[name] !== undefined && props[name] !== null) return props[name];
  return null;
};

/** The first class one of whose words appears in the texts, else "other". */
function classOf(classes, ...texts) {
  for (const value of texts) {
    const lower = String(value ?? '').toLowerCase();
    if (!lower) continue;
    const found = classes.find(({ words }) =>
      words.some((word) =>
        typeof word === 'string' ? lower.includes(word) : word.test(lower),
      ),
    );
    if (found) return found.id;
  }
  return 'other';
}

export const facilityClass = (type, subtype) =>
  classOf(FACILITY_CLASSES, subtype, type);
export const trailClass = (type, category) =>
  classOf(TRAIL_CLASSES, type, category);

/** A residence: never shown. */
export const isResidence = (type, subtype) =>
  /bostad/i.test(`${type ?? ''} ${subtype ?? ''}`);

const ACCESSIBLE_RE = /rörelsehindr|tillgänglig|handikapp|rullstol/i;

/**
 * Whether a facility or trail lies on a state trail: the field is the state
 * trail's name in the GeoJSON ("Abisko - Abiskojaure (BD 21)"), a yes/no
 * elsewhere.
 */
const onStateTrail = (value) => {
  const s = text(value, 120);
  return Boolean(s) && !/^(nej|n|no|0|false|falskt)$/i.test(s);
};

/** A description cut at a word near DESCRIPTION_MAX, with an ellipsis. */
export function shorten(value, max = DESCRIPTION_MAX) {
  const s = text(value, 4000);
  if (!s || s.length <= max) return s;
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:–-]+$/, '')}…`;
}

const EMAIL_RE = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/;
/**
 * A Swedish phone number: +46 or a leading 0, then digits in groups split by
 * spaces or dashes ("070-1234567", "08-123 45 67", "010 - 225 15 53",
 * "+46 70 123 45 67"). Seven digits or more, so "kl 08-16" is no number.
 */
const PHONE_RE = /(?:\+46|\b0)[\d\s–-]{6,}\d/g;
const isPhone = (match) => match.replace(/\D/g, '').length >= 7;
/** "Kontakta Anna Jansson", "kontaktperson Per": a person to call. */
const CONTACT_PERSON_RE =
  /[Kk]ontaktperson|[Kk]ontakta\s+[A-ZÅÄÖ][a-zåäöéü]+\s+[A-ZÅÄÖ][a-zåäöéü]+/;

/** Whether a sentence holds an e-mail address, a phone number or a person. */
const holdsContact = (sentence) =>
  EMAIL_RE.test(sentence) ||
  (sentence.match(PHONE_RE) ?? []).some(isPhone) ||
  CONTACT_PERSON_RE.test(sentence);

/**
 * A description without the sentences that give contact details: an e-mail
 * address, a phone number or a named contact person ("Kontakta Anna Jansson
 * (010-…, anna.jansson@…) för frågor."). Managers wrote these for visitors on
 * a sign, not for a map; "Kontakta Länsstyrelsen för exakta datum" stays.
 * Null when nothing is left.
 */
export function withoutContacts(value) {
  const s = text(value, 4000);
  if (!s) return null;
  const kept = s
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !holdsContact(sentence));
  return text(kept.join(' '), 4000);
}

const inSweden = (lon, lat) =>
  lon >= 9 && lon <= 25.5 && lat >= 54 && lat <= 70;
const round5 = (value) => Math.round(value * 1e5) / 1e5;

/**
 * A coordinate pair as [lon, lat], or null: SWEREF 99 TM in either axis
 * order (the northing is the one above five million), or degrees in either.
 */
export function toLonLat(pair) {
  const x = Number(pair?.[0]);
  const y = Number(pair?.[1]);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  let lonLat;
  if (Math.abs(x) <= 180 && Math.abs(y) <= 90)
    lonLat = inSweden(x, y) ? [x, y] : [y, x];
  else lonLat = sweref99tmToWgs84(y > x ? [x, y] : [y, x]);
  const [lon, lat] = lonLat;
  return inSweden(lon, lat) ? [round5(lon), round5(lat)] : null;
}

/** A GeoJSON line's points in degrees, consecutive repeats dropped. */
function lineOf(coordinates) {
  const out = [];
  for (const pair of Array.isArray(coordinates) ? coordinates : []) {
    const point = toLonLat(pair);
    if (!point) continue;
    const last = out.at(-1);
    if (!last || last[0] !== point[0] || last[1] !== point[1]) out.push(point);
  }
  return out;
}

/** A trail geometry's lines, each two points or more. */
export function linesOf(geometry) {
  const c = geometry?.coordinates;
  const raw =
    geometry?.type === 'LineString'
      ? [c]
      : geometry?.type === 'MultiLineString'
        ? Array.isArray(c)
          ? c
          : []
        : [];
  return raw.map(lineOf).filter((line) => line.length >= 2);
}

/** A facility geometry's point: the point, or a MultiPoint's first. */
function pointOf(geometry) {
  const c = geometry?.coordinates;
  if (geometry?.type === 'Point') return toLonLat(c);
  if (geometry?.type === 'MultiPoint' && Array.isArray(c))
    return toLonLat(c[0]);
  return null;
}

const safeId = (value) =>
  String(value ?? '')
    .replace(/[^0-9A-Za-z_-]/g, '')
    .slice(0, 40);

/** The lines' length in kilometres, to one decimal. */
export function lengthKm(lines) {
  let metres = 0;
  for (const line of lines)
    for (let i = 1; i < line.length; i++)
      metres += distanceMeters(line[i - 1], line[i]);
  return Math.round(metres / 100) / 10;
}

/**
 * A stated length without a unit (the old LLANGD) in kilometres: read as
 * kilometres or metres, whichever lies nearer the length of the drawn lines;
 * without lines, a number of 1 000 or more is metres.
 */
export function statedLengthKm(value, drawnKm = null) {
  const n = Number(String(value ?? '').replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return null;
  let km = n >= 1000 ? n / 1000 : n;
  if (n < 1000 && Number.isFinite(drawnKm) && drawnKm > 0) {
    const off = (candidate) => Math.abs(Math.log(candidate / drawnKm));
    km = off(n / 1000) < off(n) ? n / 1000 : n;
  }
  return Math.round(km * 10) / 10;
}

/** A length in metres (LEDLANGD, Längd_på_led_m) in kilometres, or null. */
const metresToKm = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n / 100) / 10 : null;
};

/**
 * "Kolartorp (2026369)" as "Kolartorp": the register numbers (and Natura
 * 2000 codes, "SE0430092") are noise. Several areas, "Hallands Väderö
 * (2000962), Hallands Väderö (SE0420…)", are named once each.
 */
export function areaName(value) {
  const names = String(value ?? '')
    .replace(/\s*\((?:SE)?\d+\)?/g, '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  return text([...new Set(names)].join(', '), 80);
}

/**
 * One facility, or null: a residence, or no place in Sweden.
 * @param {object} feature A GeoJSON feature of Anordningar.
 */
export function normalizeFacility(feature) {
  const p = feature?.properties || {};
  const type = text(pick(p, 'TYP', 'Typ'), 60);
  const rawSubtype = text(pick(p, 'UNDERTYP', 'Undertyp'), 60);
  // "Okänd" (unknown) says nothing the type does not.
  const subtype = /^okänd$/i.test(rawSubtype ?? '') ? null : rawSubtype;
  if (isResidence(type, subtype)) return null;
  const point = pointOf(feature?.geometry);
  if (!point) return null;
  const name = text(
    pick(p, 'ANORDNINGNAMN', 'Anordningsnamn', 'ANORDNINGSNAMN', 'ANORD_NAMN'),
    80,
  );
  return {
    id:
      safeId(pick(p, 'ANORDNING_ID', 'Anordning_ID', 'ANORD_ID')) ||
      `p${point.join('_').replace(/\./g, '')}`,
    point,
    name,
    type,
    subtype,
    kind: facilityClass(type, subtype),
    accessible: ACCESSIBLE_RE.test(`${type} ${subtype} ${name ?? ''}`),
    description: shorten(
      withoutContacts(pick(p, 'BESKRIVNING', 'Beskrivning', 'BESKRIVN')),
    ),
    area: areaName(pick(p, 'SKYDDATOMRADE', 'Skyddat_område', 'SKOMRDE')),
    stateTrail: onStateTrail(pick(p, 'STATLIGLED', 'Statlig_led', 'STATLED')),
  };
}

/**
 * One trail segment with its lines, or null without any. Naturvårdsverket
 * cuts a trail into segments, each a feature with the trail's id and
 * fields; normalizeTrails puts them together.
 * @param {object} feature A GeoJSON feature of Leder (or STATLIG_LED).
 * @param {{state?: boolean}} [options] `state` for STATLIG_LED.
 */
export function normalizeTrail(feature, { state = false } = {}) {
  const p = feature?.properties || {};
  const lines = linesOf(feature?.geometry);
  if (!lines.length) return null;
  const type = text(pick(p, 'LEDTYP', 'Typ_av_led', 'LTYP'), 60);
  const category = text(pick(p, 'LEDKATEGORI', 'Ledkategori', 'LKATEGORI'), 60);
  const id = safeId(pick(p, 'LED_ID', 'Led_ID', 'L_ID'));
  // A state trail's own name, "Abisko - Abiskojaure (BD 21)", where the
  // segment has none.
  const stateName = pick(p, 'STATLIGLEDNAMN', 'STATLIGLED', 'Statlig_led');
  const stateTrail =
    state || onStateTrail(pick(p, 'STATLIGLED', 'Statlig_led', 'STATLED'));
  const statedMetres = metresToKm(pick(p, 'LEDLANGD', 'Längd_på_led_m'));
  return {
    id: `${state ? 's' : 'l'}${id || `${lines[0][0].join('_').replace(/\./g, '')}`}`,
    sourceId: id || null,
    name:
      text(pick(p, 'LEDNAMN', 'Lednamn', 'LNAMN'), 80) ??
      (stateTrail && !/^(ja|j|1|true)$/i.test(String(stateName ?? ''))
        ? text(stateName, 80)
        : null),
    type,
    category,
    kind: trailClass(type, category),
    marking: text(pick(p, 'LEDMARKERING', 'Ledmarkering', 'LMARKERING'), 60),
    description: shorten(
      withoutContacts(pick(p, 'BESKRIVNING', 'Beskrivning', 'BESKRIVN')),
    ),
    area: areaName(pick(p, 'SKYDDATOMRADE', 'Skyddat_område', 'SKOMRDE')),
    stateTrail,
    lengthKm:
      statedMetres ??
      statedLengthKm(p.LLANGD, lengthKm(lines)) ??
      lengthKm(lines),
    lines,
  };
}

/** Every facility in a collection, without duplicates. */
export function normalizeFacilities(features) {
  if (!Array.isArray(features))
    throw new Error('Malformed facilities collection');
  const seen = new Set();
  return features
    .map(normalizeFacility)
    .filter((row) => row && !seen.has(row.id) && seen.add(row.id));
}

/**
 * The trails of Leder with their segments put together, one trail per id:
 * its lines are all its segments' lines, its other fields the first
 * segment's that has them. Features of STATLIG_LED, if given, are added the
 * same way unless Leder already holds the trail (the same id and name):
 * the downloaded Leder file holds every state trail segment itself.
 */
export function normalizeTrails(ledFeatures = [], stateFeatures = []) {
  const byId = new Map();
  const add = (row) => {
    const held = byId.get(row.id);
    if (!held) return byId.set(row.id, row);
    held.lines.push(...row.lines);
    for (const key of ['name', 'type', 'category', 'marking', 'description'])
      held[key] ??= row[key];
    held.area ??= row.area;
    held.stateTrail ||= row.stateTrail;
  };
  for (const row of ledFeatures.map((f) => normalizeTrail(f)))
    if (row) add(row);
  for (const row of stateFeatures.map((f) =>
    normalizeTrail(f, { state: true }),
  )) {
    if (!row) continue;
    const twin = row.sourceId ? byId.get(`l${row.sourceId}`) : null;
    if (twin && twin.name === row.name) {
      twin.stateTrail = true;
      continue;
    }
    add(row);
  }
  return [...byId.values()];
}

const samePoint = (a, b) => a[0] === b[0] && a[1] === b[1];

/**
 * Segments that meet end to start (either way round) joined into longer
 * lines, so a trail cut into a hundred segments draws as a few lines.
 */
export function joinLines(lines) {
  const left = lines.map((line) => line.slice());
  const out = [];
  while (left.length) {
    let line = left.shift();
    for (let grown = true; grown;) {
      grown = false;
      for (let i = 0; i < left.length; i++) {
        const other = left[i];
        let next = null;
        if (samePoint(line.at(-1), other[0]))
          next = [...line, ...other.slice(1)];
        else if (samePoint(line.at(-1), other.at(-1)))
          next = [...line, ...other.slice(0, -1).reverse()];
        else if (samePoint(line[0], other.at(-1)))
          next = [...other, ...line.slice(1)];
        else if (samePoint(line[0], other[0]))
          next = [...other.slice().reverse(), ...line.slice(1)];
        if (next) {
          line = next;
          left.splice(i, 1);
          grown = true;
          break;
        }
      }
    }
    out.push(line);
  }
  return out;
}

/** The box [west, south, east, north] around lines, at 1e-5 degrees. */
export function linesBounds(lines) {
  let [w, s, e, n] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const line of lines)
    for (const [lon, lat] of line) {
      if (lon < w) w = lon;
      if (lon > e) e = lon;
      if (lat < s) s = lat;
      if (lat > n) n = lat;
    }
  return [w, s, e, n].map(round5);
}

/** Keep only fields that say something: no nulls, no false. */
const compact = (entries) =>
  Object.fromEntries(
    entries.filter(
      ([, value]) => value !== null && value !== undefined && value !== false,
    ),
  );

/** A facility as the snapshot keeps it: short keys, empty fields left out. */
export const packFacility = (row) =>
  compact([
    ['i', row.id],
    ['p', row.point],
    ['n', row.name],
    ['t', row.type],
    ['u', row.subtype],
    ['k', row.kind],
    ['x', row.accessible ? 1 : null],
    ['d', row.description],
    ['a', row.area],
    ['s', row.stateTrail ? 1 : null],
  ]);

/** A snapshot facility as the row the route and the layer read. */
export const unpackFacility = (c) => ({
  id: String(c.i),
  point: c.p,
  name: c.n ?? null,
  type: c.t ?? null,
  subtype: c.u ?? null,
  kind: FACILITY_CLASS[c.k] ? c.k : 'other',
  accessible: c.x === 1,
  description: c.d ?? null,
  area: c.a ?? null,
  stateTrail: c.s === 1,
});

/**
 * A trail as the snapshot keeps it: its fields, its box and its lines
 * (already joined, simplified and delta-encoded by the build).
 */
export const packTrail = (row, encodedLines, bounds) =>
  compact([
    ['i', row.id],
    ['n', row.name],
    ['t', row.type],
    ['c', row.category],
    ['k', row.kind],
    ['m', row.marking],
    ['d', row.description],
    ['a', row.area],
    ['s', row.stateTrail ? 1 : null],
    ['l', row.lengthKm],
    ['b', bounds],
    ['g', encodedLines],
  ]);

/** A snapshot trail's fields, without its lines (decoded on demand). */
export const unpackTrail = (c) => ({
  id: String(c.i),
  name: c.n ?? null,
  type: c.t ?? null,
  category: c.c ?? null,
  kind: TRAIL_CLASS[c.k] ? c.k : 'other',
  marking: c.m ?? null,
  description: c.d ?? null,
  area: c.a ?? null,
  stateTrail: c.s === 1,
  lengthKm: Number.isFinite(c.l) ? c.l : null,
});

/** The view box cut to OUTDOOR_MAX_SPAN_DEG a side about the centre. */
export const clipOutdoorBox = (bbox, center) =>
  clipViewBox(bbox, center, OUTDOOR_MAX_SPAN_DEG);

const inside = ([lon, lat], [west, south, east, north]) =>
  lon >= west && lon <= east && lat >= south && lat <= north;

/** Whether two boxes [west, south, east, north] overlap. */
export const boxesMeet = (a, b) =>
  a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

/** A view box widened by a quarter on each side: where trails are cut. */
export function widenedBox([west, south, east, north]) {
  const padX = (east - west) / 4;
  const padY = (north - south) / 4;
  return [west - padX, south - padY, east + padX, north + padY];
}

/**
 * The parts of a line near a box: runs of points inside it, each with the
 * point before and after, so a line leaving the box still reaches its edge.
 */
export function clipLine(line, box) {
  const runs = [];
  let run = null;
  for (let i = 0; i < line.length; i++) {
    const inBox = inside(line[i], box);
    const nextIn = i + 1 < line.length && inside(line[i + 1], box);
    if (inBox || nextIn || (run && i > 0 && inside(line[i - 1], box))) {
      run ??= [];
      run.push(line[i]);
    }
    if (!inBox && !nextIn && run) {
      if (run.length >= 2) runs.push(run);
      run = null;
    }
  }
  if (run && run.length >= 2) runs.push(run);
  return runs;
}

/**
 * The facilities and trails in a view, as one answer: how many of each, the
 * nearest `limit` facilities to the centre, and the trails touching the box,
 * nearest first, their lines cut to the box (widened by a quarter), thinned
 * for the view's size and delta-encoded. Each trail has an `anchor`, its
 * point nearest the centre, for its card.
 * @param {{facilities: object[], trails: object[]}} rows Rows, the trails
 *   with their `lines` decoded.
 * @param {{bbox: number[], center: number[], limit?: number}} query
 */
export function outdoorInView(
  { facilities = [], trails = [] },
  { bbox, center, limit = 1500 },
) {
  const [, south, , north] = bbox;
  const inBox = facilities.filter(({ point }) => inside(point, bbox));
  const shownFacilities = inBox
    .map((row) => ({
      ...row,
      distance: Math.round(distanceMeters(center, row.point)),
    }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, Math.max(0, limit));
  const wide = widenedBox(bbox);
  // The view's height in metres, over 1 500: a point's worth on a screen.
  const tolerance = Math.min(
    60,
    Math.max(3, ((north - south) * 111_000) / 1500),
  );
  const near = [];
  for (const trail of trails) {
    const parts = trail.lines.flatMap((line) => clipLine(line, wide));
    if (!parts.some((part) => part.some((point) => inside(point, bbox))))
      continue;
    const lines = parts
      .map((part) => simplifyLine(part, tolerance))
      .filter((part) => part.length >= 2);
    let anchor = lines[0][0];
    let best = Infinity;
    for (const line of lines)
      for (const point of line) {
        const d = distanceMeters(center, point);
        if (d < best) [best, anchor] = [d, point];
      }
    near.push({ trail, lines, anchor, distance: Math.round(best) });
  }
  near.sort((a, b) => a.distance - b.distance);
  const shownTrails = [];
  let points = 0;
  let capped = false;
  for (const { trail, lines, anchor, distance } of near) {
    const count = lines.reduce((sum, line) => sum + line.length, 0);
    if (shownTrails.length >= MAX_TRAILS || points + count > MAX_TRAIL_POINTS) {
      capped = true;
      break;
    }
    points += count;
    shownTrails.push({
      id: trail.id,
      name: trail.name,
      type: trail.type,
      category: trail.category,
      kind: trail.kind,
      marking: trail.marking,
      description: trail.description,
      area: trail.area,
      stateTrail: trail.stateTrail,
      lengthKm: trail.lengthKm,
      anchor,
      distance,
      lines: lines.map(encodeLine),
    });
  }
  return {
    facilityTotal: inBox.length,
    trailTotal: near.length,
    facilities: shownFacilities,
    trails: shownTrails,
    trailsCapped: capped,
  };
}

/**
 * Wind turbines (Sweden): Länsstyrelserna's Vindbrukskollen, the county
 * boards' register of wind turbines built, planned, refused, withdrawn and
 * taken down (CC0 1.0; "Ange Länsstyrelsen som källa"). Pure parsing,
 * packing and queries shared by the snapshot build
 * (scripts/build-wind-turbines.mjs), the server route and the layer. No
 * Cesium, no Node built-ins, no i18n.
 *
 * Kept per turbine: its id, place (WGS 84, 6 decimals), status, total and
 * hub height, rotor diameter, rated power (MW), calculated production
 * (GWh/year), make and model, the year it was built (only for built and
 * dismantled turbines, and none when the register says 1900-01-01, its
 * "unknown"), project name, municipality, county, bidding zone and the
 * register's last update. Never kept: the organisation number, the siting
 * (land or water), the kind of permit case, the permit's time limit, case
 * numbers.
 *
 * The operator's name is kept only when it is plainly a company's: its
 * organisation number a legal person's (third digit 2 or more; a sole
 * trader's number is a personal identity number), not a trading or limited
 * partnership's (first digit 9: handelsbolag and kommanditbolag are often
 * named after their partners), not the register's placeholder ("Projektör
 * ej registrerad", 999999-9999), not a farm's or a property's, and holding no person's
 * name. When unsure, the name is dropped.
 *
 * A project name is left out when it reads as a person's full name (a first
 * name and a surname or an initial: a few owners named a turbine after
 * themselves), holds a long number (a metering-point id) or a property
 * designation ("Hagby 1:2"); the card then names the municipality. A first
 * name alone, as some turbines are named ("Maria"), stays.
 */

import { clipViewBox, distanceMeters } from '../shelters/records.js';
import { sweref99tmToWgs84 } from '../electionDistricts/records.js';

/** Turbines show below this camera height; above it, a hint to zoom in. */
export const WIND_MAX_HEIGHT_M = 250_000;
/** A view wider than this (degrees) is cut to it about the centre. */
export const WIND_MAX_SPAN_DEG = 4;
/** The nearest this many turbines to the centre are drawn. */
export const WIND_SHOWN = 1500;

/**
 * The register's statuses, as Vindbrukskollen writes them, in the order the
 * layer numbers them, each with the legend kind it is drawn as.
 */
export const TURBINE_STATUSES = Object.freeze(
  [
    ['Uppfört', 'built'],
    ['Beviljat', 'planned'],
    ['Handläggs', 'planned'],
    ['Överklagat', 'planned'],
    ['Avslag', 'rejected'],
    ['Inte aktuellt eller återkallat', 'withdrawn'],
    ['Nedmonterat', 'dismantled'],
    ['Uppgift saknas', 'unknown'],
  ].map(([status, kind]) => Object.freeze({ status, kind })),
);
/** The plural forms the register's documentation uses, to the same codes. */
const STATUS_ALIASES = Object.freeze({
  uppförda: 'Uppfört',
  beviljade: 'Beviljat',
  överklagade: 'Överklagat',
  avslagna: 'Avslag',
  avslagen: 'Avslag',
  nedmonterade: 'Nedmonterat',
  'inte aktuella eller återkallade': 'Inte aktuellt eller återkallat',
});
const UNKNOWN_STATUS = TURBINE_STATUSES.findIndex(
  (entry) => entry.kind === 'unknown',
);

/** The legend kinds, in legend order, with their colour. */
export const TURBINE_KINDS = Object.freeze(
  [
    ['built', '#4dd0e1'],
    ['planned', '#ffd54f'],
    ['dismantled', '#a1887f'],
    ['rejected', '#b39ddb'],
    ['withdrawn', '#90a4ae'],
    ['unknown', '#e0e0e0'],
  ].map(([id, color]) => Object.freeze({ id, color })),
);
export const TURBINE_KIND = Object.freeze(
  Object.fromEntries(TURBINE_KINDS.map((entry) => [entry.id, entry])),
);
/**
 * The kinds behind each chip; built turbines are always shown. "Uppgift
 * saknas" (no status given) goes with the cases no longer current.
 */
const TURBINE_GROUPS = Object.freeze({
  planned: Object.freeze(['planned']),
  dismantled: Object.freeze(['dismantled']),
  rejected: Object.freeze(['rejected']),
  notCurrent: Object.freeze(['withdrawn', 'unknown']),
});
/** The kinds a fresh layer shows: what stands. */
export const DEFAULT_TURBINE_KINDS = Object.freeze(['built']);
/** The kinds whose build year means something. */
const STOOD = new Set(['built', 'dismantled']);

/** A status text's number, or -1 when the register is not known to use it. */
export function statusIndex(value) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const name = (STATUS_ALIASES[text.toLowerCase()] ?? text).toLowerCase();
  return TURBINE_STATUSES.findIndex(
    (entry) => entry.status.toLowerCase() === name,
  );
}

/** A status text's number, the "no status" number when unknown. */
export function statusCode(value) {
  const at = statusIndex(value);
  return at >= 0 ? at : UNKNOWN_STATUS;
}

/** The digits of an organisation number, without a "16" century prefix. */
const orgDigits = (value) => {
  const digits = String(value ?? '').replace(/[\s-]/g, '');
  return /^16\d{10}$/.test(digits) ? digits.slice(2) : digits;
};

/**
 * Whether an organisation number belongs to a legal person: ten digits
 * whose third digit is 2 or more. A personal identity number has its month
 * there (0 or 1); a masked one ("550101-xxxx"), a short or foreign one
 * cannot be told apart, so it counts as not.
 */
export function isLegalPersonNumber(value) {
  const digits = orgDigits(value);
  return /^\d{10}$/.test(digits) && Number(digits[2]) >= 2;
}

/** Common Swedish first names, for the person-name checks below. */
const FIRST_NAMES = new Set(
  (
    'Albin Alf Anders Andreas Anna Anette Annika Arne Arvid Axel Bengt ' +
    'Bernt Bertil Birger Birgitta Björn Bo Börje Carl Christer Christian ' +
    'Christina Claes Conny Curt Dag Daniel Einar Elin Elof Emil Emma Erik ' +
    'Erland Evert Eva Folke Fredrik Gert Gun Gunilla Gunnar Gustaf Gustav ' +
    'Göran Gösta Göte Hans Harald Helena Helge Henrik Hugo Håkan Inga ' +
    'Ingemar Ingrid Ingvar Ivar Jakob Jan Jens Jesper Joakim Johan Johanna ' +
    'Jonas Jonny Josef Jörgen Karin Karl Kent Kerstin Kjell Klas Knut ' +
    'Kristina Kurt Lage Lars Leif Lena Lennart Linda Lisa Ludvig Magnus ' +
    'Marcus Margareta Maria Marie Markus Martin Mats Mattias Mikael Monica ' +
    'Niklas Nils Ola Olle Olof Olov Oskar Ove Patrik Per Peter Pia Rasmus ' +
    'Robert Roger Roland Rolf Ronny Rune Sara Sigvard Simon Sixten Stefan ' +
    'Sten Stig Sture Sune Sven Tage Thomas Tomas Tommy Torbjörn Torsten Ture ' +
    'Ulf Ulla Urban Valter Viktor Vilhelm Yngve Åke Åsa Örjan'
  ).split(' '),
);
/**
 * Words after a first name that make it a turbine's or a place's name, not
 * a person's: "Sven Vind", "Per V" (a Roman numeral), "Bo Norra".
 */
const NAME_WORDS =
  /^(vind\w*|verk\w*|kraft\w*|park|gård\w*|projekt\w*|etapp|\d+|[ivx]+|norra|södra|östra|västra|övre|nedre|stora|lilla|mellersta)$/i;
/** Historical figures some turbines are named after. */
const NOT_PERSONS = /\b(Birger Jarl|Magnus Ladulås)\b/i;

const titleCase = (word) =>
  word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

/**
 * Whether a name reads as a person's full name: a common first name
 * (in any case: "PER PERSSON") followed by a capitalised word or an initial
 * ("Per Persson …", "Per P"), not by a word such as "Vind" or a Roman
 * numeral. `strict` (operator names) counts any capitalised word after a
 * first name, those words too.
 */
export function looksLikePersonName(value, { strict = false } = {}) {
  const text = String(value ?? '');
  if (!strict && NOT_PERSONS.test(text)) return false;
  const words = text.split(/[\s,;:/()&+–-]+/).filter(Boolean);
  for (let i = 0; i + 1 < words.length; i++) {
    const word = words[i];
    if (!/^\p{Lu}/u.test(word) || !FIRST_NAMES.has(titleCase(word))) continue;
    // "Magnus o Thomas …": the name after the "o" is read in its turn.
    const next = words[i + 1];
    if (!/^\p{Lu}/u.test(next)) continue;
    if (strict || !NAME_WORDS.test(next)) return true;
  }
  return false;
}

/**
 * A project name the card may show, or null: none that reads as a person's
 * name, holds a run of eight digits or more (a metering-point id) or a
 * property designation ("Hagby 1:2").
 */
export function projectName(value) {
  const name = text(value);
  if (!name) return null;
  if (/\d{8,}/.test(name) || /\b\d+:\d+\b/.test(name)) return null;
  return looksLikePersonName(name) ? null : name;
}

/** The register's stand-ins for an unknown or private operator. */
const PLACEHOLDER_RE =
  /ej registrerad|inte registrerad|okänd|uppgift saknas|privatperson|^[\s.-]*$/i;
/** Partnerships and farms, often named after the family that runs them. */
const PARTNERSHIP_RE =
  /\b(h\.?b|k\.?b|handelsbolag\w*|kommanditbolag\w*|enskild firma)\b/i;
const FARM_RE =
  /(^|[\s,(])(gård|gården|säteri|jordbruk\w*|lantbruk\w*|naturbruk\w*|skogsbruk\w*)($|[\s,.)])/i;

/**
 * The operator's name the card may show, or null: a company's only (see
 * the module comment). When unsure, null.
 */
export function operatorName(name, number) {
  const clean = text(name, 80);
  if (!clean || !isLegalPersonNumber(number)) return null;
  if (orgDigits(number).startsWith('9')) return null;
  if (PLACEHOLDER_RE.test(clean) || PARTNERSHIP_RE.test(clean)) return null;
  // A farm, or a company named after a property ("Exempelby 1:42 AB").
  if (FARM_RE.test(clean) || /\b\d+:\d+\b/.test(clean)) return null;
  return looksLikePersonName(clean, { strict: true }) ? null : clean;
}

/** The register's dates (yyyymmdd) as yyyy-mm-dd; 1900-01-01 is none. */
export function registerDate(value) {
  const raw = String(value ?? '').trim();
  const match = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(raw);
  if (!match) return null;
  const [, year, month, day] = match;
  if (Number(year) <= 1900 || Number(month) < 1 || Number(month) > 12)
    return null;
  if (Number(day) < 1 || Number(day) > 31) return null;
  return `${year}-${month}-${day}`;
}

/** Vindbrukskollen's bidding-zone names to the zones' codes. */
const ZONES = Object.freeze({
  luleå: 'SE1',
  sundsvall: 'SE2',
  stockholm: 'SE3',
  malmö: 'SE4',
});
export const biddingZone = (value) => {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase();
  return ZONES[raw] ?? (/^se[1-4]$/.test(raw) ? raw.toUpperCase() : null);
};

function text(value, max = 80) {
  const clean = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return clean ? clean.slice(0, max) : null;
}
/** A measure in (0, max], rounded to `digits`; 0 and blanks are unknown. */
const measure = (value, max, digits = 0) => {
  const number = Number(value);
  if (value === null || value === '' || !Number.isFinite(number)) return null;
  if (number <= 0 || number > max) return null;
  const scale = 10 ** digits;
  return Math.round(number * scale) / scale;
};
const round6 = (value) => Math.round(value * 1e6) / 1e6;
const inSweden = (lon, lat) => lon > 9 && lon < 25 && lat > 54.5 && lat < 69.5;
const safeId = (value) =>
  String(value ?? '')
    .replace(/[^\w-]/g, '')
    .slice(0, 32);

/**
 * A SWEREF 99 TM point as [lon, lat] in Sweden, or null: the register gives
 * 0, 0 to thousands of planned turbines that were never sited.
 */
export function placeOf(xy) {
  if (!Array.isArray(xy)) return null;
  const [x, y] = xy.map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 1e5 || y < 6e6)
    return null;
  const [lon, lat] = sweref99tmToWgs84([x, y]);
  return inSweden(lon, lat) ? [round6(lon), round6(lat)] : null;
}

/** A register row's fields as kept, without its place; null without an id. */
function turbineFields(props) {
  const id = safeId(props?.VERKID);
  if (!id) return null;
  const pick = (...names) => {
    for (const name of names) if (props[name] !== undefined) return props[name];
    return null;
  };
  const status = statusCode(props.STATUS);
  const kind = TURBINE_STATUSES[status].kind;
  return {
    id,
    status,
    kind,
    totalHeightM: measure(props.TOTALHOJD, 400),
    hubHeightM: measure(props.NAVHOJD, 300),
    rotorM: measure(pick('ROTDIAMETER', 'ROTDIAMETE'), 300),
    powerMW: measure(props.MAXEFFEKT, 30, 3),
    productionGWh: measure(props.CALPROD, 1000, 2),
    make: text(props.FABRIKAT, 40),
    model: text(props.MODELL, 40),
    // A planned or withdrawn turbine's date is not a build year.
    built: STOOD.has(kind) ? registerDate(props.UPPFORT) : null,
    project: projectName(props.PROJNAMN),
    municipality: text(props.KOMNAMN, 40),
    county: text(props.LANSNAMN, 40),
    zone: biddingZone(props.EL_NAMN),
    updated: registerDate(pick('SenasteUppdatering', 'SenasteUpp')),
    operator: operatorName(props.ORGNAMN, pick('ORGNMR')),
  };
}

/**
 * One turbine from a register row and its SWEREF 99 TM point, or null when
 * it has no id or no place in Sweden.
 * @param {object} props The .dbf row (field names as the shapefile cuts
 *   them, or in full).
 * @param {number[]|null} xy [easting, northing].
 */
export function normalizeTurbine(props, xy) {
  const point = placeOf(xy);
  const fields = point ? turbineFields(props) : null;
  return fields ? { ...fields, point } : null;
}

/**
 * Every turbine of the register, once each. A turbine listed more than once
 * keeps its most recently updated row (the first of equals), compared
 * before places are looked at: when that row has no place, the turbine
 * keeps its newest status at the place its latest placed row gives; with no
 * place at all it is left out.
 * @param {object[]} records The .dbf rows.
 * @param {(number[]|null)[]} points Their SWEREF 99 TM points, in step.
 */
export function normalizeTurbines(records, points) {
  if (!Array.isArray(records) || !Array.isArray(points))
    throw new Error('Malformed turbine register');
  /** id → {fields, point, at} of the newest row, and of the newest placed. */
  const newest = new Map();
  const placed = new Map();
  records.forEach((props, index) => {
    if (!props) return;
    const fields = turbineFields(props);
    if (!fields) return;
    const updated = fields.updated ?? '';
    const point = placeOf(points[index]);
    const before = newest.get(fields.id);
    if (!before || updated > (before.fields.updated ?? ''))
      newest.set(fields.id, { fields, point });
    const lastPlace = placed.get(fields.id);
    if (point && (!lastPlace || updated > lastPlace.updated))
      placed.set(fields.id, { point, updated });
  });
  const rows = [];
  for (const [id, { fields, point }] of newest) {
    const at = point ?? placed.get(id)?.point;
    if (at) rows.push({ ...fields, point: at });
  }
  return rows;
}

/** yyyy-mm-dd as the integer yyyymmdd, or 0. */
const dateNumber = (date) => (date ? Number(date.replace(/-/g, '')) : 0);
const numberDate = (value) => {
  const raw = String(value ?? '');
  return /^\d{8}$/.test(raw)
    ? `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`
    : null;
};

/**
 * The fields of a packed row, in order. Text fields are indexes into the
 * snapshot's string table (0 for none); numbers and dates (yyyymmdd) are 0
 * for none: no turbine has a height, power or date of 0. The status is an
 * index into the snapshot's own `statuses`.
 */
export const PACKED_FIELDS = Object.freeze([
  'id',
  'lon',
  'lat',
  'status',
  'totalHeightM',
  'hubHeightM',
  'rotorM',
  'powerMW',
  'productionGWh',
  'make',
  'model',
  'built',
  'project',
  'municipality',
  'county',
  'zone',
  'updated',
  'operator',
]);
const TEXT_FIELDS = Object.freeze([
  'make',
  'model',
  'project',
  'municipality',
  'county',
  'operator',
]);
const DATE_FIELDS = Object.freeze(['built', 'updated']);
const NUMBER_FIELDS = Object.freeze([
  'totalHeightM',
  'hubHeightM',
  'rotorM',
  'powerMW',
  'productionGWh',
]);

/**
 * Rows as the snapshot keeps them: `{statuses, fields, strings, rows}`, each
 * row an array in PACKED_FIELDS order, its texts in one shared string table.
 */
export function packTurbines(rows) {
  const strings = [''];
  const index = new Map([['', 0]]);
  const ref = (value) => {
    if (!value) return 0;
    let at = index.get(value);
    if (at === undefined) {
      at = strings.length;
      strings.push(value);
      index.set(value, at);
    }
    return at;
  };
  const packed = rows.map((row) =>
    PACKED_FIELDS.map((field) => {
      if (field === 'id') return row.id;
      if (field === 'lon') return row.point[0];
      if (field === 'lat') return row.point[1];
      if (field === 'status') return row.status;
      if (field === 'zone') return row.zone ? Number(row.zone.slice(2)) : 0;
      if (TEXT_FIELDS.includes(field)) return ref(row[field]);
      if (DATE_FIELDS.includes(field)) return dateNumber(row[field]);
      return row[field] ?? 0;
    }),
  );
  return {
    statuses: TURBINE_STATUSES.map((entry) => entry.status),
    fields: PACKED_FIELDS,
    strings,
    rows: packed,
  };
}

/** A snapshot's packed rows as the rows the route and the layer read. */
export function unpackTurbines(snapshot) {
  const { fields, strings, statuses, rows: packedRows } = snapshot ?? {};
  if (
    !Array.isArray(fields) ||
    !Array.isArray(strings) ||
    !Array.isArray(statuses) ||
    !Array.isArray(packedRows)
  )
    throw new Error('Malformed turbine snapshot');
  const missing = PACKED_FIELDS.filter((field) => !fields.includes(field));
  if (missing.length)
    throw new Error(`Malformed turbine snapshot: no ${missing.join(', ')}`);
  const at = Object.fromEntries(fields.map((field, i) => [field, i]));
  // The snapshot's status numbers, read through its own list of statuses.
  const statusOf = statuses.map((status) => statusCode(status));
  const textOf = (value) =>
    Number.isInteger(value) && value > 0 && typeof strings[value] === 'string'
      ? strings[value]
      : null;
  const rows = [];
  for (const packed of packedRows) {
    if (!Array.isArray(packed)) continue;
    const lon = Number(packed[at.lon]);
    const lat = Number(packed[at.lat]);
    const id = safeId(packed[at.id]);
    if (!id || !Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const status = statusOf[packed[at.status]] ?? UNKNOWN_STATUS;
    const row = {
      id,
      point: [lon, lat],
      status,
      kind: TURBINE_STATUSES[status].kind,
    };
    for (const field of NUMBER_FIELDS) {
      const value = Number(packed[at[field]]);
      row[field] = Number.isFinite(value) && value > 0 ? value : null;
    }
    for (const field of TEXT_FIELDS) row[field] = textOf(packed[at[field]]);
    for (const field of DATE_FIELDS) row[field] = numberDate(packed[at[field]]);
    const zone = Number(packed[at.zone]);
    row.zone = zone >= 1 && zone <= 4 ? `SE${zone}` : null;
    rows.push(row);
  }
  return rows;
}

/**
 * What a view's answer carries per turbine: enough to draw it, name it and
 * count it, in short keys, empty fields left out. The rest comes for one
 * turbine on a click (see `turbineDetail`).
 */
export function compactTurbine(row) {
  const out = { i: row.id, p: row.point, s: row.status };
  if (row.totalHeightM) out.h = row.totalHeightM;
  if (row.powerMW) out.w = row.powerMW;
  if (row.project) out.n = row.project;
  if (row.municipality) out.c = row.municipality;
  return out;
}

/** A compact turbine as the row the layer reads, or null when malformed. */
export function expandTurbine(c) {
  const id = typeof c?.i === 'string' ? safeId(c.i) : '';
  const [lon, lat] = Array.isArray(c?.p) ? c.p.map(Number) : [];
  if (!id || !Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const status = TURBINE_STATUSES[c.s] ? c.s : UNKNOWN_STATUS;
  const positive = (value) =>
    Number.isFinite(value) && value > 0 ? value : null;
  return {
    id,
    point: [lon, lat],
    status,
    kind: TURBINE_STATUSES[status].kind,
    totalHeightM: positive(c.h),
    powerMW: positive(c.w),
    project: typeof c.n === 'string' ? c.n : null,
    municipality: typeof c.c === 'string' ? c.c : null,
  };
}

/** The kinds a list of chip groups shows, built always first. */
export function kindsOf(groups = []) {
  const kinds = new Set(DEFAULT_TURBINE_KINDS);
  for (const group of groups)
    for (const kind of TURBINE_GROUPS[group] ?? []) kinds.add(kind);
  return TURBINE_KINDS.map((entry) => entry.id).filter((kind) =>
    kinds.has(kind),
  );
}

/** Kinds from a query parameter ("built,planned"), known ones only. */
export function parseKinds(value) {
  const asked = new Set(
    String(value ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean),
  );
  const kinds = TURBINE_KINDS.map((entry) => entry.id).filter((kind) =>
    asked.has(kind),
  );
  return kinds.length ? kinds : [...DEFAULT_TURBINE_KINDS];
}

/** The view box cut to WIND_MAX_SPAN_DEG a side about the centre. */
export const clipWindBox = (bbox, center) =>
  clipViewBox(bbox, center, WIND_MAX_SPAN_DEG);

/**
 * The turbines in a view: how many of each kind, how many of the kinds
 * asked for, the rated power of the built ones only, and the nearest
 * `limit` of the kinds asked for to the centre, nearest first.
 * @param {object[]} rows Unpacked turbines.
 * @param {{bbox: number[], center: number[], limit?: number,
 *   kinds?: string[]}} query
 */
export function turbinesInView(
  rows,
  { bbox, center, limit = WIND_SHOWN, kinds = DEFAULT_TURBINE_KINDS },
) {
  const [west, south, east, north] = bbox;
  const wanted = new Set(kinds);
  const counts = Object.fromEntries(TURBINE_KINDS.map(({ id }) => [id, 0]));
  const inside = [];
  let builtMW = 0;
  for (const row of rows) {
    const [lon, lat] = row.point;
    if (lon < west || lon > east || lat < south || lat > north) continue;
    counts[row.kind] += 1;
    if (row.kind === 'built') builtMW += row.powerMW ?? 0;
    if (wanted.has(row.kind)) inside.push(row);
  }
  const turbines = inside
    .map((row) => ({ row, distance: distanceMeters(center, row.point) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, Math.max(0, limit))
    .map(({ row }) => row);
  return {
    total: inside.length,
    builtMW: Math.round(builtMW * 10) / 10,
    counts,
    turbines,
  };
}

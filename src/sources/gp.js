import { json2satrec } from 'satellite.js';

// Swedish fork: CelesTrak GP data (general perturbations mean elements) as
// CSV, the answer to `gp.php?GROUP=<group>&FORMAT=CSV`: a header naming the
// OMM fields, then one row per object. CelesTrak sends no TLE for objects
// numbered 100000 and up (all newly catalogued ones); CSV carries every
// object, and satellite.js builds the satrec straight from the fields
// (`json2satrec`). The satellites layer, Space Missions and the voice tools
// read the same rows.

/**
 * The fields every row needs to become an orbit: satellite.js reads them.
 * The proxy checks the header for the same ones (CELESTRAK_GP_FIELDS in
 * server/providers/space/celestrak.js; a test holds the two lists equal).
 */
export const GP_REQUIRED_FIELDS = Object.freeze([
  'OBJECT_NAME',
  'NORAD_CAT_ID',
  'EPOCH',
  'MEAN_MOTION',
  'ECCENTRICITY',
  'INCLINATION',
  'RA_OF_ASC_NODE',
  'ARG_OF_PERICENTER',
  'MEAN_ANOMALY',
  'BSTAR',
]);
/** The orbital elements among them, in this order. */
const ELEMENTS = GP_REQUIRED_FIELDS.slice(3);
/** Days in each month of a leap year; February has 28 in the others. */
const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Split one RFC 4180 CSV line (quoted fields may hold commas). */
function csvFields(line) {
  if (!line.includes('"')) return line.split(',');
  const fields = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      fields.push(field);
      field = '';
    } else field += ch;
  }
  fields.push(field);
  return fields;
}

/**
 * Where each field of an unquoted CSV line starts, written into `starts`,
 * whose last slot gets one past the line's end; false when the line has
 * another number of fields than `starts` has slots, less one. Nothing is
 * allocated: a catalog has thousands of rows, of whose seventeen fields the
 * parser reads four.
 * @param {string} line
 * @param {Int32Array} starts
 */
function fieldStarts(line, starts) {
  const last = starts.length - 2;
  let from = 0;
  for (let i = 0; i <= last; i++) {
    starts[i] = from;
    const comma = line.indexOf(',', from);
    // Every field but the last ends at a comma.
    if (comma < 0 !== (i === last)) return false;
    from = comma < 0 ? line.length + 1 : comma + 1;
  }
  starts[last + 1] = from;
  return true;
}

// The parser reads a row's catalog number, epoch and designator, and
// gpSatrec its elements, where they lie, by character: no string is made
// for them, nor a regular expression run, thousands of times a load.
// `text[from, to)` is the cell; spaces and the CR of a CRLF line around it
// are left out first (each reader trims in place).

/** The two digits at `at` as a number, or -1 when they are not two digits. */
function twoDigitsAt(text, at) {
  const high = text.charCodeAt(at) - 48;
  const low = text.charCodeAt(at + 1) - 48;
  return high >= 0 && high <= 9 && low >= 0 && low <= 9 ? high * 10 + low : -1;
}

/** One to nine digits making a catalog number above zero, or null. */
function catalogNumberIn(text, from, to) {
  while (from < to && text.charCodeAt(from) <= 32) from++;
  while (to > from && text.charCodeAt(to - 1) <= 32) to--;
  if (to - from < 1 || to - from > 9) return null;
  let number = 0;
  for (let at = from; at < to; at++) {
    const digit = text.charCodeAt(at) - 48;
    if (!(digit >= 0 && digit <= 9)) return null;
    number = number * 10 + digit;
  }
  return number > 0 ? number : null;
}

/** The catalog number a field holds, or null for anything but digits. */
const catalogNumber = (field) => catalogNumberIn(field, 0, field.length);

/**
 * An international designator's launch year (`1998-067A`: launch year,
 * launch of the year, piece in one to three capitals), or null.
 */
function designatorYearIn(text, from, to) {
  while (from < to && text.charCodeAt(from) <= 32) from++;
  while (to > from && text.charCodeAt(to - 1) <= 32) to--;
  if (to - from < 9 || to - from > 11) return null;
  const century = twoDigitsAt(text, from);
  const year = twoDigitsAt(text, from + 2);
  const digit = text.charCodeAt(from + 7) - 48;
  if (
    century < 0 ||
    year < 0 ||
    text.charCodeAt(from + 4) !== 45 ||
    twoDigitsAt(text, from + 5) < 0 ||
    !(digit >= 0 && digit <= 9)
  )
    return null;
  for (let at = from + 8; at < to; at++) {
    const code = text.charCodeAt(at);
    if (code < 65 || code > 90) return null;
  }
  return century * 100 + year;
}

/** Whether a field is an international designator. */
const isDesignator = (field) =>
  designatorYearIn(field, 0, field.length) !== null;

/** 10^0 … 10^22: every power of ten a double holds exactly. */
const POWERS_OF_TEN = [];
for (let power = 1, k = 0; k <= 22; k++, power *= 10) POWERS_OF_TEN.push(power);

/**
 * A decimal number (`15.4943864`, `.0001473`, `-.11606E-4`) as Number() reads
 * it, bit for bit, or null for anything else: a blank, `0x1F`, `Infinity`,
 * trailing characters. Read in place: a mantissa that is a safe integer, times
 * a power of ten up to 10^22, is one correctly rounded multiplication or
 * division (Clinger's fast path), which every number CelesTrak writes is;
 * any other is read by Number() from a slice.
 */
function decimalIn(text, from, to) {
  while (from < to && text.charCodeAt(from) <= 32) from++;
  while (to > from && text.charCodeAt(to - 1) <= 32) to--;
  let at = from;
  const sign = text.charCodeAt(at);
  if (sign === 45 || sign === 43) at++;
  let mantissa = 0;
  let scale = 0;
  let digits = 0;
  for (; at < to; at++) {
    const digit = text.charCodeAt(at) - 48;
    if (!(digit >= 0 && digit <= 9)) break;
    mantissa = mantissa * 10 + digit;
    digits++;
  }
  if (at < to && text.charCodeAt(at) === 46)
    for (at++; at < to; at++) {
      const digit = text.charCodeAt(at) - 48;
      if (!(digit >= 0 && digit <= 9)) break;
      mantissa = mantissa * 10 + digit;
      scale--;
      digits++;
    }
  if (digits === 0) return null;
  let exponent = 0;
  if (at < to && (text.charCodeAt(at) | 32) === 101) {
    at++;
    const exponentSign = text.charCodeAt(at);
    if (exponentSign === 45 || exponentSign === 43) at++;
    const first = at;
    for (; at < to; at++) {
      const digit = text.charCodeAt(at) - 48;
      if (!(digit >= 0 && digit <= 9)) break;
      if (exponent < 1e6) exponent = exponent * 10 + digit;
    }
    if (at === first) return null;
    if (exponentSign === 45) exponent = -exponent;
  }
  if (at !== to) return null;
  const power = scale + exponent;
  if (mantissa <= Number.MAX_SAFE_INTEGER && power >= -22 && power <= 22) {
    const size =
      power < 0
        ? mantissa / POWERS_OF_TEN[-power]
        : mantissa * POWERS_OF_TEN[power];
    return sign === 45 ? -size : size;
  }
  const value = +text.slice(from, to);
  return Number.isFinite(value) ? value : null;
}

/** A field as a decimal number (decimalIn), or null. */
const numberOf = (field) => decimalIn(field, 0, field.length);

/**
 * An OMM epoch in UTC (`2026-11-21T12:34:56.123456`, the fraction and a `Z`
 * optional) that names a real date and time, as whole microseconds since
 * 1970 (exact: below 2^53 for any year to come), or null. No Date is made.
 */
function epochMicrosIn(text, from, to) {
  while (from < to && text.charCodeAt(from) <= 32) from++;
  while (to > from && text.charCodeAt(to - 1) <= 32) to--;
  if (to - from > 19 && text.charCodeAt(to - 1) === 90) to--;
  // Seconds and nothing more, or seconds, a point and at least one digit.
  if (to - from < 19 || to - from === 20) return null;
  const century = twoDigitsAt(text, from);
  const year = century * 100 + twoDigitsAt(text, from + 2);
  const month = twoDigitsAt(text, from + 5);
  const day = twoDigitsAt(text, from + 8);
  const hour = twoDigitsAt(text, from + 11);
  const minute = twoDigitsAt(text, from + 14);
  const second = twoDigitsAt(text, from + 17);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (
    century < 0 ||
    twoDigitsAt(text, from + 2) < 0 ||
    text.charCodeAt(from + 4) !== 45 ||
    text.charCodeAt(from + 7) !== 45 ||
    text.charCodeAt(from + 10) !== 84 ||
    text.charCodeAt(from + 13) !== 58 ||
    text.charCodeAt(from + 16) !== 58 ||
    !(month >= 1 && month <= 12) ||
    !(day >= 1 && day <= (month === 2 && !leap ? 28 : MONTH_DAYS[month - 1])) ||
    !(hour >= 0 && hour <= 23) ||
    !(minute >= 0 && minute <= 59) ||
    !(second >= 0 && second <= 59)
  )
    return null;
  // The fraction's first six digits; any after them must be digits too.
  let micros = 0;
  if (to - from > 19) {
    if (text.charCodeAt(from + 19) !== 46) return null;
    for (let at = from + 20, place = 100_000; at < to; at++, place /= 10) {
      const digit = text.charCodeAt(at) - 48;
      if (!(digit >= 0 && digit <= 9)) return null;
      if (place >= 1) micros += digit * place;
    }
  }
  return Date.UTC(year, month - 1, day, hour, minute, second) * 1000 + micros;
}

/** An epoch field's microseconds (epochMicrosIn), or null. */
const epochMicros = (field) => epochMicrosIn(field, 0, field.length);

/** A valid epoch's whole seconds (`2026-11-21T12:34:56`) and its fraction's digits. */
function epochParts(epoch) {
  const plain = epoch.endsWith('Z') ? epoch.slice(0, -1) : epoch;
  const dot = plain.indexOf('.');
  return dot < 0
    ? { seconds: plain, fraction: '' }
    : { seconds: plain.slice(0, dot), fraction: plain.slice(dot + 1) };
}

/**
 * A valid epoch in text[from, to) as every browser's Date reads it:
 * milliseconds and Z (V8 cuts a longer fraction the same way). CelesTrak
 * writes six digits, so the cell's first 23 characters, the milliseconds,
 * do; anything shorter is padded.
 */
function dateEpochIn(text, from, to) {
  while (from < to && text.charCodeAt(from) <= 32) from++;
  while (to > from && text.charCodeAt(to - 1) <= 32) to--;
  const digit = text.charCodeAt(from + 22) - 48;
  if (
    to - from >= 23 &&
    text.charCodeAt(from + 19) === 46 &&
    digit >= 0 &&
    digit <= 9
  )
    return `${text.slice(from, from + 23)}Z`;
  const { seconds, fraction } = epochParts(text.slice(from, to));
  return `${seconds}.${fraction.padEnd(3, '0').slice(0, 3)}Z`;
}

/**
 * The cells gpSatrec reads, in this order: the catalog number, the epoch,
 * the elements (as ELEMENTS) and the two rates.
 */
const SATREC_CELLS = Object.freeze([
  'NORAD_CAT_ID',
  'EPOCH',
  ...ELEMENTS,
  'MEAN_MOTION_DOT',
  'MEAN_MOTION_DDOT',
]);
/** Per header (its `columns`), where those cells are: field indexes, ascending. */
const SATREC_PLANS = new WeakMap();
/** Where the cells of the satrec being built lie in its row (empty: none). */
const cellFrom = new Int32Array(SATREC_CELLS.length);
const cellTo = new Int32Array(SATREC_CELLS.length);

function satrecPlan(columns) {
  let plan = SATREC_PLANS.get(columns);
  if (!plan) {
    const wanted = SATREC_CELLS.map((name, slot) => [columns[name], slot])
      .filter(([index]) => Number.isInteger(index))
      .sort((a, b) => a[0] - b[0]);
    plan = {
      indexes: wanted.map(([index]) => index),
      slots: wanted.map(([, slot]) => slot),
    };
    SATREC_PLANS.set(columns, plan);
  }
  return plan;
}

/**
 * Where an unquoted row's SATREC_CELLS lie, into cellFrom and cellTo (an
 * empty range when the header or the row has none). One pass, nothing
 * sliced: a Starlink load builds thousands of satrecs from rows of
 * seventeen fields.
 */
function satrecBounds(row, columns) {
  cellFrom.fill(0);
  cellTo.fill(0);
  const { indexes, slots } = satrecPlan(columns);
  let field = 0;
  let from = 0;
  for (let k = 0; k < indexes.length; k++) {
    for (; field < indexes[k]; field++) {
      const comma = row.indexOf(',', from);
      if (comma < 0) return;
      from = comma + 1;
    }
    const comma = row.indexOf(',', from);
    cellFrom[slots[k]] = from;
    cellTo[slots[k]] = comma < 0 ? row.length : comma;
    if (comma < 0) return;
    from = comma + 1;
    field++;
  }
}

/**
 * Parse CelesTrak GP CSV into one entry per object:
 * `{ name, noradId, launchYear, epoch, row, columns }`. `launchYear` comes
 * from the international designator (OBJECT_ID), null when it is blank or no
 * designator; `epoch` is the element set's epoch in whole microseconds since
 * 1970, UTC, which with the catalog number names the element set
 * (createGpSatrecCache keys on both); `row` is the object's line and
 * `columns` the header's field indexes, shared by every entry of the text,
 * which gpRecord, gpSatrec, gpCosparId and gpTleLines read. A text without
 * the needed header gives none (an error page, an empty answer). A row is
 * skipped, and the next read, when it has another number of fields than the
 * header (a truncated or spliced line, so one object's fields cannot pass
 * for another's), a catalog number that is not plain digits, or an epoch
 * that is no UTC time. Its elements are read when its satrec is built
 * (gpSatrec), as satellite.js read a TLE's.
 * @param {string} text
 * @returns {Array<{name: string, noradId: number, launchYear: number|null,
 *   epoch: number, row: string, columns: Readonly<Record<string, number>>}>}
 */
export function parseGpCsv(text) {
  // A CR left on a CRLF line ends its last field, which is read trimmed.
  const lines = String(text ?? '').split('\n');
  // trim() also drops a byte order mark before the first name.
  const header = csvFields(lines[0]).map((name) => name.trim());
  const columns = {};
  header.forEach((name, index) => {
    if (name && !(name in columns)) columns[name] = index;
  });
  if (!GP_REQUIRED_FIELDS.every((name) => name in columns)) return [];
  Object.freeze(columns);
  const {
    OBJECT_NAME: nameAt,
    NORAD_CAT_ID: numberAt,
    EPOCH: epochAt,
    OBJECT_ID: designatorAt,
  } = columns;
  const starts = new Int32Array(header.length + 1);
  const entries = [];
  for (let i = 1; i < lines.length; i++) {
    const row = lines[i];
    // A quoted row is split whole; any other is only measured, and its
    // cells are read where they lie (`starts[index]` to the next, less its
    // comma).
    let fields = null;
    if (row.includes('"')) {
      fields = csvFields(row);
      if (fields.length !== header.length) continue;
    } else if (!fieldStarts(row, starts)) continue;
    const noradId = fields
      ? catalogNumber(fields[numberAt])
      : catalogNumberIn(row, starts[numberAt], starts[numberAt + 1] - 1);
    if (noradId === null) continue;
    const epoch = fields
      ? epochMicros(fields[epochAt])
      : epochMicrosIn(row, starts[epochAt], starts[epochAt + 1] - 1);
    if (epoch === null) continue;
    let launchYear = null;
    if (designatorAt !== undefined)
      launchYear = fields
        ? designatorYearIn(fields[designatorAt], 0, fields[designatorAt].length)
        : designatorYearIn(
            row,
            starts[designatorAt],
            starts[designatorAt + 1] - 1,
          );
    entries.push({
      name: (fields
        ? fields[nameAt]
        : row.slice(starts[nameAt], starts[nameAt + 1] - 1)
      ).trim(),
      noradId,
      launchYear,
      epoch,
      row,
      columns,
    });
  }
  return entries;
}

/**
 * An entry's fields by name, as text (trimmed, unquoted), or null for no
 * entry. Read again from the row when asked, so an entry holds no more than
 * its line.
 * @param {{row?: string, columns?: Record<string, number>}|null|undefined} entry
 * @returns {Record<string, string>|null}
 */
export function gpRecord(entry) {
  if (typeof entry?.row !== 'string' || !entry.columns) return null;
  const fields = csvFields(entry.row);
  const record = {};
  for (const [name, index] of Object.entries(entry.columns))
    record[name] = (fields[index] ?? '').trim();
  return record;
}

/**
 * The entry's satrec, built by satellite.js from its fields (json2satrec),
 * or null when there is no entry, an element is blank or no number, the
 * elements are no orbit (a mean motion at or below zero, an eccentricity
 * outside [0, 1)) or SGP4 rejects them. The epoch of an entry parseGpCsv
 * read (`entry.epoch`) is already checked; any other entry's is checked.
 * @param {{row: string, columns: Record<string, number>, epoch?: number}|null|undefined} entry
 * @returns {import('satellite.js').SatRec|null}
 */
export function gpSatrec(entry) {
  if (typeof entry?.row !== 'string' || !entry.columns) return null;
  // A quoted row (a name with a comma) is read as the same row unquoted,
  // the commas inside its fields made spaces: no cell read here holds one.
  const row = entry.row.includes('"')
    ? csvFields(entry.row)
        .map((field) => field.replaceAll(',', ' '))
        .join(',')
    : entry.row;
  satrecBounds(row, entry.columns);
  // parseGpCsv checked the epoch it read; any other entry is checked here.
  if (
    !Number.isFinite(entry.epoch) &&
    epochMicrosIn(row, cellFrom[1], cellTo[1]) === null
  )
    return null;
  // Read where they lie, in SATREC_CELLS order; the catalog number as
  // parseGpCsv read it, when it did.
  const omm = {
    NORAD_CAT_ID: Number.isInteger(entry.noradId)
      ? entry.noradId
      : row.slice(cellFrom[0], cellTo[0]).trim(),
    EPOCH: dateEpochIn(row, cellFrom[1], cellTo[1]),
    MEAN_MOTION: decimalIn(row, cellFrom[2], cellTo[2]),
    ECCENTRICITY: decimalIn(row, cellFrom[3], cellTo[3]),
    INCLINATION: decimalIn(row, cellFrom[4], cellTo[4]),
    RA_OF_ASC_NODE: decimalIn(row, cellFrom[5], cellTo[5]),
    ARG_OF_PERICENTER: decimalIn(row, cellFrom[6], cellTo[6]),
    MEAN_ANOMALY: decimalIn(row, cellFrom[7], cellTo[7]),
    BSTAR: decimalIn(row, cellFrom[8], cellTo[8]),
    // Not used by SGP4; CelesTrak sends them, a row may leave them blank.
    MEAN_MOTION_DOT: decimalIn(row, cellFrom[9], cellTo[9]) ?? 0,
    MEAN_MOTION_DDOT: decimalIn(row, cellFrom[10], cellTo[10]) ?? 0,
  };
  const { MEAN_MOTION: meanMotion, ECCENTRICITY: eccentricity } = omm;
  if (
    omm.INCLINATION === null ||
    omm.RA_OF_ASC_NODE === null ||
    omm.ARG_OF_PERICENTER === null ||
    omm.MEAN_ANOMALY === null ||
    omm.BSTAR === null ||
    // No orbit (null is not > 0, and fails the eccentricity range too).
    !(meanMotion > 0) ||
    !(eccentricity !== null && eccentricity >= 0 && eccentricity < 1)
  )
    return null;
  try {
    const satrec = json2satrec(omm);
    return satrec?.error === 0 ? satrec : null;
  } catch {
    return null;
  }
}

/**
 * Satrecs kept between catalog builds (Swedish fork): the proxy serves the
 * same GP rows for 6 h, and the satellites layer rebuilds its catalog every
 * 5 min, so most rows it reads it has built a satrec for already. An entry
 * whose catalog number, epoch (parseGpCsv's `epoch`) and row are those of a
 * satrec built before gets that satrec back; any other is built (gpSatrec).
 * A build keeps only what it asked for, so the cache holds the current
 * catalog and no more; a build that stopped part way (superseded, aborted)
 * loses nothing it had. A satrec can be reused as it is: SGP4 clears its
 * error flag on every propagation.
 * @returns {{begin(): void, satrec(entry: object): object|null, end(): void,
 *   clear(): void}}
 */
export function createGpSatrecCache() {
  /** catalog number → `{epoch, satrec}`: the last finished build's. */
  let kept = new Map();
  /** The same, for what the build under way has asked for. */
  let built = new Map();
  return {
    /** Start a build. */
    begin() {
      if (kept.size === 0) kept = built;
      else for (const [noradId, held] of built) kept.set(noradId, held);
      built = new Map();
    },
    /** The entry's satrec, built only when its row is new. */
    satrec(entry) {
      const { noradId, epoch, row } = entry ?? {};
      if (!Number.isFinite(epoch)) return gpSatrec(entry);
      const held = built.get(noradId) ?? kept.get(noradId);
      // The same epoch and the same row: a set re-issued or corrected at its
      // epoch, or one now invalid, is built (and judged) again.
      if (held !== undefined && held.epoch === epoch && held.row === row) {
        // The newest copy of the row: an older one keeps its whole body.
        held.row = row;
        built.set(noradId, held);
        return held.satrec;
      }
      const satrec = gpSatrec(entry);
      if (satrec) built.set(noradId, { epoch, row, satrec });
      else built.delete(noradId);
      return satrec;
    },
    /** End a build: only the satrecs it asked for stay. */
    end() {
      kept = new Map();
    },
    /** Forget every satrec (the catalog it served is gone). */
    clear() {
      kept = new Map();
      built = new Map();
    },
  };
}

/**
 * The entry's international designator (COSPAR id), e.g. `1998-067A`, or
 * null when OBJECT_ID is blank or something else.
 * @param {{row: string, columns: Record<string, number>}|null|undefined} entry
 * @returns {string|null}
 */
export function gpCosparId(entry) {
  const id = gpRecord(entry)?.OBJECT_ID ?? '';
  return isDesignator(id) ? id : null;
}

/**
 * NORAD catalog number of a satrec as a number, or NaN. satellite.js keeps
 * it as text in `satrec.satnum`: the NORAD_CAT_ID field, unpadded, for a GP
 * satrec. Digits of any length read; anything else, blank included, is NaN.
 * @param {string} satnum
 * @returns {number}
 */
export function noradIdFromSatnum(satnum) {
  const text = String(satnum ?? '').trim();
  return /^\d+$/.test(text) ? Number(text) : Number.NaN;
}

/** The TLE checksum: every digit, and 1 for each minus sign, modulo 10. */
function checksum(line) {
  let sum = 0;
  for (const ch of line) {
    if (ch >= '0' && ch <= '9') sum += Number(ch);
    else if (ch === '-') sum += 1;
  }
  return sum % 10;
}

/** `width` columns of a fixed-point number, or null when it does not fit. */
function fixed(value, digits, width) {
  const text = value.toFixed(digits).padStart(width, ' ');
  return text.length === width ? text : null;
}

/**
 * A TLE derivative of the mean motion (columns 34–43): sign, then a decimal
 * point and eight digits, ` .00016717`; null at one or more.
 */
function rateField(value) {
  const text = Math.abs(value).toFixed(8);
  if (!text.startsWith('0.')) return null;
  return `${value < 0 && Number(text) !== 0 ? '-' : ' '}${text.slice(1)}`;
}

/**
 * A TLE number in exponent form (columns 45–52 and 54–61): sign, five
 * digits after an assumed decimal point, the power of ten, ` 30370-3` for
 * 0.00030370. Zero, or a number too small for one digit of power, is
 * ` 00000+0`; null when it is too large.
 */
function exponentField(value) {
  const size = Math.abs(value);
  let power = size > 0 ? Math.floor(Math.log10(size)) + 1 : 0;
  let digits = Math.round(size * 10 ** (5 - power));
  if (digits >= 100_000) {
    power += 1;
    digits = Math.round(size * 10 ** (5 - power));
  } else if (digits > 0 && digits < 10_000) {
    power -= 1;
    digits = Math.round(size * 10 ** (5 - power));
  }
  if (digits === 0 || power < -9) return ' 00000+0';
  if (power > 9) return null;
  return `${value < 0 ? '-' : ' '}${String(digits).padStart(5, '0')}${power < 0 ? '-' : '+'}${Math.abs(power)}`;
}

/**
 * A TLE epoch (columns 19–32) from a valid OMM epoch: two-digit year, then
 * the day of the year and its fraction to eight places, `24001.50000000`;
 * null outside 1957–2056, the years two digits can name.
 */
function epochField(epoch) {
  const year = twoDigitsAt(epoch, 0) * 100 + twoDigitsAt(epoch, 2);
  // In 1e-8 days (864 µs, so a day is exactly 1e8) from the start of the
  // year, rounded.
  let units = Math.round(
    (epochMicros(epoch) - Date.UTC(year, 0, 1) * 1000) / 864,
  );
  let tleYear = year;
  const yearDays = (Date.UTC(year + 1, 0, 1) - Date.UTC(year, 0, 1)) / 864e5;
  if (units >= yearDays * 1e8) {
    units -= yearDays * 1e8;
    tleYear += 1;
  }
  if (tleYear < 1957 || tleYear > 2056) return null;
  const dayOfYear = Math.floor(units / 1e8) + 1;
  const fraction = units % 1e8;
  return `${String(tleYear % 100).padStart(2, '0')}${String(dayOfYear).padStart(3, '0')}.${String(fraction).padStart(8, '0')}`;
}

/** A whole number field, the TLE's last `width` digits of it, or 0. */
function countField(value, width) {
  const number = /^\d+$/.test(value) ? Number(value) % 10 ** width : 0;
  return String(number).padStart(width, ' ');
}

/**
 * The element set as the two lines of a TLE, each with its checksum, or
 * null: CelesTrak writes no object numbered 100000 and up as a TLE, and a
 * field that does not fit its columns (a mean motion of 100 or more, an
 * epoch outside 1957–2056) leaves none. CelesTrak sends the data as CSV; the
 * lines say the same elements in the format the Cockpit shows.
 * @param {{row: string, columns: Record<string, number>}|null|undefined} entry
 * @returns {{line1: string, line2: string}|null}
 */
export function gpTleLines(entry) {
  const record = gpRecord(entry);
  if (!record) return null;
  const noradId = catalogNumber(record.NORAD_CAT_ID);
  if (noradId === null || noradId > 99_999) return null;
  if (epochMicros(record.EPOCH) === null) return null;
  const elements = ELEMENTS.map((name) => numberOf(record[name]));
  if (elements.includes(null)) return null;
  const [meanMotion, eccentricity, ...rest] = elements;
  // No lines for elements that are no orbit, as gpSatrec builds none.
  if (!(meanMotion > 0 && eccentricity >= 0 && eccentricity < 1)) return null;
  const bstar = rest.pop();
  const number = String(noradId).padStart(5, '0');
  const classification = /^[A-Z]$/.test(record.CLASSIFICATION_TYPE ?? '')
    ? record.CLASSIFICATION_TYPE
    : 'U';
  const designator = isDesignator(record.OBJECT_ID ?? '')
    ? record.OBJECT_ID
    : null;
  // `1998-067A` is written `98067A  `.
  const designatorField = designator
    ? `${designator.slice(2, 4)}${designator.slice(5)}`.padEnd(8, ' ')
    : ' '.repeat(8);
  const rate = (name) => numberOf(record[name] ?? '') ?? 0;
  const epoch = epochField(record.EPOCH);
  const ndot = rateField(rate('MEAN_MOTION_DOT'));
  const nddot = exponentField(rate('MEAN_MOTION_DDOT'));
  const drag = exponentField(bstar);
  const ephemeris = /^\d$/.test(record.EPHEMERIS_TYPE ?? '')
    ? record.EPHEMERIS_TYPE
    : '0';
  const eccentricityDigits = Math.round(eccentricity * 1e7);
  // Inclination, ascending node, argument of perigee, mean anomaly.
  const angles = rest.map((angle) => fixed(angle, 4, 8));
  const motion = fixed(meanMotion, 8, 11);
  if (
    !epoch ||
    !ndot ||
    !nddot ||
    !drag ||
    eccentricityDigits >= 1e7 ||
    angles.includes(null) ||
    !motion
  )
    return null;
  const [inclination, node, perigee, anomaly] = angles;
  const line1 = `1 ${number}${classification} ${designatorField} ${epoch} ${ndot} ${nddot} ${drag} ${ephemeris} ${countField(record.ELEMENT_SET_NO ?? '', 4)}`;
  const line2 = `2 ${number} ${inclination} ${node} ${String(eccentricityDigits).padStart(7, '0')} ${perigee} ${anomaly} ${motion}${countField(record.REV_AT_EPOCH ?? '', 5)}`;
  return {
    line1: `${line1}${checksum(line1)}`,
    line2: `${line2}${checksum(line2)}`,
  };
}

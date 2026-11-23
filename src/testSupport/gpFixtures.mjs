// CelesTrak GP CSV for tests (src/sources/gp.js reads it): the documented
// header, and rows written by hand from the fields each test owns. Never
// live data.

/** The GP CSV fields, in the order CelesTrak documents them. */
export const GP_CSV_FIELDS = Object.freeze([
  'OBJECT_NAME',
  'OBJECT_ID',
  'EPOCH',
  'MEAN_MOTION',
  'ECCENTRICITY',
  'INCLINATION',
  'RA_OF_ASC_NODE',
  'ARG_OF_PERICENTER',
  'MEAN_ANOMALY',
  'EPHEMERIS_TYPE',
  'CLASSIFICATION_TYPE',
  'NORAD_CAT_ID',
  'ELEMENT_SET_NO',
  'REV_AT_EPOCH',
  'BSTAR',
  'MEAN_MOTION_DOT',
  'MEAN_MOTION_DDOT',
]);

export const GP_CSV_HEADER = GP_CSV_FIELDS.join(',');

/** One field as CSV writes it: quoted when it holds a comma or a quote. */
const csvField = (value) => {
  const text = String(value ?? '');
  return /[",]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** One GP CSV row from its fields by name; a field not given is blank. */
export function gpCsvRow(fields) {
  return GP_CSV_FIELDS.map((name) => csvField(fields[name])).join(',');
}

/** GP CSV text: the header, then one row per object's fields. */
export function gpCsv(...objects) {
  return `${[GP_CSV_HEADER, ...objects.map(gpCsvRow)].join('\n')}\n`;
}

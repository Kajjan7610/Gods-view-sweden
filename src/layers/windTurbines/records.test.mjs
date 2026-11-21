// Vindbrukskollen's wind turbines: what a register row keeps and what it
// never does, the packed snapshot, the view query, and the shapefile reading
// the build uses.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readDbf, readShpPoints } from '../../../scripts/lib/shapefile.mjs';
import {
  DEFAULT_TURBINE_KINDS,
  PACKED_FIELDS,
  TURBINE_STATUSES,
  WIND_MAX_SPAN_DEG,
  biddingZone,
  clipWindBox,
  compactTurbine,
  expandTurbine,
  isLegalPersonNumber,
  kindsOf,
  looksLikePersonName,
  normalizeTurbine,
  normalizeTurbines,
  operatorName,
  packTurbines,
  parseKinds,
  projectName,
  registerDate,
  statusCode,
  statusIndex,
  turbinesInView,
  unpackTurbines,
} from './records.js';

/** A register row as the shapefile's .dbf gives it (names cut to 10). */
const ROW = Object.freeze({
  OBJECTID: 7,
  VERKID: '2262-V-004-012',
  OMRID: '2262-V-004',
  PROJNAMN: 'Vindpark Exempelberget',
  STATUS: 'Uppfört',
  HANDLINGST: 'Tillstånd (Enligt 9 kap. 6 § miljöbalken)',
  UPPFORT: '20191101',
  MB_Tillsta: '20450101',
  TOTALHOJD: 200,
  NAVHOJD: 120,
  ROTDIAMETE: 160,
  MAXEFFEKT: 5.6,
  CALPROD: 17.25,
  FABRIKAT: 'Vestas',
  MODELL: 'V162',
  ORGNAMN: 'Exempel Vind AB',
  ORGNMR: '556677-8899',
  PLACERING: 'Land',
  KOMNAMN: 'Timrå',
  LANSNAMN: 'Västernorrlands län',
  EL_NAMN: 'Sundsvall',
  SenasteUpp: '20260402',
  EJAKTUELL: null,
  RADERAD: 0,
  ARENDESTAT: 4,
});
/** Near Sundsvall, in SWEREF 99 TM. */
const XY = Object.freeze([620000, 6930000]);

test('the register statuses map to legend kinds, plural forms too', () => {
  assert.equal(TURBINE_STATUSES[statusCode('Uppfört')].kind, 'built');
  for (const status of ['Beviljat', 'Handläggs', 'Överklagat'])
    assert.equal(TURBINE_STATUSES[statusCode(status)].kind, 'planned');
  assert.equal(TURBINE_STATUSES[statusCode('Avslag')].kind, 'rejected');
  assert.equal(
    TURBINE_STATUSES[statusCode('Inte aktuellt eller återkallat')].kind,
    'withdrawn',
  );
  assert.equal(TURBINE_STATUSES[statusCode('Nedmonterat')].kind, 'dismantled');
  assert.equal(TURBINE_STATUSES[statusCode('Uppgift saknas')].kind, 'unknown');
  assert.equal(TURBINE_STATUSES[statusCode('Uppförda')].kind, 'built');
  assert.equal(TURBINE_STATUSES[statusCode('Avslagna')].kind, 'rejected');
  assert.equal(
    TURBINE_STATUSES[statusCode('Inte aktuella eller återkallade')].kind,
    'withdrawn',
  );
  assert.equal(TURBINE_STATUSES[statusCode('Något nytt')].kind, 'unknown');
  assert.equal(statusIndex('Något nytt'), -1);
  assert.equal(statusIndex(' Handläggs '), 2);
});

test('only a legal person’s organisation number keeps the operator', () => {
  assert.equal(isLegalPersonNumber('556677-8899'), true);
  assert.equal(isLegalPersonNumber('969612-3456'), true, 'a partnership');
  assert.equal(isLegalPersonNumber('212000-2627'), true, 'a municipality');
  assert.equal(isLegalPersonNumber('165566778899'), true);
  assert.equal(isLegalPersonNumber('5566778899'), true);
  // A sole trader's number is a personal identity number: month 01–12.
  assert.equal(isLegalPersonNumber('550101-1234'), false);
  assert.equal(isLegalPersonNumber('551231-1234'), false);
  assert.equal(isLegalPersonNumber('550101-xxxx'), false, 'masked');
  assert.equal(isLegalPersonNumber('556677-889'), false, 'too short');
  assert.equal(isLegalPersonNumber('985612345'), false, 'foreign');
  assert.equal(isLegalPersonNumber('-'), false);
  assert.equal(isLegalPersonNumber(null), false);

  const company = normalizeTurbine(ROW, XY);
  assert.equal(company.operator, 'Exempel Vind AB');
  const person = normalizeTurbine(
    { ...ROW, ORGNMR: '550101-1234', ORGNAMN: 'Per Persson' },
    XY,
  );
  assert.equal(person.operator, null);
  assert.ok(!JSON.stringify(person).includes('Persson'));
});

test('an operator name is kept only when it is plainly a company’s', () => {
  const ab = '556677-8899';
  assert.equal(operatorName('Exempel Vind AB', ab), 'Exempel Vind AB');
  // The register's placeholder, with its 999999-9999.
  assert.equal(operatorName('Projektör ej registrerad', '999999-9999'), null);
  assert.equal(operatorName('Projektör ej registrerad', ab), null);
  assert.equal(operatorName('Privatperson', ab), null);
  // Trading and limited partnerships, by number and by name.
  assert.equal(operatorName('Exempel Vind', '969612-3456'), null);
  for (const name of [
    'Tackel & Tåg, Per Persson HB',
    'HB Per Persson & Co',
    'EHB Erik Exempel-Blixt HB',
    'Exempel Vind Hb',
    'Exempelby Kommanditbolag',
  ])
    assert.equal(operatorName(name, ab), null, name);
  // People's names, in any company form, and farms.
  for (const name of [
    'Roland Persson Lantbruk AB',
    'Lars Exempelsson Jordbruks AB',
    'Anders Åkeby Konsult AB',
    'Stefan Exempel AB',
    'Johan Vind AB',
    'Exempelgården Magnus o Thomas Exempel',
    'Håkan Exempel AB',
    'Ingemar Exempel AB',
    'Exempelby Gård AB',
    'Exempelby Säteri',
    'Exempelby 1:42 AB',
  ])
    assert.equal(operatorName(name, ab), null, name);
  // A company named after a farm or a place stays.
  assert.equal(
    operatorName('Exempelgården Vind AB', ab),
    'Exempelgården Vind AB',
  );
  assert.equal(operatorName('Bo Norra Vind AB', ab), null, 'strict here');
});

test('a project name that reads as a person’s full name is left out', () => {
  assert.equal(looksLikePersonName('Per Persson vindkraftverk 1'), true);
  assert.equal(looksLikePersonName('Gården, Bengt C'), true);
  assert.equal(looksLikePersonName('Rosenberg W8, Anna Andersson'), true);
  assert.equal(looksLikePersonName('Maria'), false, 'a first name alone');
  assert.equal(looksLikePersonName('Bjälbo Lennart'), false);
  assert.equal(looksLikePersonName('3951 Sven Vind'), false);
  assert.equal(looksLikePersonName('Vindpark Exempelberget'), false);
  assert.equal(looksLikePersonName('Karlskrona Vind'), false);
  assert.equal(looksLikePersonName('PER PERSSON'), true, 'in capitals');
  assert.equal(looksLikePersonName('Per V'), false, 'a Roman numeral');
  assert.equal(looksLikePersonName('Bo Norra'), false);
  assert.equal(looksLikePersonName('Åsa Västra'), false);
  assert.equal(looksLikePersonName('Birger Jarl'), false);
  assert.equal(looksLikePersonName('Birger Persson'), true);
  assert.equal(looksLikePersonName('vind per Gård'), false, 'lower case');
  assert.equal(looksLikePersonName('Johan Vind', { strict: true }), true);
  // Project names: no metering-point ids, no property designations.
  assert.equal(projectName('735999224950737069 Exempelvägen 114'), null);
  assert.equal(projectName('669828001 Exempel'), null);
  for (const name of [
    'Exempelby 2:1',
    'Exempelby 1:14, 1:17',
    'Exempelby 2:5 m.fl',
  ])
    assert.equal(projectName(name), null, name);
  assert.equal(
    projectName('Vindpark Exempelberget 2'),
    'Vindpark Exempelberget 2',
  );
  assert.equal(projectName('  '), null);
  assert.equal(
    normalizeTurbine({ ...ROW, PROJNAMN: 'Per Persson vindkraftverk 1' }, XY)
      .project,
    null,
  );
});

test('a register row keeps only the agreed fields', () => {
  const row = normalizeTurbine(ROW, XY);
  assert.deepEqual(Object.keys(row).sort(), [
    'built',
    'county',
    'hubHeightM',
    'id',
    'kind',
    'make',
    'model',
    'municipality',
    'operator',
    'point',
    'powerMW',
    'productionGWh',
    'project',
    'rotorM',
    'status',
    'totalHeightM',
    'updated',
    'zone',
  ]);
  assert.equal(row.id, '2262-V-004-012');
  assert.equal(row.kind, 'built');
  assert.equal(row.totalHeightM, 200);
  assert.equal(row.hubHeightM, 120);
  assert.equal(row.rotorM, 160);
  assert.equal(row.powerMW, 5.6);
  assert.equal(row.productionGWh, 17.25);
  assert.equal(row.make, 'Vestas');
  assert.equal(row.model, 'V162');
  assert.equal(row.built, '2019-11-01');
  assert.equal(row.updated, '2026-04-02');
  assert.equal(row.zone, 'SE2');
  assert.equal(row.municipality, 'Timrå');
  assert.equal(row.county, 'Västernorrlands län');
  // WGS 84 to 6 decimals, in Sweden.
  const [lon, lat] = row.point;
  assert.ok(lon > 17 && lon < 18 && lat > 62 && lat < 63, `${lon} ${lat}`);
  assert.equal(Math.round(lon * 1e6) / 1e6, lon);
  // Never kept: the organisation number, siting, permit case and limit.
  const text = JSON.stringify(row);
  for (const kept of ['556677-8899', 'Land', 'Tillstånd', '2045'])
    assert.ok(!text.includes(kept), kept);
});

test('dates, zeros and places the register leaves blank are none', () => {
  assert.equal(registerDate('19000101'), null, 'the register’s unknown');
  assert.equal(registerDate(''), null);
  assert.equal(registerDate('20191101'), '2019-11-01');
  assert.equal(registerDate('2019-11-01'), '2019-11-01');
  assert.equal(registerDate('2012-13-01'), null);
  const blank = normalizeTurbine(
    {
      ...ROW,
      UPPFORT: '19000101',
      TOTALHOJD: 0,
      NAVHOJD: null,
      MAXEFFEKT: 0,
      FABRIKAT: '',
      EL_NAMN: '',
    },
    XY,
  );
  assert.equal(blank.built, null);
  assert.equal(blank.totalHeightM, null);
  assert.equal(blank.hubHeightM, null);
  assert.equal(blank.powerMW, null);
  assert.equal(blank.make, null);
  assert.equal(blank.zone, null);
  assert.equal(normalizeTurbine(ROW, [0, 0]), null, 'never sited');
  // Only a built or dismantled turbine has a build year.
  for (const STATUS of ['Inte aktuellt eller återkallat', 'Beviljat', 'Avslag'])
    assert.equal(normalizeTurbine({ ...ROW, STATUS }, XY).built, null, STATUS);
  assert.equal(
    normalizeTurbine({ ...ROW, STATUS: 'Nedmonterat' }, XY).built,
    '2019-11-01',
  );
  assert.equal(normalizeTurbine(ROW, null), null);
  assert.equal(normalizeTurbine({ ...ROW, VERKID: '' }, XY), null);
  assert.equal(biddingZone('Luleå'), 'SE1');
  assert.equal(biddingZone('Malmö'), 'SE4');
  assert.equal(biddingZone('se3'), 'SE3');
  assert.equal(biddingZone('Oslo'), null);
});

test('the latest row wins before places are looked at', () => {
  const rows = normalizeTurbines(
    [
      { ...ROW, STATUS: 'Uppfört', SenasteUpp: '20200101' },
      // Newer, but without a place: its status goes on the placed one's spot.
      { ...ROW, STATUS: 'Nedmonterat', SenasteUpp: '20260101' },
      { ...ROW, VERKID: 'X-1', STATUS: 'Beviljat', SenasteUpp: '20260101' },
    ],
    [XY, [0, 0], [0, 0]],
  );
  assert.deepEqual(
    rows.map((row) => [row.id, row.kind]),
    [['2262-V-004-012', 'dismantled']],
    'a turbine never placed is left out',
  );
  assert.deepEqual(rows[0].point, normalizeTurbine(ROW, XY).point);
});

test('a turbine listed twice keeps its latest row', () => {
  const rows = normalizeTurbines(
    [
      { ...ROW, STATUS: 'Beviljat', SenasteUpp: '20200101' },
      null,
      { ...ROW, SenasteUpp: '20260402' },
      { ...ROW, VERKID: '2262-V-004-013' },
      { ...ROW, VERKID: '2262-V-004-014' },
    ],
    [XY, XY, XY, XY, [0, 0]],
  );
  assert.deepEqual(
    rows.map((row) => [row.id, row.kind]),
    [
      ['2262-V-004-012', 'built'],
      ['2262-V-004-013', 'built'],
    ],
  );
  assert.throws(() => normalizeTurbines(null, []));
});

test('the packed snapshot round-trips and shares its strings', () => {
  const rows = normalizeTurbines(
    [
      ROW,
      {
        ...ROW,
        VERKID: '2262-V-004-013',
        STATUS: 'Avslag',
        UPPFORT: '',
        ORGNMR: '550101-1234',
        TOTALHOJD: null,
        EL_NAMN: 'Malmö',
      },
    ],
    [XY, [621000, 6931000]],
  );
  const packed = packTurbines(rows);
  assert.deepEqual(packed.fields, PACKED_FIELDS);
  assert.equal(packed.strings[0], '');
  assert.equal(
    packed.strings.filter((value) => value === 'Vestas').length,
    1,
    'a make is written once',
  );
  assert.equal(packed.rows[1][PACKED_FIELDS.indexOf('operator')], 0);
  assert.equal(packed.rows[1][PACKED_FIELDS.indexOf('totalHeightM')], 0);
  const back = unpackTurbines(JSON.parse(JSON.stringify(packed)));
  assert.deepEqual(back, rows);
  assert.equal(back[1].kind, 'rejected');
  assert.equal(back[1].zone, 'SE4');
  assert.throws(() => unpackTurbines({ rows: [] }), /Malformed/);
  assert.throws(
    () => unpackTurbines({ ...packed, fields: packed.fields.slice(1) }),
    /no id/,
  );
  // Status numbers are read through the snapshot's own list.
  const reordered = JSON.parse(JSON.stringify(packed));
  reordered.statuses = ['Avslag', 'Uppfört'];
  const at = PACKED_FIELDS.indexOf('status');
  reordered.rows[0][at] = 1;
  reordered.rows[1][at] = 0;
  assert.deepEqual(
    unpackTurbines(reordered).map((row) => row.kind),
    ['built', 'rejected'],
  );
  // A view's rows are compact, and come back as the layer reads them.
  const compact = compactTurbine(back[1]);
  assert.deepEqual(Object.keys(compact).sort(), ['c', 'i', 'n', 'p', 's', 'w']);
  assert.deepEqual(expandTurbine(compact), {
    id: back[1].id,
    point: back[1].point,
    status: back[1].status,
    kind: 'rejected',
    totalHeightM: null,
    powerMW: back[1].powerMW,
    project: back[1].project,
    municipality: back[1].municipality,
  });
  assert.equal(expandTurbine({ i: 'x' }), null);
});

test('chips add kinds to the built ones, and the route reads them', () => {
  assert.deepEqual(kindsOf([]), DEFAULT_TURBINE_KINDS);
  assert.deepEqual(kindsOf(['notCurrent', 'planned']), [
    'built',
    'planned',
    'withdrawn',
    'unknown',
  ]);
  assert.deepEqual(parseKinds('planned,built,nope'), ['built', 'planned']);
  assert.deepEqual(parseKinds(''), ['built']);
  assert.deepEqual(parseKinds('nope'), ['built']);
});

test('a view counts every kind and draws the nearest of those asked for', () => {
  const at = (id, lon, lat, kind, powerMW = 2) => ({
    id,
    point: [lon, lat],
    kind,
    status: 0,
    powerMW,
  });
  const rows = [
    at('a', 17.3, 62.4, 'built', 3),
    at('b', 17.31, 62.4, 'built', 2.5),
    at('c', 17.3, 62.41, 'planned'),
    at('d', 17.3, 62.42, 'rejected'),
    at('e', 19, 64, 'built'),
  ];
  const view = turbinesInView(rows, {
    bbox: [17, 62, 18, 63],
    center: [17.3, 62.4],
    limit: 1,
  });
  assert.equal(view.total, 2);
  assert.equal(view.builtMW, 5.5, 'the built ones only');
  assert.deepEqual(view.counts, {
    built: 2,
    planned: 1,
    dismantled: 0,
    rejected: 1,
    withdrawn: 0,
    unknown: 0,
  });
  assert.deepEqual(
    view.turbines.map((row) => row.id),
    ['a'],
  );
  const wider = turbinesInView(rows, {
    bbox: [17, 62, 18, 63],
    center: [17.3, 62.4],
    kinds: ['built', 'planned'],
  });
  assert.equal(wider.builtMW, 5.5, 'planned power is not added');
  assert.deepEqual(
    wider.turbines.map((row) => row.id),
    ['a', 'b', 'c'],
  );
  const [w, s, e, n] = clipWindBox([10, 55, 24, 69], [17, 62]);
  assert.ok(e - w <= WIND_MAX_SPAN_DEG && n - s <= WIND_MAX_SPAN_DEG);
});

/** A tiny point shapefile and its .dbf, as the county boards' zip has. */
function pointShapefile(points) {
  const shp = new DataView(new ArrayBuffer(100 + points.length * 28));
  shp.setInt32(0, 9994, false);
  points.forEach(([x, y], i) => {
    const at = 100 + i * 28;
    shp.setInt32(at, i + 1, false);
    shp.setInt32(at + 4, 10, false);
    shp.setInt32(at + 8, 1, true);
    shp.setFloat64(at + 12, x, true);
    shp.setFloat64(at + 20, y, true);
  });
  return new Uint8Array(shp.buffer);
}
function dbf(rows, fields) {
  const headerLength = 32 + fields.length * 32 + 1;
  const recordLength = 1 + fields.reduce((sum, f) => sum + f.length, 0);
  const bytes = new Uint8Array(headerLength + rows.length * recordLength);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, rows.length, true);
  view.setUint16(8, headerLength, true);
  view.setUint16(10, recordLength, true);
  const encoder = new TextEncoder();
  fields.forEach((field, i) => {
    bytes.set(encoder.encode(field.name), 32 + i * 32);
    bytes[32 + i * 32 + 11] = field.type.charCodeAt(0);
    bytes[32 + i * 32 + 16] = field.length;
  });
  bytes[headerLength - 1] = 0x0d;
  rows.forEach((row, r) => {
    let at = headerLength + r * recordLength;
    bytes[at++] = 0x20;
    for (const field of fields) {
      const cell = new Uint8Array(field.length).fill(0x20);
      cell.set(
        encoder.encode(String(row[field.name] ?? '')).slice(0, field.length),
      );
      bytes.set(cell, at);
      at += field.length;
    }
  });
  return bytes;
}

test('the build reads point shapes and UTF-8 attributes', () => {
  const points = readShpPoints(pointShapefile([XY, [0, 0]]));
  assert.deepEqual(points, [[...XY], [0, 0]]);
  const records = readDbf(
    dbf(
      [
        { VERKID: ROW.VERKID, STATUS: 'Överklagat', TOTALHOJD: '200' },
        { VERKID: 'x', STATUS: 'Avslag', TOTALHOJD: '' },
      ],
      [
        { name: 'VERKID', type: 'C', length: 20 },
        { name: 'STATUS', type: 'C', length: 40 },
        { name: 'TOTALHOJD', type: 'N', length: 6 },
      ],
    ),
  );
  assert.deepEqual(records, [
    { VERKID: ROW.VERKID, STATUS: 'Överklagat', TOTALHOJD: 200 },
    { VERKID: 'x', STATUS: 'Avslag', TOTALHOJD: null },
  ]);
  const [row] = normalizeTurbines(records, points);
  assert.equal(row.kind, 'planned');
  assert.throws(() => readShpPoints(new Uint8Array(100)), /not a shapefile/);
});

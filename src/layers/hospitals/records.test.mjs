// Hospitals: the snapshot's join of OSM sites and Socialstyrelsen's figures,
// the bands, the ranking and the card.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  dedupeHospitals,
  edBand,
  hospitalColor,
  isHospitalName,
  normalizeHospital,
  rankDepartments,
  HOSPITAL_COLOR,
  NO_FIGURE_COLOR,
} from './records.js';
import { buildHospitalCard, formatMinutes } from './cards.js';

const snapshot = JSON.parse(
  readFileSync(
    new URL(
      '../../data/local_data/se_hospitals/hospitals.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const sheet = JSON.parse(
  readFileSync(
    new URL(
      '../../data/local_data/se_hospitals/akut-2025.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
const national = { ttl2025: 61, tvt2025: 256 };
const statistics = { year: 2025, national };

test('hospital names keep hospitals and drop clinics inside them', () => {
  for (const name of [
    'Södersjukhuset',
    'Lasarettet i Ystad',
    'Malå sjukstuga',
    'Drottning Silvias barnsjukhus',
  ])
    assert.equal(isHospitalName(name), true, name);
  for (const name of [
    'Södersjukhuset Akutmottagning',
    'Närakut Haga',
    'Capio Vårdcentral Stenungsund',
    'Ylitornion terveyskeskus',
    'Ingång C1, Akademiska sjukhuset',
    'Södra sjukhusområdet',
    '',
  ])
    assert.equal(isHospitalName(name), false, name);
});

test('an element becomes a hospital with its centre, or nothing', () => {
  assert.deepEqual(
    normalizeHospital({
      type: 'way',
      id: 7,
      center: { lon: 18.123456, lat: 59.312345 },
      tags: { name: ' Sankt  Görans sjukhus ', operator: 'Capio' },
    }),
    {
      id: 'w7',
      point: [18.12346, 59.31235],
      name: 'Sankt Görans sjukhus',
      operator: 'Capio',
    },
  );
  assert.equal(
    normalizeHospital({ type: 'relation', id: 1, center: { lon: 15, lat: 59 } })
      ?.name,
    undefined,
  );
  assert.equal(
    normalizeHospital(
      { type: 'relation', id: 1, center: { lon: 15, lat: 59 } },
      'Lindesbergs lasarett',
    ).name,
    'Lindesbergs lasarett',
  );
});

test('a site mapped twice is one hospital; a children’s hospital stays', () => {
  const rows = dedupeHospitals(
    [
      { id: 'n1', point: [13.0, 55.588], name: 'Skånes Universitetssjukhus' },
      { id: 'w2', point: [13.0, 55.587], name: 'Skånes Universitetsjukhus Malmö' },
      { id: 'w3', point: [11.96, 57.72], name: 'Östra Sjukhuset' },
      { id: 'n4', point: [11.961, 57.721], name: 'Drottning Silvias barnsjukhus' },
      { id: 'w5', point: [18.3, 57.65], name: 'Visby Lasarett' },
      { id: 'r6', point: [18.3001, 57.65], name: 'Visby lasarett' },
    ],
    new Set(['w2']),
  );
  assert.deepEqual(rows.map((row) => row.id).sort(), ['n4', 'r6', 'w2', 'w3']);
});

test('bands compare a department with the national median', () => {
  const row = (ttl) => ({ ed: { ttl2025: ttl } });
  assert.equal(edBand(row(45), 'ttl', statistics), 'shorter');
  assert.equal(edBand(row(61), 'ttl', statistics), 'near');
  assert.equal(edBand(row(70), 'ttl', statistics), 'near');
  assert.equal(edBand(row(71), 'ttl', statistics), 'longer');
  assert.equal(edBand({ ed: { ttl2025: null } }, 'ttl', statistics), null);
  assert.equal(hospitalColor({ ed: {} }, 'ttl', statistics), NO_FIGURE_COLOR);
  assert.equal(hospitalColor({}, 'ttl', statistics), HOSPITAL_COLOR);
});

test('the nearest list takes every department; the shortest needs a figure in view', () => {
  const rows = [
    { id: 'a', point: [18.0, 59.3], ed: { ttl2025: 80 } },
    { id: 'b', point: [18.1, 59.3], ed: { ttl2025: null } },
    { id: 'c', point: [18.5, 59.3], ed: { ttl2025: 30 } },
    { id: 'd', point: [18.01, 59.3] },
    { id: 'e', point: [20.0, 59.3], ed: { ttl2025: 10 } },
  ];
  const center = [18.0, 59.3];
  assert.deepEqual(
    rankDepartments(rows, { center, statistics, limit: 3 }).map(({ row }) => row.id),
    ['a', 'b', 'c'],
  );
  assert.deepEqual(
    rankDepartments(rows, {
      center,
      statistics,
      bbox: [17.5, 59, 19, 59.6],
      order: 'shortest',
    }).map(({ row }) => row.id),
    ['c', 'a'],
  );
});

test('medians read as minutes, from two hours as hours and minutes', () => {
  assert.equal(formatMinutes(61), '61 min');
  assert.equal(formatMinutes(119), '119 min');
  assert.equal(formatMinutes(120), '2 h');
  assert.equal(formatMinutes(256), '4 h 16 min');
  assert.equal(formatMinutes(null), '');
});

test('the card gives the figures, the comparison and where to call', () => {
  const card = buildHospitalCard(
    {
      id: 'w1',
      name: 'Södersjukhuset',
      point: [18.05, 59.31],
      ed: {
        department: 'Södersjukhuset',
        visits2024: 80000,
        visits2025: 82920,
        ttl2024: 81,
        ttl2025: 78,
        tvt2024: 331,
        tvt2025: 324,
      },
    },
    { metric: 'ttl', statistics },
  );
  assert.equal(card.title, 'EMERGENCY · Södersjukhuset');
  assert.ok(card.details.includes('Time to physician: 78 min (2024: 81 min)'));
  assert.ok(card.details.includes('Visits 2025: 82,920 (+4 % on 2024)'));
  assert.ok(card.details.includes('Life-threatening: call 112 · Advice: 1177'));
  const other = buildHospitalCard({ id: 'w2', name: 'Ersta sjukhus' });
  assert.equal(other.title, 'HOSPITAL · Ersta sjukhus');
  assert.ok(
    other.details.includes(
      'Not in Socialstyrelsen’s emergency statistics; see 1177',
    ),
  );
});

test('the bundled snapshot carries every department in the sheet', () => {
  const departments = new Set(
    snapshot.hospitals.filter((row) => row.ed).map((row) => row.ed.department),
  );
  assert.equal(sheet.departments.length, 62);
  for (const { name } of sheet.departments)
    assert.ok(departments.has(name), name);
  assert.deepEqual(snapshot.statistics.national, national);
  assert.equal(snapshot.statistics.year, 2025);
  assert.equal(snapshot.statistics.published, sheet.published);
  assert.match(sheet.published, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(snapshot.license, 'ODbL-1.0');
  for (const row of snapshot.hospitals) {
    assert.match(row.id, /^[nwr]\d+$/);
    assert.ok(Number.isFinite(row.height), row.name);
    const [lon, lat] = row.point;
    assert.ok(lon > 10.5 && lon < 24.2 && lat > 55 && lat < 69.2, row.name);
  }
  // Spot checks against the appendix of art.nr 2026-6-10339.
  const byDepartment = Object.fromEntries(
    sheet.departments.map((row) => [row.name, row]),
  );
  assert.deepEqual(
    [
      byDepartment['Danderyds sjukhus'].visits2025,
      byDepartment['Danderyds sjukhus'].ttl2025,
      byDepartment['Danderyds sjukhus'].tvt2025,
    ],
    [93631, 41, 306],
  );
  assert.equal(byDepartment['Västmanlands sjukhus Västerås'].ttl2025, null);
  // Alingsås and Kungälv report together, so both carry the shared figures.
  for (const id of ['w206662524', 'w585734883']) {
    const { ed } = snapshot.hospitals.find((row) => row.id === id);
    assert.equal(ed.department, 'Sjukhusen i väster');
    assert.equal(ed.shared, true);
  }
});

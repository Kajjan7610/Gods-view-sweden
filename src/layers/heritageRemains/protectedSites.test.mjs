// World Heritage sites and protected buildings: what is kept of RAÄ's
// features, and above all what never is.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AREA_RING_POINTS,
  PROTECTED_BUILDINGS_FILTER,
  areasInView,
  buildingPage,
  normalizeAll,
  normalizeBuilding,
  normalizeProtectionArea,
  normalizeWorldSite,
  protectionOf,
  unescoPage,
} from './records.js';

const square = (lon, lat, d = 0.001) => [
  [lon, lat],
  [lon + d, lat],
  [lon + d, lat + d],
  [lon, lat + d],
  [lon, lat],
];

const building = (overrides = {}) => ({
  type: 'Feature',
  geometry: { type: 'MultiPolygon', coordinates: [[square(16.546, 59.612)]] },
  properties: {
    id: 'B0000000-0000-4000-8000-000000000001',
    bebyggelsenummer: 'B2024:616',
    namn: 'Västerås domkyrka',
    objekttyp_namn: 'Byggnad',
    skyddstyp_id: 'x',
    skyddstyp_namn: 'Kyrkligt kulturminne',
    beslutsdatum: '1999-05-01',
    registerbyggnad_id: '403443fc-6850-4f13-ae0e-c12208ea29e4',
    klassificering: 'Grönt',
    nybyggnad_tillkomstar_from: 1271,
    nybyggnad_tillkomstar_tom: 1517,
    andamal_huvudkategori: 'Religion',
    andamal_underkategori: 'Kyrka',
    lansnamn: 'Västmanland',
    kommunnamn: 'Västerås',
    stomme_material: 'Tegel',
    url: 'https://pub.raa.se/visa/objekt/bebyggelse/b0000000-0000-4000-8000-000000000001',
    ...overrides,
  },
});

test('the filter asks RAÄ for the three protections only', () => {
  assert.equal(
    PROTECTED_BUILDINGS_FILTER,
    "skyddstyp_namn = 'Byggnadsminne' OR skyddstyp_namn = 'Statligt byggnadsminne' OR skyddstyp_namn = 'Kyrkligt kulturminne'",
  );
  assert.equal(protectionOf('Byggnadsminne'), 'bm');
  assert.equal(protectionOf(' statligt  byggnadsminne '), 'sbm');
  for (const other of [
    'Identifierat kulturvärde',
    'Förstört kulturvärde',
    'Anmälningsplikt',
    '',
    null,
  ])
    assert.equal(protectionOf(other), null, String(other));
});

test('a protected building keeps its protection, years, purpose and page, nothing more', () => {
  assert.deepEqual(normalizeBuilding(building()), {
    id: 'b0000000-0000-4000-8000-000000000001',
    point: [16.5465, 59.6125],
    name: 'Västerås domkyrka',
    protection: 'kk',
    decided: 1999,
    built: { from: 1271, to: 1517 },
    purpose: 'Kyrka',
    municipality: 'Västerås',
    page: 'https://pub.raa.se/visa/objekt/bebyggelse/b0000000-0000-4000-8000-000000000001',
  });
});

test('an unprotected building is never kept, whatever RAÄ answers', () => {
  for (const skyddstyp_namn of [
    'Identifierat kulturvärde',
    'Förstört kulturvärde',
    'Anmälningsplikt',
    null,
  ])
    assert.equal(normalizeBuilding(building({ skyddstyp_namn })), null);
  const rows = normalizeAll(
    [
      building(),
      building({
        id: 'b0000000-0000-4000-8000-000000000002',
        skyddstyp_namn: 'Identifierat kulturvärde',
      }),
      building(),
    ],
    normalizeBuilding,
  );
  assert.equal(rows.length, 1, 'one protected building, once');
});

test('a building keeps a single year, and drops a foreign page or bad years', () => {
  const row = normalizeBuilding(
    building({
      nybyggnad_tillkomstar_from: 1880,
      nybyggnad_tillkomstar_tom: null,
      andamal_underkategori: '',
      beslutsdatum: 'okänt',
      url: 'https://example.com/visa/objekt/bebyggelse/b0000000-0000-4000-8000-000000000001',
    }),
  );
  assert.deepEqual(row.built, { from: 1880, to: 1880 });
  assert.equal(row.purpose, 'Religion');
  assert.equal(row.decided, null);
  assert.equal(row.page, null);
  assert.equal(buildingPage('javascript:alert(1)'), null);
  assert.deepEqual(
    normalizeBuilding(building({ nybyggnad_tillkomstar_from: 99999 })).built,
    { from: 1517, to: 1517 },
  );
});

test('a protection area keeps a thinned outline; a lifted protection is left out', () => {
  const ring = Array.from({ length: 500 }, (_, i) => [
    16.5 + 0.01 * Math.cos((i / 500) * 2 * Math.PI),
    59.6 + 0.005 * Math.sin((i / 500) * 2 * Math.PI),
  ]);
  const feature = (props) => ({
    type: 'Feature',
    geometry: {
      type: 'MultiPolygon',
      coordinates: [[[...ring, ring[0]], square(16.5, 59.6, 0.001)]],
    },
    properties: {
      id: 'a1',
      namn: 'Västerås slott',
      skyddstyp_namn: 'Statligt byggnadsminne',
      havt_skydd: false,
      beslutsdatum: '1935-01-01',
      tillkomstar_from: 1540,
      kommunnamn: 'Västerås',
      ...props,
    },
  });
  const area = normalizeProtectionArea(feature({}));
  assert.equal(area.protection, 'sbm');
  assert.equal(area.rings.length, 1, 'holes are left out');
  assert.equal(area.rings[0].length, AREA_RING_POINTS);
  assert.deepEqual(area.built, { from: 1540, to: 1540 });
  assert.equal(normalizeProtectionArea(feature({ havt_skydd: true })), null);
  assert.equal(
    normalizeProtectionArea(
      feature({ skyddstyp_namn: 'Enskilt byggnadsminne' }),
    ).protection,
    'bm',
  );
  assert.equal(
    normalizeProtectionArea(
      feature({ skyddstyp_namn: 'Identifierat kulturvärde' }),
    ),
    null,
  );
  const [shown] = areasInView([area], {
    bbox: [16.49, 59.59, 16.495, 59.6],
    center: [16.49, 59.59],
  });
  assert.equal(shown.id, 'a1', 'an area touching the view is shown');
  assert.equal('box' in shown, false);
  assert.deepEqual(
    areasInView([area], { bbox: [17, 60, 17.1, 60.1], center: [17, 60] }),
    [],
  );
});

test('a World Heritage site keeps its names, year, UNESCO page and outlines', () => {
  const site = normalizeWorldSite({
    type: 'Feature',
    id: 'varldsarv_sverige.1',
    geometry: {
      type: 'MultiPolygon',
      coordinates: [[square(15.98, 59.97, 0.02)], [square(16.5, 60, 0.001)]],
    },
    properties: {
      id: 'SE:556',
      sitename_sve: 'Engelsbergs bruk',
      sitename_eng: 'Engelsberg Ironworks',
      legalfoundationyear: 1993,
      legalfoundationdocument: 'https://whc.unesco.org/en/decisions/1',
      unesco_href: 'http://whc.unesco.org/en/list/556',
    },
  });
  assert.deepEqual(site, {
    id: 'se_556',
    point: [15.99, 59.98],
    rings: [
      square(15.98, 59.97, 0.02).slice(0, 4),
      square(16.5, 60, 0.001).slice(0, 4),
    ],
    nameSv: 'Engelsbergs bruk',
    nameEn: 'Engelsberg Ironworks',
    inscribed: 1993,
    unesco: 'https://whc.unesco.org/en/list/556',
    schematic: false,
  });
  assert.equal(unescoPage('https://evil.example/whc.unesco.org'), null);
});

test("Struve's arc is marked schematic; a site of points still gets a dot", () => {
  const site = normalizeWorldSite({
    type: 'Feature',
    geometry: {
      type: 'MultiPoint',
      coordinates: [
        [23.5, 66.0],
        [23.7, 67.0],
      ],
    },
    properties: {
      fid: 7,
      sitename_sve: 'Struves meridianbåge',
      sitename_eng: 'Struve Geodetic Arc',
      legalfoundationyear: 2005,
    },
  });
  assert.equal(site.schematic, true);
  assert.deepEqual(site.point, [23.6, 66.5]);
  assert.deepEqual(site.rings, []);
});

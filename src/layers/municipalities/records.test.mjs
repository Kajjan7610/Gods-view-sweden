// Municipalities: shared-line geometry, lookups, the card and the snapshot.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  areaAt,
  decodeLine,
  encodeLine,
  hasLength,
  indexAreas,
  ringPoints,
  ringsContain,
  shortMunicipalityName,
  simplifyLine,
} from './records.js';
import {
  buildMunicipalityCard,
  formatPopulationDate,
  yearChange,
} from './cards.js';

const snapshot = JSON.parse(
  readFileSync(
    new URL(
      '../../data/local_data/se_municipalities/municipalities.json',
      import.meta.url,
    ),
    'utf8',
  ),
);

test('lines round-trip through the delta encoding', () => {
  const line = [
    [16.54637, 59.6111],
    [16.5501, 59.60002],
    [16.4, 59.7],
  ];
  assert.deepEqual(decodeLine(encodeLine(line)), line);
});

test('simplifying keeps both ends and drops points within the tolerance', () => {
  const line = [
    [16, 59],
    [16.001, 59.00001],
    [16.002, 59],
    [16.003, 59.01],
    [16.004, 59],
  ];
  const simple = simplifyLine(line, 25);
  assert.deepEqual(simple[0], line[0]);
  assert.deepEqual(simple.at(-1), line.at(-1));
  assert.ok(!simple.some((p) => p[0] === 16.001), 'a 1 m wiggle goes');
  assert.ok(
    simple.some((p) => p[0] === 16.003),
    'a 1 km spike stays',
  );
});

test('a line has length only when two of its points differ', () => {
  assert.equal(hasLength([]), false);
  assert.equal(hasLength([[16, 59]]), false);
  assert.equal(
    hasLength([
      [16, 59],
      [16, 59],
    ]),
    false,
    'one point twice goes nowhere',
  );
  assert.equal(
    hasLength([
      [16, 59],
      [16, 59],
      [16.1, 59],
    ]),
    true,
  );
});

test('areas walk shared lines both ways and find the point inside', () => {
  // Two squares side by side sharing the line x = 1.
  const lines = [
    [
      [1, 0],
      [1, 1],
    ],
    [
      [1, 1],
      [0, 1],
      [0, 0],
      [1, 0],
    ],
    [
      [1, 1],
      [2, 1],
      [2, 0],
      [1, 0],
    ],
  ];
  const west = { code: 'W', rings: [[1, 2]] };
  const east = { code: 'E', rings: [[-1, 3]] };
  assert.equal(ringPoints([-1, 3], lines).length, 5);
  const index = indexAreas([west, east], lines);
  assert.equal(areaAt(index, [0.5, 0.5]), west);
  assert.equal(areaAt(index, [1.5, 0.5]), east);
  assert.equal(areaAt(index, [3, 0.5]), null);
  assert.equal(
    ringsContain(
      [
        ringPoints([1, 2], lines),
        [
          [0.2, 0.2],
          [0.8, 0.2],
          [0.8, 0.8],
          [0.2, 0.8],
        ],
      ],
      [0.5, 0.5],
    ),
    false,
    'a hole is outside',
  );
});

test('names, dates and changes read as people expect', () => {
  assert.equal(shortMunicipalityName('Västerås kommun'), 'Västerås');
  assert.equal(formatPopulationDate('2026M08'), 'Aug 31, 2026');
  assert.equal(formatPopulationDate('2026'), '');
  assert.equal(yearChange(161947, 161261), '+0.4');
  assert.equal(yearChange(22393, 22420), '−0.1');
  assert.equal(yearChange(100, null), '');
  const card = buildMunicipalityCard(
    {
      code: '1980',
      name: 'Västerås',
      county: '19',
      population: 161947,
      populationYearAgo: 161261,
    },
    {
      county: { code: '19', name: 'Västmanlands län', population: 281188 },
      populationPeriod: '2026M08',
    },
  );
  assert.equal(card.title, 'MUNICIPALITY · Västerås');
  assert.ok(
    card.details.includes(
      '161,947 people (+0.4 % in a year) on Aug 31, 2026',
    ),
  );
  assert.ok(card.details.includes('Municipality code 1980'));
});

test('the bundled snapshot has every municipality and county, closed and populated', () => {
  assert.equal(snapshot.municipalities.length, 290);
  assert.equal(snapshot.counties.length, 21);
  assert.equal(snapshot.license, 'ODbL-1.0');
  assert.match(snapshot.populationPeriod, /^\d{4}M\d{2}$/);
  const lines = snapshot.lines.map((line) => decodeLine(line.p));
  const counties = new Set(snapshot.counties.map((county) => county.code));
  for (const area of [...snapshot.counties, ...snapshot.municipalities]) {
    assert.ok(area.population > 0, area.name);
    for (const ring of area.rings) {
      const points = ringPoints(ring, lines);
      assert.deepEqual(points[0], points.at(-1), `${area.name} ring closes`);
    }
  }
  for (const municipality of snapshot.municipalities) {
    assert.match(municipality.code, /^\d{4}$/);
    assert.ok(counties.has(municipality.county), municipality.name);
  }
  // Each municipality's label lies in it, and the lookup finds it there.
  const index = indexAreas(snapshot.municipalities, lines);
  for (const municipality of snapshot.municipalities)
    assert.equal(
      areaAt(index, municipality.label)?.code,
      municipality.code,
      municipality.name,
    );
  // Simplifying leaves a handful of lines as one point twice. Rings still
  // walk them (they closed above); the layer skips them when drawing.
  const pointless = lines.filter((points) => !hasLength(points));
  assert.ok(pointless.length < 10, `${pointless.length} lines go nowhere`);
  const total = snapshot.municipalities.reduce(
    (sum, row) => sum + row.population,
    0,
  );
  assert.ok(total > 10_000_000 && total < 11_500_000, `Sweden: ${total}`);
});

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  INCIDENT_KINDS,
  incidentKind,
  normalizeDeviation,
  normalizeRoadCondition,
  normalizeRoadSnapshot,
  parseWkt,
  simplifyLine,
} from './records.js';

const NOW = Date.parse('2026-11-04T08:00:00+01:00');

// Shaped like live RoadCondition 1.3 and Situation 1.6 records.
const CONDITION = {
  Id: 'RC-1',
  ConditionCode: 3,
  ConditionText: 'Mycket besvärligt',
  ConditionInfo: ['Snömodd'],
  Warning: ['Halka'],
  Measure: ['Plogning pågår'],
  RoadNumber: 'Väg 45',
  LocationText: 'Mora - Älvdalen',
  StartTime: '2026-11-04T05:00:00+01:00',
  Geometry: {
    WGS84:
      'LINESTRING (14.5370 61.0070, 14.5371 61.0071, 14.4500 61.1000, 14.2600 61.2300)',
  },
};
const DEVIATION = {
  Id: 'SE_STA_TRISSID_1_123',
  MessageType: 'Olycka',
  MessageCode: 'Trafikolycka',
  Header: 'Trafikolycka',
  Message: 'Olycka med två personbilar, ett körfält avstängt.',
  SeverityCode: 4,
  SeverityText: 'Stor påverkan',
  RoadNumber: 'E4',
  LocationDescriptor: 'E4 från Trafikplats Häggvik till Trafikplats Rotebro',
  TrafficRestrictionType: 'Körfält avstängt',
  StartTime: '2026-11-04T07:40:00+01:00',
  EndTime: '2026-11-04T09:30:00+01:00',
  WebLink: 'https://www.trafikverket.se/trafikinformation/vag/',
  Geometry: { Point: { WGS84: 'POINT (17.9311 59.4342)' } },
};

test('WKT points, lines and multilines parse; junk does not', () => {
  assert.deepEqual(parseWkt('POINT (17.93 59.43)'), {
    point: [17.93, 59.43],
    lines: [],
  });
  assert.equal(parseWkt('LINESTRING (1 2, 3 4)').lines.length, 1);
  assert.deepEqual(
    parseWkt(
      'MULTILINESTRING ((14 60, 14.1 60.1), (15 61, 15.1 61.1, 15.2 61.2))',
    ).lines.map((line) => line.length),
    [2, 3],
  );
  assert.deepEqual(parseWkt('POINT Z (17 59 12)').point, [17, 59]);
  assert.deepEqual(parseWkt('POLYGON ((0 0, 1 1, 1 0, 0 0))'), {
    point: null,
    lines: [],
  });
  assert.deepEqual(parseWkt(undefined), { point: null, lines: [] });
});

test('simplification drops near-duplicate vertices and keeps the ends', () => {
  const line = [
    [14.537, 61.007],
    [14.5371, 61.0071], // ~13 m from the first
    [14.45, 61.1],
    [14.26, 61.23],
  ];
  assert.deepEqual(simplifyLine(line), [
    [14.537, 61.007],
    [14.45, 61.1],
    [14.26, 61.23],
  ]);
  const long = Array.from({ length: 2000 }, (_, i) => [14 + i * 0.01, 60]);
  const thinned = simplifyLine(long);
  assert.equal(thinned.length, 400);
  assert.deepEqual(thinned[0], [14, 60]);
  assert.deepEqual(thinned.at(-1), [33.99, 60]);
});

test('a RoadCondition becomes a drawable stretch', () => {
  const row = normalizeRoadCondition(CONDITION);
  assert.equal(row.id, 'RC-1');
  assert.equal(row.code, 3);
  assert.equal(row.text, 'Mycket besvärligt');
  assert.deepEqual(row.warnings, ['Halka']);
  assert.equal(row.road, 'Väg 45');
  assert.equal(row.lines[0].length, 3);
  assert.equal(normalizeRoadCondition({ ...CONDITION, Deleted: true }), null);
  assert.equal(normalizeRoadCondition({ ...CONDITION, Geometry: {} }), null);
});

test('a current Deviation becomes an incident; future, past and suspended do not', () => {
  const row = normalizeDeviation(DEVIATION, NOW);
  assert.equal(row.kind, 'accident');
  assert.equal(row.severity, 4);
  assert.deepEqual(row.point, [17.9311, 59.4342]);
  assert.equal(row.link, 'https://www.trafikverket.se/trafikinformation/vag/');
  assert.equal(
    normalizeDeviation(
      { ...DEVIATION, StartTime: '2026-11-04T12:00:00+01:00' },
      NOW,
    ),
    null,
  );
  assert.equal(
    normalizeDeviation(
      { ...DEVIATION, EndTime: '2026-11-04T07:50:00+01:00' },
      NOW,
    ),
    null,
  );
  assert.ok(
    normalizeDeviation(
      {
        ...DEVIATION,
        EndTime: '2026-11-04T07:50:00+01:00',
        ValidUntilFurtherNotice: true,
      },
      NOW,
    ),
  );
  assert.equal(
    normalizeDeviation({ ...DEVIATION, Suspended: true }, NOW),
    null,
  );
  assert.equal(
    normalizeDeviation({ ...DEVIATION, WebLink: 'javascript:alert(1)' }, NOW)
      .link,
    null,
  );
});

test('a line-only roadwork anchors its dot on the line', () => {
  const row = normalizeDeviation(
    {
      ...DEVIATION,
      Id: 'RW-1',
      MessageType: 'Vägarbete',
      Geometry: { Line: { WGS84: 'LINESTRING (18 59, 18.1 59.1, 18.2 59.2)' } },
    },
    NOW,
  );
  assert.equal(row.kind, 'roadwork');
  assert.deepEqual(row.point, [18.1, 59.1]);
  assert.equal(row.lines.length, 1);
});

test('message types map to legend kinds', () => {
  assert.equal(incidentKind('Olycka').id, 'accident');
  assert.equal(incidentKind('Vägarbete').id, 'roadwork');
  assert.equal(incidentKind('Hinder').id, 'obstacle');
  assert.equal(incidentKind('Restriktion').id, 'restriction');
  assert.equal(incidentKind('Viktig trafikinformation').id, 'important');
  assert.equal(incidentKind('Trafikmeddelande').id, 'message');
  assert.equal(incidentKind('Färjor').id, 'ferry');
  assert.equal(incidentKind('Något nytt').id, 'other');
});

test('message codes split closures, routine roadwork notices and hazards', () => {
  // Codes as they appear in the live feed (2026-11-04).
  assert.equal(
    incidentKind('Trafikmeddelande', 'Vägen avstängd').id,
    'closure',
  );
  assert.equal(incidentKind('Vägarbete', 'Vägen avstängd').id, 'closure');
  assert.equal(incidentKind('Olycka', 'Vägen avstängd').id, 'accident');
  for (const code of [
    'Hastighetsbegränsning gäller',
    'Körfältsavstängningar',
    'Omkörning förbjuden',
    'Viktbegränsning gäller',
  ])
    assert.equal(incidentKind('Trafikmeddelande', code).id, 'minor', code);
  for (const code of ['Fordonshaveri', 'Djur på vägen', 'Vägskada'])
    assert.equal(incidentKind('Trafikmeddelande', code).id, 'obstacle', code);
  assert.equal(incidentKind('Trafikmeddelande', 'Något annat').id, 'message');
  // Only traffic messages are demoted: a roadwork keeps its own kind.
  assert.equal(
    incidentKind('Vägarbete', 'Hastighetsbegränsning gäller').id,
    'roadwork',
  );
});

test('no incident colour is blue, which belongs to ice and snow', () => {
  for (const kind of INCIDENT_KINDS) {
    const [r, g, b] = kind.color
      .slice(1)
      .match(/../g)
      .map((hex) => parseInt(hex, 16));
    const bluish = b > 150 && b > r + 40 && b > g + 10;
    assert.equal(bluish, false, `${kind.id} ${kind.color}`);
  }
});

test('the two-query answer normalizes; an ERROR result throws', () => {
  const snapshot = normalizeRoadSnapshot(
    {
      RESPONSE: {
        RESULT: [
          { RoadCondition: [CONDITION, { Id: 'broken' }] },
          {
            Situation: [
              { Id: 'S1', Deviation: [DEVIATION, DEVIATION] },
              {
                Id: 'S2',
                Deleted: true,
                Deviation: [{ ...DEVIATION, Id: 'X' }],
              },
            ],
          },
        ],
      },
    },
    NOW,
  );
  assert.equal(snapshot.conditions.length, 1);
  assert.equal(snapshot.incidents.length, 1, 'duplicates and deleted dropped');
  assert.throws(
    () =>
      normalizeRoadSnapshot(
        {
          RESPONSE: {
            RESULT: [
              {
                ERROR: {
                  SOURCE: 'Security',
                  MESSAGE: 'Invalid authentication',
                },
              },
            ],
          },
        },
        NOW,
      ),
    (error) =>
      error.status === 401 && /Invalid authentication/.test(error.message),
  );
});

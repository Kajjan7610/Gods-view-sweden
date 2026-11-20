// Naturvårdsverket's trails and facilities: SWEREF 99 TM to degrees, the
// legend classes, no residences, and the per-view answer.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_TRAILS,
  areaName,
  clipLine,
  decodeLine,
  facilityClass,
  joinLines,
  linesBounds,
  normalizeFacilities,
  normalizeFacility,
  normalizeTrail,
  normalizeTrails,
  outdoorInView,
  packFacility,
  packTrail,
  shorten,
  statedLengthKm,
  toLonLat,
  trailClass,
  unpackFacility,
  unpackTrail,
  withoutContacts,
} from './records.js';

const near = (actual, expected, tolerance = 1e-4) =>
  assert.ok(
    Math.abs(actual - expected) < tolerance,
    `${actual} is not ${expected}`,
  );

test('SWEREF 99 TM in either axis order, and degrees, come out as lon, lat', () => {
  const [lon, lat] = toLonLat([500000, 6650000]);
  near(lon, 15, 1e-5);
  near(lat, 59.98, 0.01);
  assert.deepEqual(toLonLat([6650000, 500000]), [lon, lat], 'northing first');
  assert.deepEqual(toLonLat([16.5, 59.6]), [16.5, 59.6]);
  assert.deepEqual(toLonLat([59.6, 16.5]), [16.5, 59.6], 'lat first');
  assert.equal(toLonLat([2.35, 48.85]), null, 'Paris is not in Sweden');
  assert.equal(toLonLat(['x', 1]), null);
});

test('the some 70 facility types fall into a handful of classes', () => {
  assert.equal(facilityClass('Vindskydd', null), 'shelter');
  assert.equal(facilityClass('Byggnad', 'Raststuga'), 'shelter');
  assert.equal(facilityClass('Övernattningsstuga', null), 'shelter');
  assert.equal(facilityClass('Kåta', null), 'shelter');
  assert.equal(facilityClass('Eldstad', null), 'fire');
  assert.equal(facilityClass('Tältplats', null), 'fire');
  assert.equal(facilityClass('Dass', null), 'toilet');
  assert.equal(facilityClass('Utsiktstorn', null), 'view');
  assert.equal(facilityClass('Informationstavla', null), 'view');
  assert.equal(
    facilityClass('Parkering', 'Parkering för rörelsehindrade'),
    'access',
  );
  assert.equal(facilityClass('Brygga', null), 'access');
  assert.equal(facilityClass('Spång', null), 'structure');
  assert.equal(facilityClass('Något nytt', null), 'other');
  assert.equal(trailClass('Vandringsled'), 'hike');
  assert.equal(trailClass('Naturstig'), 'nature');
  assert.equal(trailClass('Skidled'), 'ski');
  assert.equal(trailClass('Skoterled'), 'snowmobile');
  assert.equal(trailClass('Kanotled'), 'paddle');
  assert.equal(trailClass('Cykelled'), 'cycleRide');
  assert.equal(trailClass(null, null), 'other');
});

const facility = (props, coordinates = [600000, 6640000]) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates },
  properties: props,
});

test('a facility keeps what the card shows; a residence is left out', () => {
  const row = normalizeFacility(
    facility({
      ANORD_ID: 4711,
      ANORD_NAMN: 'Vindskyddet vid sjön',
      TYP: 'Vindskydd',
      UNDERTYP: null,
      BESKRIVN: 'Ett vindskydd med eldstad och ved. '.repeat(10),
      SKOMRDE: 'Tyresta',
      STATLED: 'Nej',
      kommun: 'Haninge',
    }),
  );
  assert.equal(row.id, '4711');
  assert.equal(row.kind, 'shelter');
  assert.equal(row.area, 'Tyresta');
  assert.equal(row.stateTrail, false);
  assert.ok(row.description.endsWith('…'));
  assert.ok(row.description.length <= 181);
  assert.equal(
    normalizeFacility(facility({ ANORD_ID: 1, TYP: 'Bostad' })),
    null,
  );
  assert.equal(
    normalizeFacility(
      facility({ ANORD_ID: 2, TYP: 'Byggnad', UNDERTYP: 'Bostad' }),
    ),
    null,
  );
  assert.equal(
    normalizeFacility(
      facility({
        ANORD_ID: 3,
        TYP: 'Parkering',
        UNDERTYP: 'Parkering för rörelsehindrade',
      }),
    ).accessible,
    true,
  );
  assert.equal(
    normalizeFacility(facility({ ANORD_ID: 4, TYP: 'Dass' }, [1, 2])),
    null,
    'no place in Sweden',
  );
  assert.equal(
    normalizeFacilities([
      facility({ ANORD_ID: 5, TYP: 'Dass' }),
      facility({ ANORD_ID: 5, TYP: 'Dass' }),
    ]).length,
    1,
  );
  assert.throws(() => normalizeFacilities(null), /Malformed/);
});

const trail = (props, coordinates) => ({
  type: 'Feature',
  geometry: { type: 'MultiLineString', coordinates },
  properties: props,
});
const LINE = [
  [600000, 6640000],
  [601000, 6640000],
  [602000, 6641000],
];

test('a trail keeps its lines in degrees and its length', () => {
  const row = normalizeTrail(
    trail(
      {
        L_ID: 'A-12',
        LNAMN: 'Sörmlandsleden',
        LTYP: 'Vandringsled',
        LMARKERING: 'Orange',
        LLANGD: 2.4,
        SKOMRDE: 'Tyresta',
      },
      [LINE],
    ),
  );
  assert.equal(row.id, 'lA-12');
  assert.equal(row.kind, 'hike');
  assert.equal(row.marking, 'Orange');
  assert.equal(row.lengthKm, 2.4);
  assert.equal(row.lines.length, 1);
  assert.equal(row.lines[0].length, 3);
  assert.ok(row.lines[0].every(([lon, lat]) => lon > 16 && lat > 59));
  assert.equal(normalizeTrail(trail({ L_ID: 1 }, [[[1, 2]]])), null);
});

test('a stated length is read as kilometres or metres, whichever fits the drawn lines', () => {
  assert.equal(statedLengthKm(2400, null), 2.4);
  assert.equal(statedLengthKm(12, 11.6), 12);
  assert.equal(statedLengthKm(800, 0.79), 0.8);
  assert.equal(statedLengthKm('3,5', 3.4), 3.5);
  assert.equal(statedLengthKm('', 3), null);
});

test('a state trail LED already holds is kept once, marked as a state trail', () => {
  const props = { L_ID: 7, LNAMN: 'Kungsleden', LTYP: 'Vandringsled' };
  const rows = normalizeTrails(
    [trail(props, [LINE])],
    [
      trail(props, [LINE]),
      trail({ L_ID: 8, LNAMN: 'Nordkalottleden' }, [LINE]),
    ],
  );
  assert.deepEqual(
    rows.map((row) => [row.id, row.stateTrail]),
    [
      ['l7', true],
      ['s8', true],
    ],
  );
});

test('the nightly GeoJSON names are read, and the real types fall into their classes', () => {
  const row = normalizeFacility(
    facility({
      OBJECTID: 1,
      ANORDNING_ID: '30582292',
      ANORDNINGNAMN: 'Parkering, Hammarberget',
      TYP: 'Information',
      UNDERTYP: 'Områdesskyddsinformation',
      BESKRIVNING: 'Skylt vid entrén.',
      SKYDDATOMRADE: 'Hammarberget (2026369)',
      STATLIGLED: 'Abisko - Abiskojaure (BD 21)',
    }),
  );
  assert.equal(row.id, '30582292');
  assert.equal(row.name, 'Parkering, Hammarberget');
  assert.equal(row.kind, 'view', 'a sign about the area is no shelter');
  assert.equal(row.area, 'Hammarberget');
  assert.equal(row.stateTrail, true, 'a state trail name means yes');
  assert.equal(row.description, 'Skylt vid entrén.');
  const okänd = normalizeFacility(
    facility({ ANORDNING_ID: 2, TYP: 'Vindskydd', UNDERTYP: 'Okänd' }),
  );
  assert.equal(okänd.subtype, null);
  assert.equal(okänd.kind, 'shelter');
  for (const [type, subtype, kind] of [
    ['Rastplats', 'Bänkbord', 'fire'],
    ['Vedförvaring/vedbod', null, 'fire'],
    ['Rastskydd', null, 'shelter'],
    ['Observationsplattform', null, 'view'],
    ['Information', 'Broshyrer', 'view'],
    ['Information', 'Taktil information', 'view'],
    ['Bro', 'Hängbro', 'structure'],
    ['Stängselgenomgång', null, 'structure'],
    ['Ankringsplats', null, 'access'],
    ['Soptunna', null, 'toilet'],
    ['Dricksvatten', 'Brunn', 'toilet'],
    ['Bastu', null, 'other'],
  ])
    assert.equal(facilityClass(type, subtype), kind, `${type} / ${subtype}`);
  for (const [type, kind] of [
    ['Skidled, Skoterled', 'snowmobile'],
    ['Skidled, Vinterled', 'ski'],
    ['Vinterled', 'ski'],
    ['Omarkerad stig', 'hike'],
    ['Elljusspår', 'hike'],
    ['Naturstig, Vandringsled', 'nature'],
    ['Båttrafikled', 'paddle'],
    ['Cykelled, Ridled', 'cycleRide'],
  ])
    assert.equal(trailClass(type, 'Barmarksled'), kind, type);
  // The WFS's names, too.
  assert.equal(
    normalizeFacility(
      facility({
        Anordning_ID: 9,
        Typ: 'Dass',
        Skyddat_område: 'Kolartorp (1)',
      }),
    ).area,
    'Kolartorp',
  );
});

test('a protected area is named without its register numbers, each once', () => {
  assert.equal(areaName('Kolartorp (2026369)'), 'Kolartorp');
  assert.equal(
    areaName(
      'Bjärehalvöns kuster (2031810), Hallands Väderö (2000962), Hallands Väderö (SE042',
    ),
    'Bjärehalvöns kuster, Hallands Väderö',
  );
  assert.equal(areaName('Ön (norra delen)'), 'Ön (norra delen)');
  assert.equal(areaName(null), null);
});

test("a trail's segments are put together by its id, its length in metres", () => {
  const segment = (coordinates, extra = {}) =>
    trail(
      {
        LED_ID: '30415317',
        LEDNAMN: null,
        LEDTYP: 'Skoterled',
        LEDKATEGORI: 'Led på snö',
        STATLIGLED: 'Vålådalen - Vålåstugorna (Z 59)',
        SKYDDATOMRADE: null,
        LEDLANGD: 2400,
        ...extra,
      },
      [coordinates],
    );
  const rows = normalizeTrails([
    segment(LINE),
    segment(
      [
        [602000, 6641000],
        [603000, 6641000],
      ],
      { LEDMARKERING: 'Kryss' },
    ),
    segment(LINE, { LED_ID: '99', LEDNAMN: 'Annan', STATLIGLED: null }),
  ]);
  assert.equal(rows.length, 2);
  const [state, other] = rows;
  assert.equal(state.id, 'l30415317');
  assert.equal(state.name, 'Vålådalen - Vålåstugorna (Z 59)');
  assert.equal(state.stateTrail, true);
  assert.equal(state.kind, 'snowmobile');
  assert.equal(state.lengthKm, 2.4, 'LEDLANGD is metres');
  assert.equal(state.marking, 'Kryss', 'taken from the segment that has it');
  assert.equal(state.lines.length, 2);
  assert.equal(other.stateTrail, false);
  const joined = joinLines(state.lines);
  assert.equal(joined.length, 1, 'segments meeting end to start are one line');
  assert.equal(joined[0].length, 4);
});

test('segments are joined either way round; apart they stay apart', () => {
  const a = [
    [1, 1],
    [2, 2],
  ];
  const b = [
    [3, 3],
    [2, 2],
  ];
  const c = [
    [9, 9],
    [8, 8],
  ];
  assert.deepEqual(joinLines([a, b, c]), [
    [
      [1, 1],
      [2, 2],
      [3, 3],
    ],
    c,
  ]);
  assert.deepEqual(linesBounds([a, b]), [1, 1, 3, 3]);
});

test('rows pack to short keys for the snapshot and unpack as they were', () => {
  const row = normalizeFacility(
    facility({
      ANORDNING_ID: 7,
      TYP: 'Parkering',
      UNDERTYP: 'Parkering för rörelsehindrade',
    }),
  );
  const packed = packFacility(row);
  assert.deepEqual(Object.keys(packed).sort(), ['i', 'k', 'p', 't', 'u', 'x']);
  assert.deepEqual(unpackFacility(JSON.parse(JSON.stringify(packed))), row);
  const trailRow = normalizeTrail(
    trail({ LED_ID: 5, LEDNAMN: 'Slingan', LEDTYP: 'Naturstig' }, [LINE]),
  );
  const packedTrail = packTrail(trailRow, [[1, 2, 3, 4]], [1, 2, 3, 4]);
  assert.deepEqual(packedTrail.g, [[1, 2, 3, 4]]);
  assert.deepEqual(packedTrail.b, [1, 2, 3, 4]);
  const { lines: _lines, sourceId: _source, ...fields } = trailRow;
  assert.deepEqual(unpackTrail(packedTrail), fields);
});

test('a description loses the sentences with contact details, and keeps the rest', () => {
  for (const [given, kept] of [
    [
      'Flytbrygga med hyrbara båtplatser. Kontakta Anna Jansson (010 - 225 15 53, anna.jansson@lansstyrelsen.se) på nationalparksförvaltningen för frågor om att hyra båtplats.',
      'Flytbrygga med hyrbara båtplatser.',
    ],
    [
      'Vi fyller på foldrar några gånger om året. Är det slut så får ni gärna sms:a och meddela det på 072-2219186.',
      'Vi fyller på foldrar några gånger om året.',
    ],
    [
      'Parkering för två bilar. Kod till bom behövs. Ring 070-2891769.',
      'Parkering för två bilar. Kod till bom behövs.',
    ],
    [
      'Ved finns i vedbod intill. Kontakta Länsstyrelsen (e-post: dalarna@lansstyrelsen.se) om veden börjar ta slut.',
      'Ved finns i vedbod intill.',
    ],
    [
      'Stugan bokas på 08-123 45 67. Den har fyra bäddar.',
      'Den har fyra bäddar.',
    ],
    ['Ring +46 70 123 45 67 vid fel. Bryggan är ny.', 'Bryggan är ny.'],
    ['Frågor till kontaktperson Per. Leden är 5 km.', 'Leden är 5 km.'],
    // No contact details: nothing changes.
    [
      'Kontakta Länsstyrelsen i Norrbotten för exakta datum. Öppet kl 08-16.',
      'Kontakta Länsstyrelsen i Norrbotten för exakta datum. Öppet kl 08-16.',
    ],
    [
      'Kontakta naturum för guidning. Leden är 2019-2020 års nya.',
      'Kontakta naturum för guidning. Leden är 2019-2020 års nya.',
    ],
    ['Ring 070-1234567.', null],
    [null, null],
  ])
    assert.equal(withoutContacts(given), kept, given);
  // Taken out before shortening, in both kinds of row.
  const row = normalizeFacility(
    facility({
      ANORDNING_ID: 1,
      TYP: 'Brygga',
      BESKRIVNING: 'Bryggan hyrs ut. Kontakta Anna Jansson, 070-1234567.',
    }),
  );
  assert.equal(row.description, 'Bryggan hyrs ut.');
  const led = normalizeTrail(
    trail({ LED_ID: 1, BESKRIVNING: 'Mejla info@example.se. Fin led.' }, [
      LINE,
    ]),
  );
  assert.equal(led.description, 'Fin led.');
});

test('a description is cut at a word with an ellipsis', () => {
  assert.equal(shorten('Kort.'), 'Kort.');
  assert.equal(shorten('ett två tre fyra', 9), 'ett två…');
  assert.equal(shorten(null), null);
});

test('a line is cut to the parts near a box, reaching just past its edge', () => {
  const box = [18, 59, 18.1, 59.1];
  const line = [
    [17.8, 59.05],
    [17.9, 59.05],
    [18.05, 59.05],
    [18.2, 59.05],
    [18.3, 59.05],
    [18.05, 59.06],
    [17.9, 59.06],
  ];
  assert.deepEqual(clipLine(line, box), [
    [
      [17.9, 59.05],
      [18.05, 59.05],
      [18.2, 59.05],
    ],
    [
      [18.3, 59.05],
      [18.05, 59.06],
      [17.9, 59.06],
    ],
  ]);
  assert.deepEqual(
    clipLine(
      [
        [17, 59],
        [17.1, 59],
      ],
      box,
    ),
    [],
  );
});

test('a view answers its facilities nearest first and its trails cut and encoded', () => {
  const rows = {
    facilities: [
      { id: 'a', point: [18.08, 59.05], kind: 'fire' },
      { id: 'b', point: [18.05, 59.05], kind: 'shelter' },
      { id: 'c', point: [19, 59.05], kind: 'toilet' },
    ],
    trails: [
      {
        id: 'l1',
        sourceId: '1',
        name: 'Inne',
        kind: 'hike',
        lines: [
          [
            [18.01, 59.02],
            [18.02, 59.03],
            [18.03, 59.04],
            [18.04, 59.05],
          ],
        ],
        lengthKm: 4,
      },
      {
        id: 'l2',
        name: 'Ute',
        kind: 'ski',
        lines: [
          [
            [19, 59],
            [19.1, 59.1],
          ],
        ],
      },
    ],
  };
  const view = outdoorInView(rows, {
    bbox: [18, 59, 18.1, 59.1],
    center: [18.05, 59.05],
    limit: 1,
  });
  assert.equal(view.facilityTotal, 2);
  assert.deepEqual(
    view.facilities.map(({ id, distance }) => [id, distance]),
    [['b', 0]],
  );
  assert.equal(view.trailTotal, 1);
  const [only] = view.trails;
  assert.equal(only.id, 'l1');
  assert.equal(only.sourceId, undefined, 'only what the card needs');
  assert.deepEqual(only.anchor, [18.04, 59.05]);
  const decoded = decodeLine(only.lines[0]);
  assert.deepEqual(decoded[0], [18.01, 59.02]);
  assert.deepEqual(decoded.at(-1), [18.04, 59.05]);
  assert.ok(decoded.length < 4, 'a straight run is thinned');
  assert.equal(view.trailsCapped, false);
});

test('too many trails in a view are capped, nearest kept', () => {
  const trails = Array.from({ length: MAX_TRAILS + 5 }, (_, i) => ({
    id: `l${i}`,
    kind: 'hike',
    lines: [
      [
        [18.01 + i * 1e-4, 59.01],
        [18.01 + i * 1e-4, 59.02],
      ],
    ],
  }));
  const view = outdoorInView(
    { facilities: [], trails },
    { bbox: [18, 59, 18.1, 59.1], center: [18, 59.015] },
  );
  assert.equal(view.trails.length, MAX_TRAILS);
  assert.equal(view.trails[0].id, 'l0');
  assert.equal(view.trailsCapped, true);
});

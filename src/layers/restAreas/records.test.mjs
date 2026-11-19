// Trafikverket's rest areas: spaces, equipment and status from Parking.
import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeRestAreaSnapshot, statusColor } from './records.js';
import { buildRestAreaCard, spacesLine } from './cards.js';

const answer = (areas) => ({ RESPONSE: { RESULT: [{ Parking: areas }] } });
const area = (fields) => ({
  Id: 'SE_STA_TRISSID_1_13652561',
  Name: 'Norra Melby',
  Geometry: { WGS84: 'POINT (13.736107 56.062798)' },
  OpenStatus: 'open',
  OperationStatus: 'inOperation',
  Equipment: [
    { Type: 'refuseBin' },
    { Type: 'toilet', Accessibility: 'handicappedAccessible' },
    { Type: 'picnicFacilities' },
  ],
  VehicleCharacteristics: [
    { VehicleType: 'car', NumberOfSpaces: 8 },
    { VehicleType: 'lorry', NumberOfSpaces: 4 },
  ],
  TariffsAndPayment: { FreeOfCharge: true },
  ...fields,
});

test('a rest area: its spaces, equipment and status', () => {
  const { areas } = normalizeRestAreaSnapshot(
    answer([
      area({}),
      area({
        Id: 'b',
        Name: 'Trandansen',
        VehicleCharacteristics: [{ VehicleType: 'car', NumberOfSpaces: 23 }],
        Description: 'Belysning.\nTrantorn.\n',
        TariffsAndPayment: undefined,
      }),
      area({ Id: 'c', OperationStatus: 'limitedOperation' }),
      area({ Id: 'd', OpenStatus: 'closed', OperationStatus: undefined }),
      area({ Id: 'e', Deleted: true }),
      area({ Id: 'f', Geometry: { WGS84: 'POINT (2 48)' } }),
    ]),
  );
  assert.deepEqual(
    areas.map((row) => [row.id, row.status]),
    [
      ['SE_STA_TRISSID_1_13652561', 'lorry'],
      ['b', 'open'],
      ['c', 'limited'],
      ['d', 'closed'],
    ],
  );
  const [melby, trandansen] = areas;
  assert.deepEqual(melby.spaces, { car: 8, lorry: 4 });
  assert.deepEqual(melby.equipment, [
    'toilet',
    'picnicFacilities',
    'refuseBin',
  ]);
  assert.equal(melby.accessibleToilet, true);
  assert.equal(melby.free, true);
  assert.equal(trandansen.free, null);
  assert.equal(trandansen.note, 'Belysning. Trantorn.');
  assert.notEqual(statusColor('lorry'), statusColor('open'));
  assert.throws(() => normalizeRestAreaSnapshot({}), /malformed/);
});

test('the card lists spaces, equipment and the note, never free spaces now', () => {
  const { areas } = normalizeRestAreaSnapshot(
    answer([area({ Description: 'Belysning.' })]),
  );
  const card = buildRestAreaCard(areas[0]);
  assert.equal(card.title, 'REST AREA · NORRA MELBY');
  assert.deepEqual(card.details, [
    '8 car spaces · 4 lorry spaces',
    'toilet (accessible), picnic tables, waste bins',
    'Free of charge',
    'Belysning.',
    'Spaces in all, not free spaces now · Trafikverket',
  ]);
  assert.equal(spacesLine({ car: 0, lorry: 0 }), '');
});

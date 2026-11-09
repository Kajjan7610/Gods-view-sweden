import assert from 'node:assert/strict';
import test from 'node:test';
import {
  deskClass,
  nearestPassportDesk,
  normalizePoliceStation,
  normalizePoliceStations,
} from './records.js';

const station = (id, gps, services = [], extra = {}) => ({
  id,
  name: `Polisen ${extra.place ?? 'Alingsås'}`,
  Url: `https://polisen.se/om-polisen/kontakt/polisstationer/x/${id}/`,
  location: { name: 'N Strömgatan 8, Alingsås', gps },
  services: services.map((name) => ({ name })),
  ...extra,
});

test('a station keeps its place name, address, page and services in order', () => {
  const row = normalizePoliceStation(
    station(1233, '57.930105,12.529608', [
      'Lämna in vapen',
      'Ansöka om pass och id-kort',
      'Okänd tjänst',
      'Lämna in vapen',
    ]),
  );
  assert.deepEqual(row, {
    id: '1233',
    point: [12.52961, 57.93011],
    name: 'Alingsås',
    address: 'N Strömgatan 8, Alingsås',
    url: 'https://polisen.se/om-polisen/kontakt/polisstationer/x/1233/',
    services: ['passport-apply', 'weapons'],
  });
  assert.equal(deskClass(row), 'passport');
});

test('stations outside Sweden, without a position or with a foreign page are refused or unlinked', () => {
  assert.equal(normalizePoliceStation(station(1, '')), null);
  assert.equal(normalizePoliceStation(station(2, '48.85,2.35')), null);
  assert.equal(normalizePoliceStation(station('', '59.3,18.0')), null);
  const row = normalizePoliceStation(
    station(3, '59.3,18.0', [], { Url: 'https://example.com/polisen.se/' }),
  );
  assert.equal(row.url, null);
  assert.equal(deskClass(row), 'no-desk');
});

test('the list puts passport desks first, drops duplicates and names the nearest passport desk', () => {
  const rows = normalizePoliceStations([
    station(10, '59.0,18.0', [], { place: 'Öby' }),
    station(11, '59.1,18.0', ['Hämta pass och id-kort'], { place: 'Ankeby' }),
    station(12, '59.5,18.0', ['Ansöka om pass och id-kort'], { place: 'Fjärran' }),
    station(13, '59.2,18.0', ['Ansöka om pass och id-kort'], { place: 'Bäckby' }),
    station(13, '59.2,18.0', []),
  ]);
  assert.deepEqual(
    rows.map((row) => [row.name, deskClass(row)]),
    [
      ['Bäckby', 'passport'],
      ['Fjärran', 'passport'],
      ['Ankeby', 'desk'],
      ['Öby', 'no-desk'],
    ],
  );
  const nearest = nearestPassportDesk(rows[3], rows);
  assert.equal(nearest.row.name, 'Bäckby');
  assert.equal(Math.round(nearest.km), 22);
  assert.throws(() => normalizePoliceStations({}), /Malformed/);
});

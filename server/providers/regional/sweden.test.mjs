// The cockpit briefing's Swedish sources: the place from the nearest
// municipality seat, SMHI's conditions and the warnings in effect at a point.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  alertsAt,
  maybeInSweden,
  normalizeSmhiNow,
  smhiSymbolToWmo,
  swedishPlaceAt,
} from './sweden.js';

test('a point near a municipality seat is that town in its county', () => {
  assert.deepEqual(swedishPlaceAt({ latitude: 60.67, longitude: 17.14 }), {
    label: 'Gävle, Gävleborgs län',
    locality: 'Gävle',
    region: 'Gävleborgs län',
    country: 'Sverige',
    countryCode: 'SE',
    source: 'Wikidata',
  });
  // A municipality named in the genitive gives its seat.
  assert.equal(
    swedishPlaceAt({ latitude: 59.33, longitude: 18.07 }).locality,
    'Stockholm',
  );
  // Mid-Baltic and Oslo are not Swedish places.
  assert.equal(swedishPlaceAt({ latitude: 57.0, longitude: 20.0 }), null);
  assert.equal(swedishPlaceAt({ latitude: 59.91, longitude: 10.75 }), null);
  assert.equal(maybeInSweden({ latitude: 48.86, longitude: 2.35 }), false);
});

test("SMHI's current hour becomes the briefing's weather record", () => {
  const now = Date.parse('2026-11-05T14:20:00Z');
  const step = (time, data) => ({ time, data });
  const weather = normalizeSmhiNow(
    {
      timeSeries: [
        step('2026-11-05T14:00:00Z', {
          air_temperature: 8.9,
          wind_speed: 3.2,
          wind_from_direction: 318,
          cloud_area_fraction: 4,
          precipitation_amount_mean: 0.2,
          visibility_in_air: 35.4,
          symbol_code: 18,
        }),
        step('2026-11-05T16:00:00Z', { air_temperature: 3 }),
      ],
    },
    now,
  );
  assert.deepEqual(weather, {
    observedAt: '2026-11-05T14:00:00.000Z',
    temperatureC: 8.9,
    apparentTemperatureC: null,
    precipitationMm: 0.2,
    cloudCoverPct: 50,
    windKph: 11.5,
    windDirectionDeg: 318,
    visibilityM: 35400,
    weatherCode: 61,
  });
  assert.equal(normalizeSmhiNow({ timeSeries: [] }, now), null);
  assert.equal(smhiSymbolToWmo(1), 0);
  assert.equal(smhiSymbolToWmo(7), 45);
  assert.equal(smhiSymbolToWmo(11), 95);
  assert.equal(smhiSymbolToWmo(26), 71);
  assert.equal(smhiSymbolToWmo('x'), null);
});

test('the alerts at a point are VMAs near it, then warnings over it by severity', () => {
  const square = (lon, lat) => [
    {
      outer: [
        [lon - 1, lat - 1],
        [lon + 1, lat - 1],
        [lon + 1, lat + 1],
        [lon - 1, lat + 1],
      ],
      holes: [],
    },
  ];
  const area = (id, level, lon, lat) => ({
    id,
    level,
    event: { sv: `Händelse ${id}`, en: `Event ${id}` },
    area: { sv: 'Gävleborgs län', en: 'Gävleborg County' },
    start: 1,
    end: 2,
    polygons: square(lon, lat),
  });
  const warnings = {
    areas: [
      area('a', 'MESSAGE', 17, 60.7),
      area('b', 'ORANGE', 17, 60.7),
      area('far', 'RED', 13, 55.9),
    ],
  };
  const crisis = [
    {
      kind: 'vma',
      headline: 'Brand i Gävle',
      place: 'Gävle',
      point: [17.14, 60.67],
      scope: 'municipality',
      published: 5,
    },
    {
      kind: 'vma',
      headline: 'Brand i Malmö',
      place: 'Malmö',
      point: [13.0, 55.6],
      scope: 'municipality',
      published: 6,
    },
    {
      kind: 'news',
      headline: 'Nyhet',
      point: [17.14, 60.67],
      scope: 'municipality',
    },
  ];
  const alerts = alertsAt(warnings, crisis, {
    latitude: 60.67,
    longitude: 17.14,
  });
  assert.deepEqual(
    alerts.map((alert) => [alert.kind, alert.level, alert.title.sv]),
    [
      ['vma', 'VMA', 'Brand i Gävle'],
      ['warning', 'ORANGE', 'Händelse b'],
      ['warning', 'MESSAGE', 'Händelse a'],
    ],
  );
  assert.deepEqual(
    alertsAt({ areas: [] }, [], { latitude: 60, longitude: 17 }),
    [],
  );
});

// Aviation weather: station ids, visibility from the raw METAR, the report
// as read, and the route's cache.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  AVIATION_WEATHER_URL,
  aviationWeatherProxy,
  normalizeMetar,
  stationIds,
  visibilityMeters,
} from './aviationWeather.js';

const ESGG = {
  icaoId: 'ESGG',
  reportTime: '2026-11-07T11:20:00.000Z',
  temp: 5,
  dewp: 3,
  wdir: 150,
  wspd: 3,
  visib: '6+',
  altim: 1028,
  rawOb: 'METAR ESGG 071120Z 15003KT 9999 BKN024 05/03 Q1028',
  clouds: [{ cover: 'BKN', base: 2400 }],
  cover: 'BKN',
  fltCat: 'MVFR',
  rawTaf: 'TAF ESGG 071130Z 0712/0812 15003KT 9999 BKN025',
  name: 'Goteborg/Landvetter Arpt, VG, SE',
};

test('station ids: four letters, upper case, at most six', () => {
  assert.deepEqual(stationIds('essa, ESGG,x,ESSA,12AB'), ['ESSA', 'ESGG']);
  assert.equal(stationIds('A,B,C,D,E,F,G'.replace(/\w/g, 'ESS$&')).length, 6);
  assert.deepEqual(stationIds(null), []);
});

test('visibility in metres: 9999, CAVOK, a reduced reading, statute miles', () => {
  assert.equal(visibilityMeters(ESGG.rawOb, '6+'), 9999);
  assert.equal(
    visibilityMeters('METAR ESSA 071120Z 26007KT CAVOK 02/M01 Q1024', '6+'),
    10_000,
  );
  assert.equal(
    visibilityMeters(
      'METAR ESSA 071120Z 26007KT 2500 BR OVC004 02/01 Q1024',
      null,
    ),
    2500,
  );
  assert.equal(
    visibilityMeters(
      'METAR ESNQ 071120Z AUTO 27012KT 0800 FG VV002 M01/M01 Q1004',
      null,
    ),
    800,
  );
  assert.equal(visibilityMeters('', '3'), 4800);
  assert.equal(visibilityMeters('', null), null);
});

test('a report: wind, cloud base and ceiling, temperature, QNH, category', () => {
  const report = normalizeMetar(ESGG);
  assert.equal(report.icao, 'ESGG');
  assert.equal(report.windDir, 150);
  assert.equal(report.windKt, 3);
  assert.equal(report.gustKt, null);
  assert.equal(report.ceilingFt, 2400);
  assert.equal(report.qnhHpa, 1028);
  assert.equal(report.category, 'MVFR');
  assert.equal(report.cavok, false);
  assert.match(report.taf, /^TAF ESGG/);
  const vrb = normalizeMetar({
    ...ESGG,
    wdir: 'VRB',
    clouds: [{ cover: 'FEW', base: 1400 }],
    fltCat: 'nope',
  });
  assert.equal(vrb.windVariable, true);
  assert.equal(vrb.windDir, null);
  assert.equal(vrb.ceilingFt, null, 'a few clouds make no ceiling');
  assert.equal(vrb.category, null);
  assert.equal(normalizeMetar({}), null);
});

test('the route reads only stations not kept fresh', async () => {
  const urls = [];
  let clock = Date.parse('2026-11-07T12:00:00Z');
  const proxy = aviationWeatherProxy({
    fetchImpl: async (url) => {
      urls.push(url);
      return new Response(JSON.stringify([ESGG]));
    },
    now: () => clock,
  });
  let handler = null;
  proxy.configureServer({ middlewares: { use: (path, fn) => (handler = fn) } });
  const get = async (url) => {
    const res = {
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        this.body = JSON.parse(body);
      },
    };
    await handler({ method: 'GET', url, headers: {}, socket: {} }, res);
    return res;
  };
  const first = await get('/?ids=ESGG,ESSA');
  assert.equal(first.status, 200);
  assert.deepEqual(
    first.body.reports.map((r) => r.icao),
    ['ESGG'],
  );
  assert.ok(urls[0].startsWith(`${AVIATION_WEATHER_URL}?ids=ESGG,ESSA`));
  await get('/?ids=ESGG');
  assert.equal(urls.length, 1, 'kept ten minutes');
  clock += 11 * 60_000;
  await get('/?ids=ESGG');
  assert.equal(urls.length, 2);
  assert.equal((await get('/?ids=x')).status, 400);
});

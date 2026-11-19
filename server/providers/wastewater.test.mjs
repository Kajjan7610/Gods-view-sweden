// The wastewater route: the dashboard page names the current data file,
// which is read and kept for six hours; a failed refresh serves the last
// snapshot marked stale.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  WASTEWATER_PAGE_URL,
  dataFileUrl,
  wastewaterProxy,
} from './wastewater.js';

const PAGE =
  '<a class="btn" href="/media/dashboard_data/data_2026-11-16.csv">Download</a>';
const FILE =
  'https://www.pathogens.se/media/dashboard_data/data_2026-11-16.csv';
const CSV = [
  'target,sample,sampling_date,city,inhabitants,copies_l,copies_day_inhabitant,pmmov_normalised,category,flow',
  'SARS CoV-2,w46y26vas,2026-11-09,Vasteras,145000,1,1,0.6,Positive sample,1',
].join('\n');

async function call(plugin, url = '/') {
  let handler;
  plugin.configureServer({
    middlewares: { use: (_path, fn) => (handler = fn) },
  });
  return new Promise((resolve) => {
    const res = {
      destroyed: false,
      status: 0,
      writeHead(status) {
        this.status = status;
      },
      end(body) {
        resolve({ status: this.status, body: JSON.parse(body) });
      },
    };
    handler(
      { method: 'GET', url, headers: { 'sec-fetch-site': 'same-origin' } },
      res,
      () => resolve({ status: 404 }),
    );
  });
}

test('the data file is the one the dashboard page links to', () => {
  assert.equal(dataFileUrl(PAGE), FILE);
  assert.equal(dataFileUrl('<a href="/media/other.csv">'), null);
  assert.equal(dataFileUrl(null), null);
});

test('the page, then its file; kept six hours; the last snapshot stands in, marked stale', async () => {
  let clock = Date.parse('2026-11-19T08:00:00Z');
  const asked = [];
  let down = false;
  const fetchImpl = async (url) => {
    asked.push(url);
    if (down) return new Response('', { status: 503 });
    return new Response(url === WASTEWATER_PAGE_URL ? PAGE : CSV);
  };
  const proxy = wastewaterProxy({ fetchImpl, now: () => clock });
  const first = await call(proxy);
  assert.equal(first.status, 200);
  assert.deepEqual(asked, [WASTEWATER_PAGE_URL, FILE]);
  assert.equal(first.body.plants[0].place, 'Västerås');
  assert.equal(first.body.file, FILE);
  // Within six hours: the cached snapshot, nothing asked.
  clock += 5 * 3_600_000;
  await proxy.read();
  assert.equal(asked.length, 2);
  // Later, with the site down: the last snapshot, marked stale.
  clock += 2 * 3_600_000;
  down = true;
  const stale = await call(proxy);
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(asked.length, 3);
  // And it is not asked again for ten minutes.
  await proxy.read();
  assert.equal(asked.length, 3);
});

test('without any snapshot a failure is a 502', async () => {
  const proxy = wastewaterProxy({
    fetchImpl: async () => new Response('<html>no link</html>'),
  });
  assert.equal((await call(proxy)).status, 502);
});

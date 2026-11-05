// Valmyndigheten's municipal election workbook: the two municipality sheets
// read straight from the xlsx zip, shares among the parties' votes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { deflateRawSync } from 'node:zlib';
import {
  createElectionResults,
  electionByMunicipality,
  parseElectionWorkbook,
  sheetPaths,
} from './cityDossierElection.js';

/** A minimal zip (deflated entries) built for the test. */
function zip(files) {
  const encoder = new TextEncoder();
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const raw = encoder.encode(text);
    const data = deflateRawSync(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(data.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, directory, end]));
}

const strings = [
  'Valtyp',
  'Kommun',
  'Kommunkod',
  'Arbetarepartiet-Socialdemokraterna',
  'Moderaterna',
  'Skärgårdspartiet',
  'Piratpartiet',
  'Gävle',
  'Värmdö',
  'Valdeltagande (%)',
  // Municipality codes are text in Valmyndigheten's workbook.
  '2180',
  '0120',
];
const cell = (column, value, shared = false) =>
  shared
    ? `<c r="${column}1" t="s"><v>${strings.indexOf(value)}</v></c>`
    : `<c r="${column}1"><v>${value}</v></c>`;
const row = (cells) => `<row>${cells.join('')}</row>`;
const votes = `<sheetData>${[
  row([
    cell('A', 'Valtyp', true),
    cell('B', 'Kommun', true),
    cell('C', 'Kommunkod', true),
    cell('D', 'Arbetarepartiet-Socialdemokraterna', true),
    cell('E', 'Moderaterna', true),
    cell('F', 'Skärgårdspartiet', true),
    cell('G', 'Piratpartiet', true),
  ]),
  row([
    cell('A', 'Kommun', true),
    cell('B', 'Gävle', true),
    cell('C', '2180', true),
    cell('D', 600),
    cell('E', 380),
    cell('G', 20),
  ]),
  row([
    cell('A', 'Kommun', true),
    cell('B', 'Värmdö', true),
    cell('C', '0120', true),
    cell('D', 500),
    cell('E', 450),
    cell('F', 50),
  ]),
].join('')}</sheetData>`;
const turnout = `<sheetData>${[
  row([cell('A', 'Kommunkod', true), cell('B', 'Valdeltagande (%)', true)]),
  row([cell('A', '2180', true), cell('B', 0.8286)]),
].join('')}</sheetData>`;

const workbook = zip({
  'xl/workbook.xml':
    '<workbook><sheets><sheet name="Information" r:id="rId1"/><sheet name="Antal_kommun" r:id="rId3"/><sheet name="Valdeltagande_kommun" r:id="rId9"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':
    '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId3" Target="worksheets/sheet3.xml"/><Relationship Id="rId9" Target="worksheets/sheet9.xml"/></Relationships>',
  'xl/sharedStrings.xml': `<sst>${strings.map((t) => `<si><t>${t}</t></si>`).join('')}</sst>`,
  'xl/worksheets/sheet1.xml': '<worksheet/>',
  'xl/worksheets/sheet3.xml': `<worksheet>${votes}</worksheet>`,
  'xl/worksheets/sheet9.xml': `<worksheet>${turnout}</worksheet>`,
});

test('sheet names lead to their parts', () => {
  assert.deepEqual(
    [
      ...sheetPaths(
        '<sheet name="Antal_kommun" r:id="rId3"/>',
        '<Relationship Id="rId3" Target="worksheets/sheet3.xml"/>',
      ),
    ],
    [['Antal_kommun', 'xl/worksheets/sheet3.xml']],
  );
});

test('the workbook gives shares per municipality, local parties named from 3 %', () => {
  const results = parseElectionWorkbook(workbook);
  assert.deepEqual(results['2180'], {
    year: 2026,
    turnout: 82.86,
    parties: [
      { party: 'S', share: 60 },
      { party: 'M', share: 38 },
      { party: 'other', share: 2 },
    ],
  });
  assert.deepEqual(results['0120'].parties, [
    { party: 'S', share: 50 },
    { party: 'M', share: 45 },
    { party: 'local', name: 'Skärgårdspartiet', share: 5 },
  ]);
  assert.equal(results['0120'].turnout, null);
  assert.deepEqual(electionByMunicipality([{ Kommunkod: 'x' }], []), {});
});

test('the results are fetched once through the raw-data page', async () => {
  const urls = [];
  const election = createElectionResults({
    cacheFile: null,
    fetchImpl: async (url) => {
      urls.push(url);
      if (url.endsWith('radata-val-2026'))
        return new Response(
          '<a href="/download/18.1/2/roster-per-distrikt-slutligt-antal-roster-inklusive-totalt-valdeltagande-kommunvalen-2026.xlsx">x</a>',
        );
      return new Response(workbook);
    },
  });
  assert.equal((await election.forMunicipality('2180')).parties[0].share, 60);
  assert.equal(await election.forMunicipality('9999'), null);
  assert.equal(urls.length, 2);
  assert.match(
    urls[1],
    /^https:\/\/www\.val\.se\/download\/18\.1\/2\/.*kommunvalen-2026\.xlsx$/,
  );
});

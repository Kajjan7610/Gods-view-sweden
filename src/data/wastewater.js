// Swedish fork: respiratory viruses in wastewater, from SLU and SEEC on the
// SciLifeLab Swedish Pathogens Portal (CC BY 4.0). One CSV row is one virus
// in one weekly sample from one treatment plant. The level is the virus
// normalised against PMMoV, a pepper virus that tracks how much human waste
// the sample holds, so weeks compare within one plant. Plants differ in size
// and catchment, so levels are never compared between towns: the app shows
// each plant's own trend, not a ranking.

/** The viruses shown, by the CSV's target names. */
export const WASTEWATER_TARGETS = Object.freeze({
  'SARS CoV-2': 'covid',
  'Influenza A virus': 'fluA',
  'Influenza B virus': 'fluB',
  RSV: 'rsv',
});
/**
 * The laboratory changed its method in week 36 of 2026; levels before and
 * after do not compare, so only samples from that week on are read.
 */
export const METHOD_FROM = '2026-08-31';
/** The latest level against the two samples before it. */
const RISING_RATIO = 1.5;
const FALLING_RATIO = 1 / RISING_RATIO;
/** A plant whose newest sample is this much older than the newest anywhere. */
const OUT_OF_DATE_DAYS = 21;
const DAY_MS = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** The file spells towns and plants without å, ä and ö; these are restored. */
const SPELLING = Object.freeze({
  Gavle: 'Gävle',
  Goteborg: 'Göteborg',
  Grodinge: 'Grödinge',
  Jonkoping: 'Jönköping',
  Kappala: 'Käppala',
  Linkoping: 'Linköping',
  Lulea: 'Luleå',
  Malmo: 'Malmö',
  Orebro: 'Örebro',
  Ostersund: 'Östersund',
  Osthammar: 'Östhammar',
  Umea: 'Umeå',
  Vasteras: 'Västerås',
});

/** "Göteborg" and "Goteborg" alike: the file spells towns without å, ä, ö. */
export function townKey(name) {
  return String(name ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** Not detected, detected again, rising, steady or falling. */
export function wastewaterTrend(levels) {
  const latest = levels.at(-1);
  if (!(latest > 0)) return 'none';
  const before = levels.slice(-3, -1);
  const mean = before.length
    ? before.reduce((sum, value) => sum + value, 0) / before.length
    : 0;
  // Found after samples without it: no ratio to speak of.
  if (!(mean > 0)) return 'detected';
  const ratio = latest / mean;
  if (ratio >= RISING_RATIO) return 'rising';
  if (ratio <= FALLING_RATIO) return 'falling';
  return 'steady';
}

/** The data file as plants, each with its viruses' trends. */
export function normalizeWastewater(csv) {
  const lines = String(csv ?? '').split(/\r?\n/);
  const header = lines[0].split(',').map((name) => name.trim());
  const col = Object.fromEntries(header.map((name, i) => [name, i]));
  for (const name of [
    'target',
    'sampling_date',
    'city',
    'pmmov_normalised',
    'category',
  ])
    if (!(name in col)) throw new Error(`wastewater file lacks ${name}`);
  const plants = new Map();
  let latest = '';
  for (const line of lines.slice(1)) {
    if (!line) continue;
    const cells = line.split(',');
    const virus = WASTEWATER_TARGETS[cells[col.target]];
    const date = cells[col.sampling_date];
    const city = cells[col.city]?.trim();
    if (!virus || !city || !DATE.test(date) || date < METHOD_FROM) continue;
    const value = Number(cells[col.pmmov_normalised]);
    const negative = /^negative/i.test(cells[col.category] ?? '');
    const level = negative || !Number.isFinite(value) ? 0 : Math.max(0, value);
    let plant = plants.get(city);
    if (!plant) {
      plant = { city, samples: new Map() };
      plants.set(city, plant);
    }
    if (!plant.samples.has(virus)) plant.samples.set(virus, new Map());
    plant.samples.get(virus).set(date, level);
    if (date > latest) latest = date;
  }
  return {
    plants: [...plants.values()]
      .map((plant) => plantView(plant, latest))
      .sort((a, b) => a.key.localeCompare(b.key)),
    latestWeek: latest || null,
    methodFrom: METHOD_FROM,
  };
}

function plantView({ city, samples }, latest) {
  let newest = '';
  const viruses = Object.values(WASTEWATER_TARGETS)
    .filter((virus) => samples.has(virus))
    .map((virus) => {
      const series = [...samples.get(virus)].sort(([a], [b]) =>
        a < b ? -1 : 1,
      );
      const date = series.at(-1)[0];
      if (date > newest) newest = date;
      return {
        virus,
        trend: wastewaterTrend(series.map(([, level]) => level)),
        date,
      };
    });
  // "Stockholm-Bromma" is the Bromma plant serving Stockholm.
  const [place, plant = null] = city.split('-');
  return {
    city,
    key: townKey(city),
    place: SPELLING[place] ?? place,
    plant: plant && (SPELLING[plant] ?? plant),
    latest: newest,
    outOfDate:
      Date.parse(latest) - Date.parse(newest) > OUT_OF_DATE_DAYS * DAY_MS,
    viruses,
  };
}

/**
 * The plants named after the town, or else its municipality: one, or several
 * ("Stockholm-Bromma", "Stockholm-Henriksdal"…). Plants whose newest sample
 * is weeks behind the others are left out rather than shown as current.
 */
export function wastewaterFor(snapshot, town) {
  const plants = Array.isArray(snapshot?.plants) ? snapshot.plants : [];
  const names = [town?.name, town?.municipality].map(townKey).filter(Boolean);
  for (const name of names) {
    const found = plants.filter(
      (plant) =>
        !plant.outOfDate &&
        (plant.key === name || plant.key.startsWith(`${name}-`)),
    );
    if (found.length) return found;
  }
  return [];
}

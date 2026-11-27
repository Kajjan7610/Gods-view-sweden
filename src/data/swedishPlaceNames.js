/**
 * Swedish fork: Swedish names for a selection of the Natural Earth places
 * the Cockpit's orbit view names ("JUST NU ÖVER"). The packs carry English
 * or local names, so a Swedish reader saw "LAPLAND, FINLAND" or "BALTIC
 * SEA". The selection: seas and oceans with an established Swedish name,
 * Finland's regions (their official Swedish names), Natural Earth
 * spellings that lost their Swedish letters, and towns with an established
 * Swedish name. A region is renamed only in its own country. A town is
 * renamed in its own country, or anywhere when Natural Earth has only one
 * town of that name (København seen from Malmö); a name Natural Earth gives
 * to towns in several countries is renamed only in its own, so Naples,
 * Florida never becomes "Neapel". A name not in the selection is shown as
 * Natural Earth spells it.
 */

/** Seas, oceans and sounds: the same name wherever they are. */
const SEAS = new Map(
  Object.entries({
    'Arctic Ocean': 'Norra ishavet',
    'Southern Ocean': 'Södra ishavet',
    'North Atlantic Ocean': 'Nordatlanten',
    'South Atlantic Ocean': 'Sydatlanten',
    'North Pacific Ocean': 'Norra Stilla havet',
    'South Pacific Ocean': 'Södra Stilla havet',
    'Indian Ocean': 'Indiska oceanen',
    'Baltic Sea': 'Östersjön',
    'Gulf of Bothnia': 'Bottniska viken',
    'Gulf of Finland': 'Finska viken',
    'Gulf of Riga': 'Rigabukten',
    Øresund: 'Öresund',
    Kattegat: 'Kattegatt',
    'North Sea': 'Nordsjön',
    'Norwegian Sea': 'Norska havet',
    'Greenland Sea': 'Grönlandshavet',
    'Barents Sea': 'Barents hav',
    'White Sea': 'Vita havet',
    'Kara Sea': 'Karahavet',
    'Laptev Sea': 'Laptevhavet',
    'East Siberian Sea': 'Östsibiriska havet',
    'Chukchi Sea': 'Tjuktjerhavet',
    'Bering Sea': 'Berings hav',
    'Sea of Okhotsk': 'Ochotska havet',
    'Sea of Japan': 'Japanska havet',
    'Yellow Sea': 'Gula havet',
    'East China Sea': 'Östkinesiska havet',
    'South China Sea': 'Sydkinesiska havet',
    'Philippine Sea': 'Filippinska havet',
    'Coral Sea': 'Korallhavet',
    'Tasman Sea': 'Tasmanska havet',
    'Ross Sea': 'Rosshavet',
    'Weddell Sea': 'Weddellhavet',
    'Bay of Bengal': 'Bengaliska viken',
    'Arabian Sea': 'Arabiska havet',
    'Gulf of Aden': 'Adenviken',
    'Gulf of Oman': 'Omanviken',
    'Gulf of Thailand': 'Thailandviken',
    'Red Sea': 'Röda havet',
    'Mediterranean Sea': 'Medelhavet',
    'Tyrrhenian Sea': 'Tyrrenska havet',
    'Ligurian Sea': 'Liguriska havet',
    'Adriatic Sea': 'Adriatiska havet',
    'Ionian Sea': 'Joniska havet',
    'Aegean Sea': 'Egeiska havet',
    'Sea of Marmara': 'Marmarasjön',
    'Black Sea': 'Svarta havet',
    'Sea of Azov': 'Azovska sjön',
    'Caspian Sea': 'Kaspiska havet',
    'Strait of Gibraltar': 'Gibraltarsundet',
    'Bay of Biscay': 'Biscayabukten',
    'English Channel': 'Engelska kanalen',
    'Irish Sea': 'Irländska sjön',
    'Gulf of Guinea': 'Guineabukten',
    'Caribbean Sea': 'Karibiska havet',
    'Gulf of Mexico': 'Mexikanska golfen',
    'Gulf of Alaska': 'Alaskagolfen',
    'Labrador Sea': 'Labradorhavet',
    'Beaufort Sea': 'Beauforthavet',
    'Sargasso Sea': 'Sargassohavet',
  }),
);

/** Regions: [Natural Earth name, ISO country code, Swedish]. */
const REGIONS = [
  // Finland's regions (admin-1), official Swedish names. Satakunta keeps
  // its own name, which Swedish uses too.
  ['Central Finland', 'FI', 'Mellersta Finland'],
  ['Central Ostrobothnia', 'FI', 'Mellersta Österbotten'],
  ['Finland Proper', 'FI', 'Egentliga Finland'],
  ['Kainuu', 'FI', 'Kajanaland'],
  ['Kymenlaakso', 'FI', 'Kymmenedalen'],
  ['Lapland', 'FI', 'Lappland'],
  ['North Karelia', 'FI', 'Norra Karelen'],
  ['Northern Ostrobothnia', 'FI', 'Norra Österbotten'],
  ['Northern Savonia', 'FI', 'Norra Savolax'],
  ['Ostrobothnia', 'FI', 'Österbotten'],
  ['Päijät-Häme', 'FI', 'Päijänne-Tavastland'],
  ['Pirkanmaa', 'FI', 'Birkaland'],
  ['South Karelia', 'FI', 'Södra Karelen'],
  ['Southern Ostrobothnia', 'FI', 'Södra Österbotten'],
  ['Southern Savonia', 'FI', 'Södra Savolax'],
  ['Tavastia Proper', 'FI', 'Egentliga Tavastland'],
  ['Uusimaa', 'FI', 'Nyland'],
  // Natural Earth spellings without their Swedish letters.
  ['Orebro', 'SE', 'Örebro'],
  ['Sjaælland', 'DK', 'Själland'],
  // A province with an established Swedish name.
  ['Antwerp', 'BE', 'Antwerpen'],
];

/** Towns: [Natural Earth name, ISO country code, Swedish]. */
const TOWNS = [
  // A Natural Earth spelling without its Swedish letters.
  ['Vannersborg', 'SE', 'Vänersborg'],
  // Towns with an established Swedish name.
  ['København', 'DK', 'Köpenhamn'],
  ['Helsinki', 'FI', 'Helsingfors'],
  ['Turku', 'FI', 'Åbo'],
  ['Tampere', 'FI', 'Tammerfors'],
  ['Oulu', 'FI', 'Uleåborg'],
  ['Vaasa', 'FI', 'Vasa'],
  ['Pori', 'FI', 'Björneborg'],
  ['Lahti', 'FI', 'Lahtis'],
  ['Porvoo', 'FI', 'Borgå'],
  ['Kokkola', 'FI', 'Karleby'],
  ['Hämeenlinna', 'FI', 'Tavastehus'],
  ['Lappeenranta', 'FI', 'Villmanstrand'],
  ['Mikkeli', 'FI', 'S:t Michel'],
  ['Savonlinna', 'FI', 'Nyslott'],
  ['Vyborg', 'RU', 'Viborg'],
  ['St.  Petersburg', 'RU', 'Sankt Petersburg'],
  ['Moscow', 'RU', 'Moskva'],
  ['Warsaw', 'PL', 'Warszawa'],
  ['Prague', 'CZ', 'Prag'],
  ['Vienna', 'AT', 'Wien'],
  ['Munich', 'DE', 'München'],
  ['Cologne', 'DE', 'Köln'],
  ['Brussels', 'BE', 'Bryssel'],
  ['The Hague', 'NL', 'Haag'],
  ['Lisbon', 'PT', 'Lissabon'],
  ['Seville', 'ES', 'Sevilla'],
  ['Rome', 'IT', 'Rom'],
  ['Milan', 'IT', 'Milano'],
  ['Venice', 'IT', 'Venedig'],
  ['Florence', 'IT', 'Florens'],
  ['Naples', 'IT', 'Neapel'],
  ['Athens', 'GR', 'Aten'],
  ['Belgrade', 'RS', 'Belgrad'],
  ['Bucharest', 'RO', 'Bukarest'],
  ['Geneva', 'CH', 'Genève'],
];
const byCountry = (rows) =>
  new Map(
    rows.map(([name, country, swedish]) => [`${country}|${name}`, swedish]),
  );
const REGION_NAMES = byCountry(REGIONS);
const TOWN_NAMES = byCountry(TOWNS);

/**
 * Town names Natural Earth's populated places give to more than one town
 * (Naples, Florida beside Naples, Italy): these are renamed only in their
 * own country. A test keeps this list equal to the pack.
 */
export const TOWN_NAMES_SHARED = Object.freeze([
  'Athens',
  'Florence',
  'Naples',
]);
const SHARED = new Set(TOWN_NAMES_SHARED);
const TOWN_ANYWHERE = new Map(
  TOWNS.filter(([name]) => !SHARED.has(name)).map(([name, , swedish]) => [
    name,
    swedish,
  ]),
);

/** The Natural Earth names in the selection, for tests. */
export const SWEDISH_PLACE_NAME_KEYS = Object.freeze({
  seas: Object.freeze([...SEAS.keys()]),
  regions: Object.freeze(REGIONS.map(([name, country]) => ({ name, country }))),
  towns: Object.freeze(TOWNS.map(([name, country]) => ({ name, country }))),
});

/** The Swedish name of a sea, ocean or sound, or the name itself. */
export function swedishSeaName(name) {
  return typeof name === 'string' ? (SEAS.get(name) ?? name) : name;
}

/**
 * The Swedish name of a region in `countryCode`, or the name itself (also
 * for the same name in another country).
 * @param {string|null|undefined} name
 * @param {string|null|undefined} countryCode ISO 3166-1 alpha-2
 */
export function swedishRegionName(name, countryCode) {
  if (typeof name !== 'string' || typeof countryCode !== 'string') return name;
  return REGION_NAMES.get(`${countryCode.toUpperCase()}|${name}`) ?? name;
}

/**
 * The Swedish name of a town, or the name itself. `countryCode` is the
 * country of the point below, which the town may lie across a border from:
 * a name Natural Earth gives to one town only is renamed wherever it is.
 * @param {string|null|undefined} name
 * @param {string|null|undefined} countryCode ISO 3166-1 alpha-2
 */
export function swedishTownName(name, countryCode) {
  if (typeof name !== 'string') return name;
  const own =
    typeof countryCode === 'string'
      ? TOWN_NAMES.get(`${countryCode.toUpperCase()}|${name}`)
      : undefined;
  return own ?? TOWN_ANYWHERE.get(name) ?? name;
}

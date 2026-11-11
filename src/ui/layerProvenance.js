/**
 * Where the Swedish fork's data comes from, layer by layer: the one table the
 * Data Layers panel reads for its SE marks, the ⓘ details and the Swedish
 * filter. Layers of the fork's own are marked SE; the original app's layers
 * the fork adds Swedish data to are marked +SE and keep the original's part
 * apart from Sweden's.
 *
 * Source and licence names are proper names and stay as written; the rest is
 * marked for translation. Counts are rounded ("about"), since the feeds move.
 */
import { msg, t } from '../i18n/index.js';

const CC0 = 'CC0 1.0';
const CC_BY = 'CC BY 4.0';
const CREDIT = msg('Open data, source credited');
const NO_LICENCE = msg('No licence stated; source credited');

const own = (entry) => Object.freeze({ mark: 'se', ...entry });
const added = (entry) => Object.freeze({ mark: 'plus-se', ...entry });

export const LAYER_PROVENANCE = Object.freeze({
  // Movement
  transit: added({
    // The panel names the providers, not only the feed format.
    meta: 'GTFS-RT · Trafiklab · Trafikverket',
    source: 'Trafiklab (Samtrafiken) · Trafikverket',
    sweden: msg(
      'Buses, metro, trams and commuter trains of 16 regional operators, and trains with their delays',
    ),
    original: msg(
      'Open GTFS-RT feeds in the USA, Canada, Finland, the Netherlands, Norway, Australia and Brazil',
    ),
    updates: msg('Every 15 seconds'),
    licence: `${CC0} (Trafiklab, Trafikverket)`,
  }),
  // Cameras
  cctv: added({
    source: 'Trafikverket',
    sweden: msg('About 1,550 road cameras with live stills'),
    original: msg('Public traffic cameras in many countries'),
    updates: msg('Stills refresh while shown'),
    licence: `${CC0} (Trafikverket)`,
  }),
  // Infrastructure
  'speed-cameras': own({
    source: 'Trafikverket',
    coverage: msg('About 2,800 fixed speed cameras, all of Sweden'),
    updates: msg('Hourly'),
    licence: CC0,
  }),
  'electricity-prices': own({
    source: 'elprisetjustnu.se · Nord Pool via ENTSO-E',
    coverage: msg('Spot price per quarter hour in bidding areas SE1–SE4'),
    updates: msg('Every minute'),
    // Elpriset just nu offers its API free for any use, but the prices are
    // Nord Pool's, read from ENTSO-E, where day-ahead prices are not on the
    // list of data free for re-use.
    licence: msg(
      'Free to use per Elpriset just nu; prices from Nord Pool via ENTSO-E',
    ),
  }),
  'power-grid': own({
    source: 'ENTSO-E · Svenska kraftnät',
    coverage: msg(
      "Sweden's links between bidding areas and to neighbouring countries",
    ),
    updates: msg('Every 5 minutes'),
    licence: msg(
      'Flows from ENTSO-E: CC BY 4.0; Svenska kraftnät (POWER_GRID_SOURCE=svk): no published licence',
    ),
  }),
  'gamma-radiation': own({
    source: 'Strålsäkerhetsmyndigheten (SSM)',
    coverage: msg('About 25 gamma stations'),
    updates: msg('Every 10 minutes'),
    licence: NO_LICENCE,
  }),
  'fire-stations': own({
    source: 'Myndigheten för civilt försvar (MCF)',
    coverage: msg('All fire stations of the municipal rescue services'),
    updates: msg('Daily'),
    licence: msg('EU high-value dataset, source credited'),
  }),
  'police-stations': own({
    source: 'Polismyndigheten',
    coverage: msg('All police stations, about 260'),
    updates: msg('Daily'),
    licence: CREDIT,
  }),
  shelters: own({
    source: 'Myndigheten för civilt försvar (MCF)',
    coverage: msg(
      'All civil-defence shelters, about 63,000 with 6.8 million places',
    ),
    updates: msg('Daily'),
    licence: msg('No conditions apply (INSPIRE)'),
  }),
  hospitals: own({
    source: 'Socialstyrelsen · OpenStreetMap',
    coverage: msg(
      'About 120 hospitals; waiting-time medians for the 62 emergency departments in the statistics',
    ),
    updates: msg('Yearly statistics; snapshot in the app, rebuilt by hand'),
    licence: msg(
      'Statistics free to use, source credited (Socialstyrelsen) · ODbL (OpenStreetMap)',
    ),
  }),
  municipalities: own({
    source: 'OpenStreetMap · SCB',
    coverage: msg(
      'All 290 municipalities and 21 counties, with population by month',
    ),
    updates: msg('Snapshot in the app, rebuilt by hand'),
    licence: `ODbL (OpenStreetMap) · ${CC0} (SCB)`,
  }),
  'company-stores': own({
    source: 'OpenStreetMap · Wikidata · SCB',
    coverage: msg(
      'Stores and pharmacies of nine chains, all of Sweden; mapped by volunteers',
    ),
    updates: msg('Snapshot in the app, rebuilt by hand'),
    licence: `ODbL (OpenStreetMap) · ${CC0} (Wikidata, SCB)`,
  }),
  // Events
  'trafikverket-roads': own({
    source: 'Trafikverket',
    coverage: msg('Winter road condition and current incidents, all of Sweden'),
    updates: msg('Every 3 minutes'),
    licence: CC0,
  }),
  'trafikverket-weather': own({
    source: 'Trafikverket',
    coverage: msg('About 830 road weather stations'),
    updates: msg('Every 5 minutes'),
    licence: CC0,
  }),
  'polisen-events': own({
    source: 'Polismyndigheten',
    coverage: msg('The 500 latest notices, about ten days, all of Sweden'),
    updates: msg('Every 5 minutes'),
    licence: CREDIT,
  }),
  'sr-traffic': own({
    source: 'Sveriges Radio',
    coverage: msg('Current traffic messages, all of Sweden'),
    updates: msg('Every 3 minutes'),
    licence: msg(
      "Sveriges Radio's API terms: shown unmodified, credited and linked",
    ),
  }),
  'transit-alerts': own({
    source: 'Trafiklab (Samtrafiken)',
    coverage: msg('Disruptions at the stops of 16 regional operators'),
    updates: msg('Every 2 minutes'),
    licence: CC0,
  }),
  // Weather
  'air-quality': added({
    source: 'SMHI',
    sweden: msg('About 75 measuring stations on the European EAQI scale'),
    original: msg('Canadian stations (ECCC AQHI)'),
    updates: msg('Hourly'),
    licence: `${CC_BY} (SMHI)`,
  }),
  'weather-radar': added({
    source: 'SMHI · EUMETNET OPERA',
    sweden: msg('Nordic radar from SMHI and European radar from OPERA'),
    original: msg('Radar over the USA (NOAA)'),
    updates: msg('Every 5 minutes'),
    licence: `${CC_BY} (SMHI, OPERA)`,
  }),
  'smhi-warnings': own({
    source: 'SMHI · Krisinformation.se',
    coverage: msg(
      'Weather warnings, VMA alerts and crisis news, all of Sweden',
    ),
    updates: msg('Every 5 minutes'),
    licence: `${CC_BY} (SMHI)`,
  }),
  'smhi-weather': own({
    source: 'SMHI',
    coverage: msg('About 185 weather stations, and a forecast where you click'),
    updates: msg('Every 10 minutes'),
    licence: CC_BY,
  }),
  'sea-weather': own({
    source: 'Sjöfartsverket ViVa · SMHI',
    coverage: msg(
      'About 160 stations on the coast, the large lakes and canals',
    ),
    updates: msg('Every 10 minutes'),
    // No terms are published for ViVa.
    licence: msg(
      'Sjöfartsverket ViVa: no published licence; SMHI (SEA_WEATHER_SOURCE=smhi): CC BY 4.0',
    ),
  }),
  'river-flow': own({
    source: 'SMHI',
    coverage: msg('About 150 river stations'),
    updates: msg('Quarter-hourly readings, published with a delay'),
    licence: CC_BY,
  }),
  aurora: own({
    source: 'NOAA SWPC',
    coverage: msg(
      'Northern hemisphere, with the chance over nine Swedish places',
    ),
    updates: msg('Every 10 minutes'),
    licence: msg('Public domain (US government)'),
  }),
  'weather-lightning': added({
    source: 'EUMETSAT (MTG)',
    sweden: msg('Lightning over Europe and Africa from the MTG satellite'),
    original: msg('Lightning density over the Americas (NOAA)'),
    updates: msg('Every 5 minutes'),
    licence: msg('Free to use, source credited'),
  }),
  'lightning-strikes': own({
    source: 'DMI',
    coverage: msg('Every stroke over the Nordics in the last hour'),
    updates: msg('Every minute'),
    licence: CC_BY,
  }),
});

/** Whether a layer carries the fork's Swedish data. */
export function hasSwedishData(id) {
  return Boolean(LAYER_PROVENANCE[id]);
}

/** The mark a layer's row shows, or null. */
export function presentProvenanceMark(id) {
  const entry = LAYER_PROVENANCE[id];
  if (!entry) return null;
  return entry.mark === 'se'
    ? { text: 'SE', title: t('Swedish data layer') }
    : { text: '+SE', title: t('Swedish data added to this layer') };
}

/** The lines the row's ⓘ details show, labelled, or null. */
export function presentProvenanceDetails(id) {
  const entry = LAYER_PROVENANCE[id];
  if (!entry) return null;
  const line = (label, text) => ({ label: t(label), text });
  const lines = [line(msg('Source'), entry.source)];
  if (entry.mark === 'se') lines.push(line(msg('Coverage'), t(entry.coverage)));
  else
    lines.push(
      line(msg('Sweden (this fork)'), t(entry.sweden)),
      line(msg('Original app'), t(entry.original)),
    );
  lines.push(
    line(msg('Updates'), t(entry.updates)),
    // A licence is either a translated phrase or names as written.
    line(msg('Licence'), translatedOrName(entry.licence)),
  );
  return lines;
}

const PHRASES = new Set([
  CREDIT,
  NO_LICENCE,
  msg('EU high-value dataset, source credited'),
  msg('Public domain (US government)'),
  msg('Free to use, source credited'),
  msg('No conditions apply (INSPIRE)'),
  msg(
    'Statistics free to use, source credited (Socialstyrelsen) · ODbL (OpenStreetMap)',
  ),
]);
function translatedOrName(text) {
  return PHRASES.has(text) ? t(text) : text;
}

/** The provider line a row's metadata shows instead of the feed's own. */
export function provenanceMetaSource(id) {
  return LAYER_PROVENANCE[id]?.meta ?? null;
}

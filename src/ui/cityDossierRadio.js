/**
 * Sveriges Radio's local P4 channel for a town, as a link to the channel's
 * page at sverigesradio.se. The dossier links rather than plays: SR's terms
 * let third parties use its linear channels only with SR's written approval.
 * Pages checked 2026-11-12 (sverigesradio.se/nyheter/p4-…). Pure — no DOM.
 */

const SR_P4_BASE = 'https://www.sverigesradio.se/nyheter/p4-';

/** The P4 channel per county; a list is chosen between by the nearest home. */
const COUNTY_CHANNELS = Object.freeze({
  Stockholm: 'Stockholm',
  Uppsala: 'Uppland',
  Södermanland: 'Sörmland',
  Östergötland: 'Östergötland',
  Jönköping: 'Jönköping',
  Kronoberg: 'Kronoberg',
  Kalmar: 'Kalmar',
  Gotland: 'Gotland',
  Blekinge: 'Blekinge',
  Skåne: [
    ['Malmöhus', 13.0, 55.6],
    ['Kristianstad', 14.16, 56.03],
  ],
  Halland: 'Halland',
  'Västra Götaland': [
    ['Göteborg', 11.97, 57.71],
    ['Väst', 12.29, 58.28],
    ['Sjuhärad', 12.94, 57.72],
    ['Skaraborg', 13.85, 58.39],
  ],
  Värmland: 'Värmland',
  Örebro: 'Örebro',
  Västmanland: 'Västmanland',
  Dalarna: 'Dalarna',
  Gävleborg: 'Gävleborg',
  Västernorrland: 'Västernorrland',
  Jämtland: 'Jämtland',
  Västerbotten: 'Västerbotten',
  Norrbotten: 'Norrbotten',
});

const slug = (name) =>
  name.toLowerCase().replace(/[åä]/g, 'a').replace(/ö/g, 'o');

/**
 * The local P4 channel for a town, or null outside Sweden's counties.
 * @param {{county?: string, point?: number[]}} city
 * @returns {{name: string, url: string} | null}
 */
export function localP4Channel(city) {
  const county = String(city?.county || '').replace(/s? län$/, '');
  let channel = COUNTY_CHANNELS[county];
  if (Array.isArray(channel)) {
    const [lon, lat] = city?.point ?? [];
    channel = Number.isFinite(lon)
      ? channel.reduce((best, next) =>
          Math.hypot(next[1] - lon, next[2] - lat) <
          Math.hypot(best[1] - lon, best[2] - lat)
            ? next
            : best,
        )[0]
      : channel[0][0];
  }
  if (!channel) return null;
  return { name: `P4 ${channel}`, url: `${SR_P4_BASE}${slug(channel)}` };
}

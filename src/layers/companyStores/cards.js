/** Card model for a selected store. Pure — no Cesium types. */
import { formatNumber, t, tn } from '../../i18n/index.js';
import { openingState } from './openingHours.js';
import { companyById, storeColor } from './records.js';

export const COMPANY_STORES_OVERLAY_SOURCE_ID = 'company-stores';

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/** The radius the card counts nearby chain stores in. */
export const NEIGHBOUR_RADIUS_M = 5000;

/**
 * One line about the company behind a store, from its Wikidata facts.
 * @param {object|undefined} facts `{legalName, orgNumber, headOffice}`.
 */
export function companyLine(company, facts) {
  const parts = [facts?.legalName || company?.name].filter(Boolean);
  if (facts?.orgNumber)
    parts.push(t('org. no. {number}', { number: facts.orgNumber }));
  if (facts?.headOffice)
    parts.push(t('head office {place}', { place: facts.headOffice }));
  return parts.join(' · ');
}

/** Great-circle metres between two `[lon, lat]` points. */
export function distanceMeters([lon1, lat1], [lon2, lat2]) {
  const rad = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
    Math.cos(lat1 * rad) *
      Math.cos(lat2 * rad) *
      Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * The nearest store of each other company, nearest first, and how many other
 * stores of any listed chain lie within `NEIGHBOUR_RADIUS_M`.
 */
export function storeNeighbours(row, stores, limit = 3) {
  const nearest = new Map();
  let within = 0;
  for (const other of stores) {
    if (other.id === row.id) continue;
    const distance = distanceMeters(row.point, other.point);
    if (distance <= NEIGHBOUR_RADIUS_M) within++;
    if (other.company === row.company) continue;
    const best = nearest.get(other.company);
    if (!best || distance < best.distance)
      nearest.set(other.company, { store: other, distance });
  }
  return {
    nearest: [...nearest.values()]
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit),
    within,
  };
}

/** A distance as "350 m" or "1.2 km" in the reader's number format. */
export function formatDistance(meters) {
  return meters < 1000
    ? t('{distance} m', {
        distance: formatNumber(Math.max(10, Math.round(meters / 10) * 10)),
      })
    : t('{distance} km', {
        distance: formatNumber(meters / 1000, {
          minimumFractionDigits: 1,
          maximumFractionDigits: 1,
        }),
      });
}

/** "Open now · closes 21:00" and the like, or null when hours are unknown. */
export function openingLine(hours, now = new Date()) {
  const state = openingState(hours, now);
  if (!state) return null;
  if (state.open)
    return state.closes
      ? t('Open now · closes {time}', { time: state.closes })
      : t('Open around the clock');
  if (state.inDays === 0)
    return t('Closed now · opens {time}', { time: state.opens });
  if (state.inDays === 1)
    return t('Closed now · opens tomorrow {time}', { time: state.opens });
  return t('Closed now');
}

const WHEELCHAIR = {
  yes: () => t('Wheelchair accessible'),
  limited: () => t('Partly wheelchair accessible'),
  no: () => t('Not wheelchair accessible'),
};

/** Size, access and parcel service as one line, or null. */
function factsLine(row) {
  const parts = [];
  if (row.area)
    parts.push(t('about {area} m² mapped', { area: formatNumber(row.area) }));
  if (row.wheelchair) parts.push(WHEELCHAIR[row.wheelchair]());
  if (row.post != null)
    parts.push(
      row.post
        ? t('Parcel service ({brand})', { brand: row.post })
        : t('Parcel service'),
    );
  return parts.length ? parts.join(' · ') : null;
}

/**
 * Card for one store.
 * @param {object} row The store.
 * @param {object} facts Company ids to their Wikidata facts.
 * @param {object} [options]
 * @param {object[]} [options.stores] Every store, for the nearby chains.
 * @param {number|null} [options.populationYear] Year of the SCB grid.
 * @param {boolean} [options.linkable] Whether a click can open its web page.
 * @param {Date} [options.now] The moment "open now" is read at.
 */
export function buildStoreCard(
  row,
  facts = {},
  {
    stores = [],
    populationYear = null,
    linkable = false,
    now = new Date(),
  } = {},
) {
  const company = companyById(row.company);
  const opening = openingLine(row.hours, now);
  const neighbours = stores.length ? storeNeighbours(row, stores) : null;
  const link = linkable && row.website;
  const details = [
    ...(row.brand && row.brand !== row.name ? [row.brand] : []),
    ...(row.address ? [row.address] : []),
    ...(opening ? [opening] : []),
    ...(row.hours ? [t('Hours: {hours}', { hours: row.hours })] : []),
    ...(row.checked
      ? [t('Hours checked on site {date}', { date: row.checked })]
      : []),
    ...(factsLine(row) ? [factsLine(row)] : []),
    ...(row.phone ? [t('Phone {phone}', { phone: row.phone })] : []),
    ...(row.population != null
      ? [
          t('About {count} people live within 2 km (SCB {year})', {
            count: formatNumber(row.population),
            year: populationYear ?? '',
          }),
        ]
      : []),
    ...(row.stop
      ? [
          t('Nearest stop: {name}, {distance}', {
            name: row.stop.name,
            distance: formatDistance(row.stop.distance),
          }),
        ]
      : []),
    ...(neighbours?.nearest.length
      ? [
          t('Nearest other chains: {list}', {
            list: neighbours.nearest
              .map(
                ({ store, distance }) =>
                  `${store.brand || companyById(store.company)?.name} ${formatDistance(distance)}`,
              )
              .join(' · '),
          }),
          tn(
            neighbours.within,
            '{count} chain store within 5 km',
            '{count} chain stores within 5 km',
            { count: neighbours.within },
          ),
        ]
      : []),
    companyLine(company, facts[row.company]),
    ...(link ? [t('Store web page ↗ · click card to open')] : []),
    // i18n-ignore: source and licence names
    row.population != null
      ? '© OpenStreetMap · ODbL · SCB'
      : '© OpenStreetMap · ODbL',
  ];
  const title = row.name.toUpperCase();
  return {
    ...CARD_BASE,
    id: `company-stores-card:${row.id}`,
    interactive: Boolean(link),
    ...(link
      ? { accessibilityLabel: t('Open the web page of {title}', { title }) }
      : undefined),
    title,
    details,
    accent: storeColor(row),
  };
}

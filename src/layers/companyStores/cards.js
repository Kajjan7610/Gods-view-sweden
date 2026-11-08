/** Card model for a selected store. Pure — no Cesium types. */
import { t } from '../../i18n/index.js';
import { companyById, storeColor } from './records.js';

export const COMPANY_STORES_OVERLAY_SOURCE_ID = 'company-stores';

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

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

/** Card for one store; `facts` maps company ids to their Wikidata facts. */
export function buildStoreCard(row, facts = {}) {
  const company = companyById(row.company);
  const details = [
    ...(row.brand && row.brand !== row.name ? [row.brand] : []),
    ...(row.address ? [row.address] : []),
    ...(row.hours ? [t('Hours: {hours}', { hours: row.hours })] : []),
    companyLine(company, facts[row.company]),
    // i18n-ignore: source and licence names
    '© OpenStreetMap · ODbL',
  ];
  return {
    ...CARD_BASE,
    id: `company-stores-card:${row.id}`,
    interactive: false,
    title: row.name.toUpperCase(),
    details,
    accent: storeColor(row),
  };
}

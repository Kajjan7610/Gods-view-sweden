/** Card text for an election district. Pure — no Cesium types. */
import { formatNumber, t } from '../../i18n/index.js';
import { OTHER_PARTIES, PARTIES, leadingParty } from './records.js';

export const ELECTION_DISTRICTS_OVERLAY_SOURCE_ID = 'election-districts';

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/** Tenths of a percent as "31.4 %". */
export const percentText = (perMille) =>
  `${formatNumber(perMille / 10, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })} %`;

/**
 * Card for one district: its municipality, votes counted and turnout, and
 * every Riksdag party's share as Valmyndigheten counted it, largest first.
 * @param {object} district A snapshot district.
 */
export function buildDistrictCard(district) {
  const shares = Array.isArray(district.s) ? district.s : [];
  const parties = [...PARTIES, OTHER_PARTIES]
    .map((party, index) => ({ party, share: shares[index] ?? 0 }))
    .filter(({ share }) => share > 0)
    .sort((a, b) => b.share - a.share)
    .map(({ party, share }) =>
      party === OTHER_PARTIES
        ? t('Other parties {share}', { share: percentText(share) })
        : `${party.id} ${percentText(share)}`,
    );
  const details = [
    t('{municipality} municipality', { municipality: district.m }),
    ...(Number.isFinite(district.v)
      ? [
          Number.isFinite(district.t)
            ? t('{votes} votes counted here · turnout {turnout}', {
                votes: formatNumber(district.v),
                turnout: percentText(district.t),
              })
            : t('{votes} votes counted here', {
                votes: formatNumber(district.v),
              }),
        ]
      : [t('No votes counted here')]),
    // Three parties to a line keeps the card short.
    ...Array.from({ length: Math.ceil(parties.length / 3) }, (_, i) =>
      parties.slice(i * 3, i * 3 + 3).join(' · '),
    ),
    t('Riksdag election 2026, final count · Valmyndigheten'),
  ];
  return {
    ...CARD_BASE,
    id: `election-district-card:${district.c}`,
    // Interactive only so a click on the card is told from one on the ground.
    interactive: true,
    title: t('ELECTION DISTRICT · {name}', { name: district.n }),
    details,
    accent: leadingParty(shares)?.color ?? OTHER_PARTIES.color,
  };
}

// Swedish fork: Trafikverket's national train feed names no region, so a
// Swedish train card no longer reads "… · Trafikverket · Sweden", and the
// line it leaves keeps no trailing " · ".
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildRailSelectionCopy } from './policy.js';
import { RAIL_FEED_REGISTRY } from '../../data/railFeeds.js';
import { setLocale, t } from '../../i18n/index.js';

const TRAFIKVERKET = RAIL_FEED_REGISTRY.find(
  (feed) => feed.id === 'trafikverket-trains',
);

test('a Swedish train card names no region and leaves no " · "', () => {
  assert.equal(TRAFIKVERKET.region, '');
  setLocale('sv');
  try {
    const { details } = buildRailSelectionCopy(
      TRAFIKVERKET,
      {
        id: '2861-20261121',
        label: 'Tåg 2861',
        routeId: '2861',
        category: 'regional',
        mode: 'rail',
        lat: 59.33,
        lon: 18.07,
        timestamp: 0,
      },
      0,
      null,
      null,
      t,
    );
    assert.match(details[0], / · Trafikverket$/);
    assert.doesNotMatch(details.join(' | '), /Sweden|Sverige/);
  } finally {
    setLocale('en');
  }
  // A feed with a region keeps it, in English as before.
  const boston = buildRailSelectionCopy(
    { name: 'MBTA', region: 'Boston, MA' },
    { id: '1712', category: 'local', mode: 'rail', timestamp: 0 },
    0,
  );
  assert.match(boston.details[0], / · MBTA · Boston, MA$/);
});

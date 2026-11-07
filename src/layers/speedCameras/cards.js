/** Card model for a selected speed camera site. Pure — no Cesium types. */
import { msg, t } from '../../i18n/index.js';
import { COMPASS, compassIndex } from './records.js';

export const SPEED_CAMERAS_OVERLAY_SOURCE_ID = 'speed-cameras';
export const CAMERA_COLOR = '#ffb300';

/** The compass points, written out. */
const DIRECTIONS = Object.freeze({
  N: msg('north'),
  NE: msg('northeast'),
  E: msg('east'),
  SE: msg('southeast'),
  S: msg('south'),
  SW: msg('southwest'),
  W: msg('west'),
  NW: msg('northwest'),
});

/** "facing 85° (east)", or '' without a bearing. */
export function facingText(bearing) {
  if (!Number.isFinite(bearing)) return '';
  return t('facing {degrees}° ({direction})', {
    degrees: Math.round(bearing),
    direction: t(DIRECTIONS[COMPASS[compassIndex(bearing)]]),
  });
}

const CARD_BASE = Object.freeze({
  selected: true,
  priority: Number.MAX_SAFE_INTEGER,
  gapPx: 15,
  verticalOnly: true,
  placement: 'above',
});

/** Card for one camera site. */
export function buildSpeedCameraCard(row) {
  return {
    ...CARD_BASE,
    id: `speed-camera-card:${row.id}`,
    interactive: false,
    title: row.road
      ? t('SPEED CAMERA · {road}', { road: row.road })
      : t('SPEED CAMERA'),
    details: [
      row.name,
      [facingText(row.bearing), row.county].filter(Boolean).join(' · '),
      t('The police move the cameras between sites'),
      'Trafikverket', // i18n-ignore: agency name
    ].filter(Boolean),
    accent: CAMERA_COLOR,
  };
}

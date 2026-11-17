/**
 * @module maps/attribution
 * @description The on-map credits of the map stacks' sources, and Esri
 * World Imagery's tile address, which the globe and the card previews share.
 */

// Attribution and service rights are documented in DATA_SOURCES.md.
/**
 * Esri World Imagery's tiles; Stories' card images draw from the same.
 * Swedish fork: the keyed service, asked only with a key (see esriTiles).
 */
export const ESRI_TILES =
  'https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
/** Esri World Imagery's credit line, as plain text. */
export const ESRI_IMAGERY_CREDIT =
  'Powered by Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';
// Esri's attribution rules want "Powered by Esri" and the data sources on
// the map itself.
export const ESRI_ATTRIBUTION_HTML =
  '<a href="https://www.esri.com" target="_blank" rel="noopener">Powered by Esri</a> · Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';

/**
 * OpenStreetMap's tile policy wants the licence attribution visible on the
 * map itself, not behind a toggle (operations.osmfoundation.org/policies/tiles).
 */
export const OSM_ATTRIBUTION_HTML =
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>';

/**
 * Swedish fork: Esri's satellite basemap needs an ArcGIS Location Platform
 * key (free tier, "Basemaps" only). The key is public by design, injected
 * into the browser like the Cesium ion token, and restricted at Esri to this
 * app's addresses. Without it the keyless map is OpenStreetMap, and nothing
 * else asks Esri for tiles.
 */
export function arcgisApiKey() {
  return String(import.meta.env?.ARCGIS_API_KEY ?? '').trim();
}

/**
 * Esri World Imagery's tile address with the key on it, or '' without a key:
 * then a caller draws no Esri tile at all.
 */
export function esriTiles(token = arcgisApiKey()) {
  return token ? `${ESRI_TILES}?token=${encodeURIComponent(token)}` : '';
}

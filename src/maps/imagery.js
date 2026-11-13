import * as Cesium from 'cesium';

// Attribution and service rights are documented in DATA_SOURCES.md.
// Esri's attribution rules want "Powered by Esri" and the data sources on
// the map itself.
export const ESRI_ATTRIBUTION_HTML =
  '<a href="https://www.esri.com" target="_blank" rel="noopener">Powered by Esri</a> · Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community';

/**
 * Swedish fork: Esri's satellite basemap needs an ArcGIS Location Platform
 * key (free tier, "Basemaps" only). The key is public by design, injected
 * into the browser like the Cesium ion token, and restricted at Esri to this
 * app's addresses. Without it the keyless map is OpenStreetMap.
 */
export function arcgisApiKey() {
  return String(import.meta.env?.ARCGIS_API_KEY ?? '').trim();
}

/**
 * OpenStreetMap's tile policy wants the licence attribution visible on the
 * map itself, not behind a toggle (operations.osmfoundation.org/policies/tiles).
 */
export const OSM_ATTRIBUTION_HTML =
  '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap contributors</a>';

export function createOsmImagery() {
  return new Cesium.OpenStreetMapImageryProvider({
    url: 'https://tile.openstreetmap.org/',
    credit: '© OpenStreetMap contributors',
  });
}

export function createEsriImagery(token = arcgisApiKey()) {
  if (!token) throw new Error('Esri imagery requires ARCGIS_API_KEY');
  // The keyed World Imagery service (ibasemaps-api.arcgis.com).
  return Cesium.ArcGisMapServerImageryProvider.fromBasemapType(
    Cesium.ArcGisBaseMapType.SATELLITE,
    {
      token,
      credit:
        'Powered by Esri — Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community',
      enablePickFeatures: false,
    },
  );
}

export function createIonImagery(style, accessToken) {
  accessToken = String(accessToken || '').trim();
  if (!accessToken) throw new Error('Ion imagery requires an explicit token');
  if (
    style === Cesium.IonWorldImageryStyle.AERIAL ||
    style === Cesium.IonWorldImageryStyle.AERIAL_WITH_LABELS
  ) {
    return createBingIonImagery(style, accessToken);
  }
  return Cesium.IonImageryProvider.fromAssetId(style, { accessToken });
}

async function createBingIonImagery(style, accessToken) {
  const endpoint = await new Cesium.Resource({
    url: `https://api.cesium.com/v1/assets/${style}/endpoint`,
    queryParameters: { access_token: accessToken },
  }).fetchJson();
  if (
    endpoint?.type !== 'IMAGERY' ||
    endpoint.externalType !== 'BING' ||
    typeof endpoint.options?.url !== 'string'
  ) {
    throw new Error('Ion world imagery did not return a Bing imagery endpoint');
  }
  // Bing otherwise follows the page's HTTP scheme on localhost. Resolve its
  // ion-issued credentials through public APIs so tiles use HTTPS without
  // weakening CSP, changing SDK defaults or touching provider internals.
  const { url, ...options } = endpoint.options;
  const provider = await Cesium.BingMapsImageryProvider.fromUrl(url, {
    ...options,
    tileProtocol: 'https',
  });
  const ionCredits = (endpoint.attributions ?? []).map(
    ({ html, collapsible }) => new Cesium.Credit(html, collapsible === false),
  );
  const getTileCredits = provider.getTileCredits.bind(provider);
  provider.getTileCredits = (x, y, level) => [
    ...ionCredits,
    ...(getTileCredits(x, y, level) ?? []),
  ];
  return provider;
}

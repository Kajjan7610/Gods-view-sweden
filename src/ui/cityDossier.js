/**
 * The city dossier: when the view settles low over a Swedish town, the right
 * rail's CITY panel presents that town — its introduction and photo, its
 * population and trend, its municipality's key figures and election, and
 * what is happening there now (weather, warnings, air, police, sun, local
 * radio). Facts come from /api/city-dossier; the live part reuses the
 * briefing, air quality and police routes the layers already use.
 */
import * as Cesium from 'cesium';
import {
  formatNumber,
  getLocale,
  msg,
  onLocaleChange,
  t,
  tn,
} from '../i18n/index.js';
import { normalizeSmhiReadings } from '../layers/airQuality/model.js';
import { weatherCodeLabel } from '../data/regionalModel.js';
import {
  electionYear,
  nearestReading,
  policeEventsFor,
  populationChange,
  sparklinePoints,
  sunTimes,
} from './cityDossierModel.js';

const PANEL_ID = 'city-panel';
/** Higher than this the view is looking at a region, not visiting a town. */
const MAX_VISIT_HEIGHT_M = 80_000;
const SETTLE_DELAY_MS = 500;
const LIVE_TTL_MS = 10 * 60_000;
const SWEDEN = Object.freeze({
  west: 10.5,
  south: 55,
  east: 24.3,
  north: 69.1,
});
const TABS = Object.freeze([
  ['about', msg('ABOUT')],
  ['people', msg('POPULATION')],
  ['society', msg('SOCIETY')],
  ['now', msg('NOW')],
]);
const PARTY_COLORS = Object.freeze({
  S: '#ed1b34',
  V: '#af0000',
  MP: '#83cf39',
  SD: '#dddd00',
  M: '#52bdec',
  L: '#006ab3',
  C: '#009933',
  KD: '#231977',
  other: '#9e9e9e',
});
const ALERT_LEVEL_KEYS = Object.freeze({
  VMA: msg('PUBLIC ALERT'),
  MESSAGE: msg('Message'),
  YELLOW: msg('Yellow warning'),
  ORANGE: msg('Orange warning'),
  RED: msg('Red warning'),
});
const SEK = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 });

const clock = (ms) =>
  new Intl.DateTimeFormat(getLocale(), {
    timeZone: 'Europe/Stockholm',
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms);
const whole = (value) => formatNumber(Math.round(value));
const oneDecimal = (value) =>
  formatNumber(value, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const bilingual = (value) =>
  !value || typeof value === 'string'
    ? value || ''
    : String(getLocale() || '').startsWith('sv')
      ? value.sv
      : value.en;

/**
 * Own the dossier for one viewer: watch the camera settle, fetch the town
 * and its live picture, and publish the panel's view.
 */
export function createCityDossier({
  viewer,
  dataManager,
  publish,
  connect,
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
  documentRef = globalThis.document,
}) {
  let destroyed = false;
  let timer = null;
  let request = null;
  let liveRequest = null;
  let city = null;
  let facts = null;
  let live = null;
  let liveAt = 0;
  let tab = 'about';
  let status = 'idle';
  let radioBusy = false;
  let appeared = false;

  function viewCenter() {
    const canvas = viewer.scene.canvas;
    const height = viewer.camera.positionCartographic?.height;
    if (!Number.isFinite(height) || height > MAX_VISIT_HEIGHT_M) return null;
    const hit = viewer.camera.pickEllipsoid(
      new Cesium.Cartesian2(canvas.clientWidth / 2, canvas.clientHeight / 2),
    );
    if (!hit) return null;
    const carto = Cesium.Cartographic.fromCartesian(hit);
    const lat = Cesium.Math.toDegrees(carto.latitude);
    const lon = Cesium.Math.toDegrees(carto.longitude);
    if (
      lon < SWEDEN.west ||
      lon > SWEDEN.east ||
      lat < SWEDEN.south ||
      lat > SWEDEN.north
    )
      return null;
    return { lat, lon };
  }

  async function getJson(url, signal) {
    const response = await fetchImpl(url, { signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }

  async function visit() {
    timer = null;
    if (destroyed || documentRef?.body?.classList?.contains('cockpit-mode'))
      return;
    const center = viewCenter();
    if (!center) return;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    try {
      const body = await getJson(
        `/api/city-dossier?lat=${center.lat.toFixed(4)}&lon=${center.lon.toFixed(4)}`,
        controller.signal,
      );
      if (destroyed || request !== controller || !body?.city) return;
      if (body.city.code !== city?.code) {
        city = body.city;
        facts = body.error ? null : body;
        status = body.error ? 'error' : 'ready';
        live = null;
        liveAt = 0;
        render();
        openOnFirstVisit();
      }
      if (now() - liveAt > LIVE_TTL_MS) void loadLive();
    } catch (error) {
      if (error?.name !== 'AbortError')
        console.warn('[CityDossier] lookup failed:', error?.message || error);
    } finally {
      if (request === controller) request = null;
    }
  }

  async function loadLive() {
    if (!city) return;
    liveRequest?.abort();
    const controller = new AbortController();
    liveRequest = controller;
    const forCity = city;
    const [lon, lat] = forCity.point;
    liveAt = now();
    const [brief, air, police] = await Promise.allSettled([
      getJson(
        `/api/regional-brief?latitude=${lat}&longitude=${lon}`,
        controller.signal,
      ),
      getJson('/api/air-quality-se', controller.signal),
      getJson('/api/polisen-events', controller.signal),
    ]);
    if (destroyed || liveRequest !== controller || city !== forCity) return;
    live = {
      brief: brief.status === 'fulfilled' ? brief.value : null,
      air:
        air.status === 'fulfilled'
          ? nearestReading(
              normalizeSmhiReadings(air.value?.stations, now()),
              forCity.point,
            )
          : null,
      police:
        police.status === 'fulfilled'
          ? policeEventsFor(police.value?.events, forCity, now())
          : null,
    };
    liveRequest = null;
    render();
  }

  function openOnFirstVisit() {
    if (appeared || !documentRef) return;
    appeared = true;
    // Like Recent Imagery: the first appearance opens the panel unless a
    // stored collapse choice exists.
    const panel = documentRef.getElementById?.(PANEL_ID);
    const preference = panel?.dataset?.collapsedPreference;
    if (
      panel?.classList.contains('collapsed') &&
      (preference === undefined || preference === 'default')
    )
      panel.querySelector?.(`[data-collapse-target="${PANEL_ID}"]`)?.click();
  }

  async function playRadio() {
    if (!city || radioBusy) return false;
    radioBusy = true;
    render();
    try {
      await dataManager.setEnabled('radio', true, { origin: 'user' });
      const radio = dataManager.layers.get('radio')?.module;
      for (let i = 0; i < 50 && !radio?.getUIState?.()?.stationCount; i += 1)
        await new Promise((resolve) => setTimeout(resolve, 100));
      const [lon, lat] = city.point;
      // Sveriges Radio's local channel by the town ("P4 Göteborg") or the
      // county ("P4 Gävleborg"), else the nearest Swedish station.
      const county = String(city.county || '').replace(/s? län$/, '');
      for (const stationQuery of [`P4 ${city.name}`, `P4 ${county}`, '']) {
        const station = radio?.selectRequestedStation?.(
          {
            categoryId: 'all',
            anchor: { lat, lon },
            country: 'SE',
            stationQuery,
          },
          { autoplay: true, origin: 'user' },
        );
        if (station) return true;
      }
      return false;
    } finally {
      radioBusy = false;
      render();
    }
  }

  // ---- presentation -------------------------------------------------------
  function aboutView() {
    const wiki = facts?.wikipedia;
    const town = facts?.town;
    const rows = [];
    if (Number.isFinite(town?.founded))
      rows.push({ label: t('Founded'), value: String(town.founded) });
    if (Number.isFinite(town?.elevation))
      rows.push({
        label: t('Elevation'),
        value: t('{value} m above sea level', { value: whole(town.elevation) }),
      });
    return {
      image: wiki?.image || null,
      extract: wiki?.extract || '',
      rows,
      credit: wiki?.url
        ? { text: t('Text from Wikipedia (CC BY-SA 4.0)'), url: wiki.url }
        : null,
    };
  }

  function peopleView() {
    const municipality = facts?.municipality;
    const town = facts?.town;
    const rows = [];
    if (Number.isFinite(town?.population))
      rows.push({
        label: t('Town ({name})', { name: city.name }),
        value: whole(town.population),
        detail: town.populationYear ? String(town.populationYear) : '',
      });
    if (municipality?.population)
      rows.push({
        label: t('Municipality'),
        value: whole(municipality.population.value),
        // SCB's monthly count names its month; Kolada's its year.
        detail: Number.isFinite(municipality.population.month)
          ? new Intl.DateTimeFormat(getLocale(), {
              month: 'short',
              year: 'numeric',
              timeZone: 'UTC',
            }).format(
              Date.UTC(
                municipality.population.year,
                municipality.population.month - 1,
                15,
              ),
            )
          : String(municipality.population.year),
      });
    if (
      Number.isFinite(municipality?.population?.men) &&
      Number.isFinite(municipality?.population?.women)
    )
      rows.push({
        label: t('Women / men'),
        value: `${whole(municipality.population.women)} / ${whole(municipality.population.men)}`,
        detail: '',
      });
    if (municipality?.meanAge)
      rows.push({
        label: t('Mean age'),
        value: t('{value} years', {
          value: oneDecimal(municipality.meanAge.value),
        }),
        detail: String(municipality.meanAge.year),
      });
    const history = municipality?.populationHistory || [];
    const change = populationChange(history);
    return {
      rows,
      spark: change
        ? {
            points: sparklinePoints(history, 220, 44),
            from: String(change.fromYear),
            to: String(change.toYear),
            rising: change.change >= 0,
            text: t('{change} ({percent} %) since {year}', {
              change: formatNumber(change.change, {
                signDisplay: 'exceptZero',
              }),
              percent: formatNumber(change.percent, {
                signDisplay: 'exceptZero',
                maximumFractionDigits: 1,
              }),
              year: change.fromYear,
            }),
          }
        : null,
    };
  }

  function societyView() {
    const m = facts?.municipality;
    const rows = [];
    if (m?.taxRate)
      rows.push({
        label: t('Tax rate'),
        value: `${formatNumber(m.taxRate.value, { maximumFractionDigits: 2 })} %`,
        detail: String(m.taxRate.year),
      });
    if (m?.medianIncome)
      rows.push({
        label: t('Median income, ages 20–64'),
        value: `${SEK.format(m.medianIncome.value)} kr`,
        detail: String(m.medianIncome.year),
      });
    if (m?.unemployment)
      rows.push({
        label: t('Unemployed, ages 18–65'),
        value: `${oneDecimal(m.unemployment.value)} %`,
        detail: String(m.unemployment.year),
      });
    if (m?.turnout)
      rows.push({
        label: t('Turnout, municipal election'),
        value: `${oneDecimal(m.turnout.value)} %`,
        detail: m.turnout.year ? String(m.turnout.year) : '',
      });
    const parties = m?.election?.parties || [];
    const top = Math.max(1, ...parties.map((row) => row.share));
    return {
      rows,
      election: parties.length
        ? {
            // Valmyndigheten names its election; Kolada's figures are dated
            // by the year Kolada repeats them in.
            title: t('Municipal election {year}', {
              year: m.election.year ?? electionYear(m.election.dataYear),
            }),
            parties: parties.map((row) => ({
              party:
                row.party === 'other'
                  ? t('Other')
                  : row.party === 'local'
                    ? row.name
                    : row.party,
              share: `${oneDecimal(row.share)} %`,
              width: `${Math.max(2, (row.share / top) * 100)}%`,
              color: PARTY_COLORS[row.party] || PARTY_COLORS.other,
            })),
          }
        : null,
    };
  }

  function nowView() {
    if (!live)
      return { loading: true, status: t('Fetching the live picture…') };
    const brief = live.brief;
    const weather = brief?.weather;
    const alerts = Array.isArray(brief?.alerts) ? brief.alerts : [];
    const sun = sunTimes(city.point[1], city.point[0], now());
    const police = live.police;
    return {
      loading: false,
      weather: weather
        ? {
            value: Number.isFinite(weather.temperatureC)
              ? `${Math.round(weather.temperatureC)}°C`
              : '—',
            detail: [
              // The cockpit briefing's condition words, already translated.
              t(weatherCodeLabel(weather.weatherCode)),
              Number.isFinite(weather.windKph)
                ? t('wind {value} m/s', {
                    value: oneDecimal(weather.windKph / 3.6),
                  })
                : null,
            ]
              .filter(Boolean)
              .join(' · '),
            source: brief.weatherSource || 'SMHI',
          }
        : null,
      alerts: alerts.map((alert, index) => ({
        key: `${alert.level}:${index}`,
        level: alert.level,
        title: bilingual(alert.title),
        meta: [
          ALERT_LEVEL_KEYS[alert.level]
            ? t(ALERT_LEVEL_KEYS[alert.level])
            : null,
          bilingual(alert.area) || null,
        ]
          .filter(Boolean)
          .join(' · '),
      })),
      alertsNote:
        brief?.alertsStatus === 'ready' && !alerts.length
          ? t('No warnings in effect')
          : '',
      air: live.air
        ? {
            value: `EAQI ${live.air.label}`, // i18n-ignore: index name
            risk: live.air.risk ? t(live.air.risk) : '',
            color: live.air.color,
            station: t('Measured at {station}', { station: live.air.name }),
          }
        : null,
      police: police
        ? {
            summary: police.length
              ? tn(
                  police.length,
                  '{count} notice in the last 24 hours',
                  '{count} notices in the last 24 hours',
                )
              : t('No notices in the last 24 hours'),
            items: police.slice(0, 3).map((event) => ({
              key: event.id,
              title: event.type,
              time: clock(event.time),
              url: event.link,
            })),
          }
        : null,
      sun:
        sun.polar === 'day'
          ? t('Midnight sun')
          : sun.polar === 'night'
            ? t('Polar night')
            : t('Sunrise {rise} · sunset {set}', {
                rise: clock(sun.rise),
                set: clock(sun.set),
              }),
      radioLabel: radioBusy ? t('Tuning in…') : t('Play local radio'),
      radioBusy,
    };
  }

  function render() {
    if (destroyed) return;
    if (!city) {
      publish(null);
      return;
    }
    publish({
      code: city.code,
      name: city.name,
      subtitle: [
        t('{name} municipality', { name: city.municipality }),
        city.county,
      ]
        .filter(Boolean)
        .join(' · '),
      coatOfArms: facts?.town?.coatOfArms || null,
      status,
      error: status === 'error' ? t('Facts unavailable right now') : '',
      tab,
      tabs: TABS.map(([id, label]) => ({
        id,
        label: t(label),
        active: id === tab,
      })),
      about: facts ? aboutView() : null,
      people: facts ? peopleView() : null,
      society: facts ? societyView() : null,
      now: nowView(),
      source:
        'SCB · Kolada (RKA) · Valmyndigheten · Wikidata · Wikipedia · SMHI · Polisen', // i18n-ignore: provider names
    });
  }

  const disconnect = connect({
    setTab(id) {
      if (!TABS.some(([tabId]) => tabId === id)) return;
      tab = id;
      if (id === 'now' && now() - liveAt > LIVE_TTL_MS) void loadLive();
      render();
    },
    playRadio,
  });

  const removeLocaleListener = onLocaleChange(render);
  const removeMoveEnd = viewer.camera.moveEnd.addEventListener(() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void visit(), SETTLE_DELAY_MS);
  });
  // A view that is already over a town counts as a visit.
  timer = setTimeout(() => void visit(), SETTLE_DELAY_MS);

  return {
    /** The town presented now, or null. */
    get city() {
      return city;
    },
    visit,
    destroy() {
      destroyed = true;
      if (timer) clearTimeout(timer);
      request?.abort();
      liveRequest?.abort();
      removeMoveEnd();
      removeLocaleListener();
      disconnect();
      publish(null);
    },
  };
}

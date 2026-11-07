/**
 * Swedavia's ten airports, the busiest first, shared by the server's
 * flight reader and the airport board. `queues` marks the airports whose
 * security checkpoints Swedavia's WaitTime measures, and `groundM` is their
 * apron's approximate height above the WGS84 ellipsoid (elevation plus the
 * geoid's ~25 m over Sweden), where the queue markers stand.
 */
export const SWEDAVIA_AIRPORTS = Object.freeze(
  [
    {
      iata: 'ARN',
      icao: 'ESSA',
      name: 'Stockholm Arlanda',
      lat: 59.6519,
      lon: 17.9186,
      queues: true,
      groundM: 66,
    },
    {
      iata: 'GOT',
      icao: 'ESGG',
      name: 'Göteborg Landvetter',
      lat: 57.6628,
      lon: 12.2798,
      queues: true,
      groundM: 178,
    },
    {
      iata: 'BMA',
      icao: 'ESSB',
      name: 'Stockholm Bromma',
      lat: 59.3544,
      lon: 17.9417,
      queues: true,
      groundM: 38,
    },
    {
      iata: 'MMX',
      icao: 'ESMS',
      name: 'Malmö Airport',
      lat: 55.5363,
      lon: 13.3762,
      queues: false,
    },
    {
      iata: 'LLA',
      icao: 'ESPA',
      name: 'Luleå Airport',
      lat: 65.5438,
      lon: 22.122,
      queues: false,
    },
    {
      iata: 'UME',
      icao: 'ESNU',
      name: 'Umeå Airport',
      lat: 63.7918,
      lon: 20.2828,
      queues: false,
    },
    {
      iata: 'OSD',
      icao: 'ESNZ',
      name: 'Åre Östersund Airport',
      lat: 63.1944,
      lon: 14.5003,
      queues: false,
    },
    {
      iata: 'VBY',
      icao: 'ESSV',
      name: 'Visby Airport',
      lat: 57.6628,
      lon: 18.3462,
      queues: false,
    },
    {
      iata: 'KRN',
      icao: 'ESNQ',
      name: 'Kiruna Airport',
      lat: 67.822,
      lon: 20.3368,
      queues: false,
    },
    {
      iata: 'RNB',
      icao: 'ESDF',
      name: 'Ronneby Airport',
      lat: 56.2667,
      lon: 15.265,
      queues: false,
    },
  ].map((airport) => Object.freeze(airport)),
);

/** One of Swedavia's airports by IATA code, or null. */
export const swedaviaAirport = (iata) =>
  SWEDAVIA_AIRPORTS.find(
    (airport) => airport.iata === String(iata ?? '').toUpperCase(),
  ) ?? null;

/** One of Swedavia's airports by IATA or ICAO code ("ARN", "ESSA"), or null. */
export const swedaviaAirportByCode = (code) => {
  const value = String(code ?? '')
    .trim()
    .toUpperCase();
  return (
    SWEDAVIA_AIRPORTS.find(
      (airport) => airport.iata === value || airport.icao === value,
    ) ?? null
  );
};

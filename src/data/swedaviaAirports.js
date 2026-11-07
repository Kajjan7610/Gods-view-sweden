/**
 * Swedavia's ten airports, the busiest first, shared by the server's
 * flight reader and the airport board. `queues` marks the airports whose
 * security checkpoints Swedavia's WaitTime measures.
 */
export const SWEDAVIA_AIRPORTS = Object.freeze(
  [
    {
      iata: 'ARN',
      name: 'Stockholm Arlanda',
      lat: 59.6519,
      lon: 17.9186,
      queues: true,
    },
    {
      iata: 'GOT',
      name: 'Göteborg Landvetter',
      lat: 57.6628,
      lon: 12.2798,
      queues: true,
    },
    {
      iata: 'BMA',
      name: 'Stockholm Bromma',
      lat: 59.3544,
      lon: 17.9417,
      queues: true,
    },
    {
      iata: 'MMX',
      name: 'Malmö Airport',
      lat: 55.5363,
      lon: 13.3762,
      queues: false,
    },
    {
      iata: 'LLA',
      name: 'Luleå Airport',
      lat: 65.5438,
      lon: 22.122,
      queues: false,
    },
    {
      iata: 'UME',
      name: 'Umeå Airport',
      lat: 63.7918,
      lon: 20.2828,
      queues: false,
    },
    {
      iata: 'OSD',
      name: 'Åre Östersund Airport',
      lat: 63.1944,
      lon: 14.5003,
      queues: false,
    },
    {
      iata: 'VBY',
      name: 'Visby Airport',
      lat: 57.6628,
      lon: 18.3462,
      queues: false,
    },
    {
      iata: 'KRN',
      name: 'Kiruna Airport',
      lat: 67.822,
      lon: 20.3368,
      queues: false,
    },
    {
      iata: 'RNB',
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

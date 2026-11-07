/**
 * Which Krisinformation.se messages concern a town (Swedish fork): those for
 * the whole country, its county or its municipality.
 */

const fold = (value) =>
  String(value ?? '')
    .toLocaleLowerCase('sv-SE')
    .replace(/\s+(kommun|län|stad)$/u, '')
    .trim();

/**
 * Whether a message's areas cover a town in `municipality` (e.g.
 * "Västerås") and `county` (e.g. "Västmanlands län").
 */
export function concernsTown(message, { municipality, county } = {}) {
  const town = fold(municipality);
  const region = fold(county);
  return (message.areas ?? []).some((area) => {
    if (area.type === 'Country') return true;
    const name = fold(area.name);
    if (!name) return false;
    return (town && name === town) || (region && name === region);
  });
}

/**
 * The town's share: active alerts (VMA) first, then the newest news, at
 * most `max`; each says whether it is for the whole country.
 */
export function messagesFor(body, town, max = 3) {
  const pick = (list) =>
    (list ?? [])
      .filter((message) => concernsTown(message, town))
      .map((message) => ({
        ...message,
        national: (message.areas ?? []).some((area) => area.type === 'Country'),
      }));
  return {
    vmas: pick(body?.vmas),
    news: pick(body?.news).slice(0, max),
  };
}

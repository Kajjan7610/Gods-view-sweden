// Author and licence of the Wikimedia images the city dossier shows.
//
// Most of them are CC BY or CC BY-SA, which ask for the author and the
// licence to be named with the picture, not just the site. Commons (or, for a
// file Wikipedia hosts itself, sv.wikipedia.org) states both in each file's
// metadata; one API request answers up to 50 files. An image with no licence
// to name is not shown at all.

const BATCH = 50;
const CREDIT_TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_AUTHOR_CHARS = 80;
const COMMONS = 'commons.wikimedia.org';

/**
 * The wiki and file title behind an image address: a Commons
 * Special:FilePath link, or an upload.wikimedia.org original or thumbnail.
 * @param {string} address
 * @returns {{host: string, title: string}|null}
 */
export function wikiFileOf(address) {
  let url;
  try {
    url = new URL(String(address ?? ''));
  } catch {
    return null;
  }
  const title = (name) =>
    name ? `File:${decodeURIComponent(name).replace(/_/g, ' ')}` : null;
  if (url.hostname === COMMONS) {
    const name = /\/wiki\/Special:FilePath\/([^?#]+)/.exec(url.pathname)?.[1];
    return name ? { host: COMMONS, title: title(name) } : null;
  }
  if (!['upload.wikimedia.org', 'thumb.wikimedia.org'].includes(url.hostname))
    return null;
  const [, project, ...rest] = url.pathname.split('/').filter(Boolean);
  // /wikipedia/commons/… is Commons; /wikipedia/sv/… is the Swedish
  // Wikipedia's own file.
  const host =
    project === 'commons'
      ? COMMONS
      : /^[a-z-]{2,12}$/.test(project ?? '')
        ? `${project}.wikipedia.org`
        : null;
  // A thumbnail's own name follows the file's: ".../Name.jpg/320px-Name.jpg".
  const name = rest
    .filter(
      (part) =>
        part &&
        part !== 'thumb' &&
        !/^[0-9a-f]{1,2}$/.test(part) &&
        !/^(?:lossy-|lossless-)?(?:page\d+-)?\d+px-/.test(part),
    )
    .at(-1);
  return host && name ? { host, title: title(name) } : null;
}

/** Plain text of the HTML Commons gives as the author. */
export function plainAuthor(html) {
  const text = String(html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > MAX_AUTHOR_CHARS
    ? `${text.slice(0, MAX_AUTHOR_CHARS - 1)}…`
    : text;
}

/**
 * The credit for each file the answer describes, keyed by the title asked
 * for (the API may answer under a normalized title).
 * @param {object} payload An action=query answer with imageinfo/extmetadata.
 * @param {string} host
 * @returns {Map<string, {author: string, licence: string, page: string}|null>}
 */
export function normalizeImageCredits(payload, host) {
  const asked = new Map();
  for (const { from, to } of payload?.query?.normalized ?? [])
    asked.set(to, from);
  const credits = new Map();
  for (const page of payload?.query?.pages ?? []) {
    const title = String(page?.title ?? '');
    if (!title) continue;
    const meta = page.imageinfo?.[0]?.extmetadata ?? {};
    const licence = plainAuthor(meta.LicenseShortName?.value);
    const author = plainAuthor(meta.Artist?.value);
    const credit = licence
      ? {
          author,
          licence,
          page: `https://${host}/wiki/File:${encodeURIComponent(title.replace(/^File:/, '').replace(/ /g, '_'))}`,
        }
      : null;
    credits.set(title, credit);
    if (asked.has(title)) credits.set(asked.get(title), credit);
  }
  return credits;
}

/**
 * Cached credits for image addresses.
 * @param {{getJson: (url: string) => Promise<object>, now?: () => number}} deps
 */
export function createImageCredits({ getJson, now = () => Date.now() }) {
  /** `${host}|${title}` → {credit, savedAt} */
  const cache = new Map();

  /**
   * @param {string[]} addresses
   * @returns {Promise<{credits: Map<string, object|null>, failed: boolean}>}
   *   address → credit, or null when the file has no licence to name or
   *   Wikimedia did not answer; `failed` when a request went unanswered.
   */
  async function lookup(addresses) {
    const files = new Map();
    for (const address of new Set(addresses.filter(Boolean))) {
      const file = wikiFileOf(address);
      if (file) files.set(address, file);
    }
    let failed = false;
    const missing = new Map();
    for (const file of files.values()) {
      const key = `${file.host}|${file.title}`;
      const hit = cache.get(key);
      if (hit && now() - hit.savedAt < CREDIT_TTL_MS) continue;
      if (!missing.has(file.host)) missing.set(file.host, new Set());
      missing.get(file.host).add(file.title);
    }
    for (const [host, titles] of missing) {
      const list = [...titles];
      for (let i = 0; i < list.length; i += BATCH) {
        const batch = list.slice(i, i + BATCH);
        const params = new URLSearchParams({
          action: 'query',
          format: 'json',
          formatversion: '2',
          prop: 'imageinfo',
          iiprop: 'extmetadata',
          iiextmetadatafilter: 'Artist|LicenseShortName',
          titles: batch.join('|'),
        });
        try {
          const credits = normalizeImageCredits(
            await getJson(`https://${host}/w/api.php?${params}`),
            host,
          );
          for (const title of batch)
            cache.set(`${host}|${title}`, {
              credit: credits.get(title) ?? null,
              savedAt: now(),
            });
        } catch {
          // Not cached: asked again next time. Until then no credit, so
          // the image is not shown.
          failed = true;
        }
      }
    }
    const credits = new Map();
    for (const address of addresses) {
      const file = files.get(address);
      credits.set(
        address,
        file ? (cache.get(`${file.host}|${file.title}`)?.credit ?? null) : null,
      );
    }
    return { credits, failed };
  }

  return { lookup };
}

import { fetchRegionalText, fetchRegionalJson } from './http.js';
import { normalizeRegionalArticles } from '../../../src/data/regionalModel.js';

function decodeRssText(value) {
  return String(value || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function rssTag(block, tag) {
  return decodeRssText(
    new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i').exec(
      block,
    )?.[1] || '',
  );
}

function normalizeRssArticles(xml, limit = 5) {
  const seen = new Set();
  const articles = [];
  for (const match of String(xml || '').matchAll(
    /<item>([\s\S]*?)<\/item>/gi,
  )) {
    const item = match[1];
    const title = rssTag(item, 'title').slice(0, 180);
    const url = rssTag(item, 'link');
    let parsedUrl;
    try {
      parsedUrl = new URL(url);
    } catch {
      continue;
    }
    if (!title || !['http:', 'https:'].includes(parsedUrl.protocol)) continue;
    const source = rssTag(item, 'source');
    const signature = `${title.toLowerCase()}|${source.toLowerCase() || parsedUrl.hostname}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    const rawDate = rssTag(item, 'pubDate');
    articles.push({
      title,
      url: parsedUrl.href,
      domain: source || parsedUrl.hostname.replace(/^www\./, ''),
      publishedAt: Number.isNaN(Date.parse(rawDate))
        ? null
        : new Date(rawDate).toISOString(),
      sourceCountry: null,
    });
    if (articles.length >= limit) break;
  }
  return articles;
}

// Swedish fork: Google News' terms allow its headlines only for personal,
// non-commercial use and not for public display, so it is off; outside
// Sweden the cockpit reads GDELT (free with the GDELT Project credited).
// REGIONAL_NEWS_GOOGLE=on brings Google News back for one's own use.
const useGoogleNews = () => process.env.REGIONAL_NEWS_GOOGLE === 'on';

// Over Sweden the local press writes in Swedish, so the search does too and
// keeps to the last week, newest first.
const SWEDISH_NEWS = Object.freeze({
  hl: 'sv',
  gl: 'SE',
  ceid: 'SE:sv',
  window: ' when:7d',
  source: 'Google News (sv)',
});

async function fetchRegionalNews(place) {
  const query = place?.locality || place?.region || place?.country;
  if (!query)
    return { status: 'unavailable', query: null, articles: [], source: null };
  const swedish = place?.countryCode === 'SE' ? SWEDISH_NEWS : null;
  if (useGoogleNews()) {
    const found = await fetchGoogleNews(query, swedish);
    if (found) return found;
  }
  // Over Sweden GDELT almost always answered 429 when tried (2026-11-13), so
  // Swedish places ask no one: the panels' news there is Krisinformation's.
  if (swedish)
    return { status: 'unavailable', query, articles: [], source: null };
  return fetchGdeltNews(query, swedish);
}

async function fetchGoogleNews(query, swedish) {
  const rssParams = new URLSearchParams({
    q: String(query).replace(/["\\]/g, ' ').trim() + (swedish?.window ?? ''),
    hl: swedish?.hl ?? 'en-US',
    gl: swedish?.gl ?? 'US',
    ceid: swedish?.ceid ?? 'US:en',
  });
  try {
    const xml = await fetchRegionalText(
      `https://news.google.com/rss/search?${rssParams}`,
      {
        headers: { 'User-Agent': 'GodsEyeView/0.1' },
        timeoutMs: 12_000,
      },
    );
    const articles = swedish
      ? normalizeRssArticles(xml, 20)
          .sort((a, b) =>
            String(b.publishedAt ?? '').localeCompare(
              String(a.publishedAt ?? ''),
            ),
          )
          .slice(0, 5)
      : normalizeRssArticles(xml, 5);
    if (articles.length)
      return {
        status: 'ready',
        query,
        articles,
        source: swedish?.source ?? 'Google News RSS',
      };
  } catch {
    /* fall through to GDELT */
  }
  return null;
}

// GDELT answers 429 to more than one request every five seconds per address:
// requests wait their turn, and a 429 leaves GDELT alone for a minute.
const GDELT_SPACING_MS = 5_500;
const GDELT_BACKOFF_MS = 60_000;
let gdeltQueue = Promise.resolve();
let gdeltNextAt = 0;
let gdeltBackoffUntil = 0;

function gdeltTurn() {
  const turn = gdeltQueue.then(async () => {
    const wait = gdeltNextAt - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    gdeltNextAt = Date.now() + GDELT_SPACING_MS;
  });
  gdeltQueue = turn.catch(() => {});
  return turn;
}

async function fetchGdeltNews(query, swedish) {
  const phrase = `"${String(query).replace(/["\\]/g, ' ').trim()}"`;
  const params = new URLSearchParams({
    query: swedish ? `${phrase} sourcelang:swedish` : phrase,
    mode: 'artlist',
    format: 'json',
    maxrecords: '5',
    sort: 'datedesc',
    timespan: swedish ? '7d' : '48h',
  });
  if (Date.now() < gdeltBackoffUntil)
    return { status: 'unavailable', query, articles: [], source: null };
  try {
    await gdeltTurn();
    const payload = await fetchRegionalJson(
      `https://api.gdeltproject.org/api/v2/doc/doc?${params}`,
      {
        headers: { 'User-Agent': 'GodsEyeView/0.1' },
        timeoutMs: 12_000,
      },
    );
    const articles = normalizeRegionalArticles(payload, 5);
    return {
      status: articles.length ? 'ready' : 'empty',
      query,
      articles,
      source: 'GDELT Project',
    };
  } catch (error) {
    if (/\b429\b/.test(String(error?.message)))
      gdeltBackoffUntil = Date.now() + GDELT_BACKOFF_MS;
    return { status: 'unavailable', query, articles: [], source: null };
  }
}

export { fetchRegionalNews };

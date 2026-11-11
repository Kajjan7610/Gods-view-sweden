/**
 * The public alert banner (Swedish fork): while Krisinformation.se carries an
 * active VMA (Viktigt meddelande till allmänheten) anywhere in Sweden, a red
 * banner across the top of the app names it, its area and a link. Read every
 * two minutes, and at once when the page is looked at again; a closed alert
 * stays closed for this page's life. An alert that can no longer be
 * confirmed stays, and says when it last was.
 */
import { getLocale, t } from '../i18n/index.js';

const POLL_MS = 2 * 60_000;
/** A banner not confirmed for this long says when it last was. */
const UNCONFIRMED_MS = 5 * 60_000;

const clock = (ms) =>
  new Intl.DateTimeFormat(getLocale(), {
    timeZone: 'Europe/Stockholm',
    hour: '2-digit',
    minute: '2-digit',
  }).format(ms);

/**
 * The banner's rows from /api/krisinformation, closed ones left out.
 * @param {object} body The route's answer.
 * @param {Set<string>} [closed] The alerts closed on this page.
 * @param {string} [note] Said under each row, as when it was last confirmed.
 */
export function bannerRows(body, closed = new Set(), note = '') {
  return (body?.vmas ?? [])
    .filter((message) => !closed.has(message.id))
    .map((message) => ({
      key: message.id,
      headline: message.headline,
      area: (message.areas ?? [])
        .map((area) =>
          area.type === 'Country' ? t('All of Sweden') : area.name,
        )
        .filter(Boolean)
        .slice(0, 3)
        .join(', '),
      url: message.web,
      note,
    }));
}

/** Own the banner; `publish` receives its rows (an empty list: none). */
export function createVmaBanner({
  publish,
  connect,
  fetchImpl = (...args) => globalThis.fetch(...args),
  documentRef = globalThis.document,
  now = () => Date.now(),
}) {
  let destroyed = false;
  let body = null;
  /** When the alerts were last confirmed by a fresh answer. */
  let confirmedAt = null;
  let timer = null;
  const closed = new Set();

  /** "Updated 15:00" once the alerts shown are no longer fresh, else ''. */
  const note = () =>
    confirmedAt !== null &&
    (body?.stale === true || now() - confirmedAt > UNCONFIRMED_MS)
      ? t('Updated {time}', { time: clock(confirmedAt) })
      : '';

  const render = () => {
    if (!destroyed) publish(bannerRows(body, closed, note()));
  };

  async function read() {
    if (documentRef?.visibilityState === 'hidden') return;
    try {
      const response = await fetchImpl('/api/krisinformation');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      body = await response.json();
      // The proxy's last known answer confirms nothing new.
      if (body?.stale !== true || confirmedAt === null) confirmedAt = now();
    } catch (error) {
      console.warn('[VmaBanner] read failed:', error?.message || error);
    }
    // Also after a failure: the alert stays, and its age begins to show.
    render();
  }

  // Looked at again after being hidden: read now, not at the next turn.
  const onVisible = () => {
    if (documentRef?.visibilityState !== 'hidden') void read();
  };
  documentRef?.addEventListener?.('visibilitychange', onVisible);

  void read();
  timer = setInterval(() => void read(), POLL_MS);
  const disconnect = connect({
    close(id) {
      closed.add(id);
      render();
    },
  });

  return {
    destroy() {
      destroyed = true;
      clearInterval(timer);
      documentRef?.removeEventListener?.('visibilitychange', onVisible);
      disconnect?.();
      publish([]);
    },
  };
}

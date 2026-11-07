/**
 * The public alert banner (Swedish fork): while Krisinformation.se carries an
 * active VMA (Viktigt meddelande till allmänheten) anywhere in Sweden, a red
 * banner across the top of the app names it, its area and a link. Read every
 * two minutes; a closed alert stays closed for this page's life.
 */
import { t } from '../i18n/index.js';

const POLL_MS = 2 * 60_000;

/** The banner's rows from /api/krisinformation, closed ones left out. */
export function bannerRows(body, closed = new Set()) {
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
    }));
}

/** Own the banner; `publish` receives its rows (an empty list: none). */
export function createVmaBanner({
  publish,
  connect,
  fetchImpl = (...args) => globalThis.fetch(...args),
  documentRef = globalThis.document,
}) {
  let destroyed = false;
  let body = null;
  let timer = null;
  const closed = new Set();

  const render = () => {
    if (!destroyed) publish(bannerRows(body, closed));
  };

  async function read() {
    if (documentRef?.visibilityState === 'hidden') return;
    try {
      const response = await fetchImpl('/api/krisinformation');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      body = await response.json();
      render();
    } catch (error) {
      console.warn('[VmaBanner] read failed:', error?.message || error);
    }
  }

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
      disconnect?.();
      publish([]);
    },
  };
}

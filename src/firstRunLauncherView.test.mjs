// src/firstRunLauncherView.test.mjs — the welcome view renders the mission
// launcher initFirstRunExperience presents, and its buttons and checkbox call
// the launcher's controls.
import './testSupport/registerDom.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp, nextTick } from 'vue';
import { createPinia } from 'pinia';
import {
  FIRST_RUN_SESSION_KEY,
  FIRST_RUN_STORAGE_KEY,
  initFirstRunExperience,
} from './firstRunExperience.js';
// Swedish fork: the welcome's links, and Swedish as well as English.
import { FIRST_RUN_LINKS } from './firstRunCopy.js';
import { setLocale } from './i18n/index.js';
import { useFirstRunStore } from './ui/stores/firstRun.js';
import { useStoriesStore } from './ui/stores/stories.js';
import WelcomeView from './ui/views/WelcomeView.vue';

function memoryStorage(key, { refuse = false } = {}) {
  const values = new Map();
  return {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, next) => {
      if (refuse) throw new Error('blocked');
      values.set(name, next);
    },
    removeItem: (name) => {
      if (refuse) throw new Error('blocked');
      values.delete(name);
    },
    read: () => values.get(key) ?? null,
  };
}

/** The welcome view and an initialized launcher, revealed and painted. */
async function launch(
  t,
  {
    styleManager = {},
    dataManager = { setEnabled: async () => true },
    refuse = false,
  } = {},
) {
  document.body.replaceChildren();
  // Where focus was before the launcher opened.
  const opener = document.body.appendChild(document.createElement('button'));
  opener.focus();
  const frames = [];
  const previousFrame = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = (callback) => frames.push(callback);
  const pinia = createPinia();
  const store = useFirstRunStore(pinia);
  const app = createApp(WelcomeView).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  const storage = memoryStorage(FIRST_RUN_STORAGE_KEY, { refuse });
  const sessionStorageRef = memoryStorage(FIRST_RUN_SESSION_KEY);
  const launcher = initFirstRunExperience({
    styleManager,
    dataManager,
    documentRef: document,
    storage,
    sessionStorageRef,
    location: { search: '' },
    store,
  });
  t.after(() => {
    launcher?.destroy();
    app.unmount();
    globalThis.requestAnimationFrame = previousFrame;
  });
  await nextTick();
  const root = document.getElementById('first-run-launcher');
  // The list overflows its box until a test resizes it.
  const list = root.querySelector('.first-run-choices');
  const box = { scrollHeight: 400, clientHeight: 200 };
  Object.defineProperty(list, 'scrollHeight', { get: () => box.scrollHeight });
  Object.defineProperty(list, 'clientHeight', { get: () => box.clientHeight });
  for (const frame of frames.splice(0)) frame();
  await nextTick();
  return {
    launcher,
    pinia,
    root,
    list,
    box,
    opener,
    storage,
    sessionStorageRef,
    frames,
  };
}

async function move(root, frames, selector = '[data-first-run-next]') {
  root.querySelector(selector).click();
  await settle(frames);
}

async function settle(frames) {
  for (let i = 0; i < 4; i++) {
    await nextTick();
    for (const frame of frames.splice(0)) frame();
    await new Promise((resolve) => setTimeout(resolve));
  }
  await nextTick();
}

test('the card is hidden until initialized, then revealed with its copy', async (t) => {
  document.body.replaceChildren();
  const pinia = createPinia();
  const app = createApp(WelcomeView).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  const hidden = document.getElementById('first-run-launcher');
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.className, '');
  app.unmount();

  const { root, list, frames } = await launch(t);
  assert.equal(root.hidden, false);
  assert.equal(root.classList.contains('visible'), true);
  assert.equal(root.hasAttribute('aria-hidden'), false);
  assert.equal(list.dataset.scrollable, 'true');
  assert.equal(root.querySelector('[data-first-run-status]').textContent, '');
  assert.equal(root.querySelector('[data-first-run-choice]'), null);
  assert.ok(
    document.activeElement === root.querySelector('[data-first-run-primary]'),
  );
  // Swedish fork: the starts are on the first step, the Swedish two first.
  assert.deepEqual(
    [...root.querySelectorAll('[data-first-run-start]')].map(
      (node) => node.dataset.firstRunStart,
    ),
    ['sweden-now', 'nature-weather', 'explore'],
  );
  const swedenNow = root.querySelector('[data-first-run-start="sweden-now"]');
  assert.equal(
    swedenNow.querySelector('strong').textContent,
    'SWEDEN RIGHT NOW',
  );
  // Trafikverket's roads need its key, and the tile says so.
  assert.match(
    swedenNow.querySelector('small').textContent,
    /road conditions from Trafikverket \(key required\)$/,
  );
  assert.equal(
    root
      .querySelector('[data-first-run-start="explore"]')
      .getAttribute('aria-pressed'),
    'true',
  );
  await move(root, frames);
  assert.ok(
    document.activeElement === root.querySelector('[data-first-run-primary]'),
  );
});

test('a quick second click on NEXT moves on, and never launches', async (t) => {
  let calls = 0;
  const { root, frames } = await launch(t, {
    dataManager: {
      setEnabled: async () => {
        calls++;
        return true;
      },
    },
  });
  const primary = root.querySelector('[data-first-run-primary]');
  const press = (detail) => {
    primary.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    primary.dispatchEvent(new MouseEvent('click', { bubbles: true, detail }));
  };
  // Swedish fork: two steps, so the starts are on the first and the second
  // click of a double click on its NEXT, after the step settled, moves on.
  assert.ok(root.querySelector('[data-first-run-start]'), 'on the first step');
  press(2);
  await settle(frames);
  assert.equal(primary.dataset.firstRunChoice, 'explore', 'on the last step');
  press(2);
  await settle(frames);
  assert.equal(calls, 0);
  assert.equal(root.dataset.state ?? null, null, 'a double click never starts');
  press(1);
  await settle(frames);
  assert.ok(root.dataset.state, 'a single click starts');
});

test('a busy mission marks the choices aria-disabled, never disabled', async (t) => {
  // Swedish fork: the start switches on three layers, so every request is
  // held and all of them are answered together.
  const pending = [];
  const finish = (value) => {
    for (const resolve of pending.splice(0)) resolve(value);
  };
  let calls = 0;
  const { root, frames } = await launch(t, {
    dataManager: {
      setEnabled: () => {
        calls++;
        return new Promise((resolve) => pending.push(resolve));
      },
    },
  });
  // Swedish fork: the starts are on the first step.
  root.querySelector('[data-first-run-start="sweden-now"]').click();
  await nextTick();
  const primary = root.querySelector('[data-first-run-next]');
  primary.click();
  await nextTick();
  const enter = root.querySelector('[data-first-run-primary]');
  assert.equal(
    enter,
    primary,
    'one persistent button keeps native click counting and focus',
  );
  assert.equal(enter.dataset.firstRunChoice, 'sweden-now');
  enter.click();
  assert.equal(
    calls,
    0,
    'the new action cannot launch during the step transition',
  );
  // A press begun during the transition and released after it runs nothing.
  enter.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  await settle(frames);
  enter.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
  assert.equal(calls, 0, 'a press held through the step change never launches');
  assert.ok(
    document.activeElement === enter,
    'the primary action retains focus',
  );
  assert.deepEqual(enter.getAttribute('aria-describedby').split(' '), [
    'first-run-title',
    'first-run-description',
  ]);
  const announcement = root.querySelector('.first-run-step-announcement');
  assert.equal(announcement.getAttribute('aria-live'), 'polite');
  assert.equal(announcement.getAttribute('aria-atomic'), 'true');
  assert.equal(
    announcement.textContent,
    root.querySelector('#first-run-title').textContent,
  );
  for (const id of enter.getAttribute('aria-describedby').split(' ')) {
    assert.ok(root.querySelector(`#${id}`).textContent.trim());
  }
  enter.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
  assert.equal(calls, 0, 'a second click from Next never confirms a mission');
  const repeated = new KeyboardEvent('keydown', {
    key: 'Enter',
    repeat: true,
    bubbles: true,
    cancelable: true,
  });
  enter.dispatchEvent(repeated);
  assert.equal(repeated.defaultPrevented, true);
  // A fresh keyboard/assistive click has detail 0 and remains supported.
  enter.click();
  assert.equal(calls, 3, 'one start asks for its three layers');
  await nextTick();
  assert.equal(root.dataset.state, 'loading');
  assert.equal(root.getAttribute('aria-busy'), 'true');
  assert.equal(enter.getAttribute('aria-disabled'), 'true');
  assert.equal(enter.disabled, false);
  assert.ok(document.activeElement === enter, 'focus stays on the action');
  assert.equal(
    root.querySelector('[data-first-run-status]').textContent,
    'Turning on warnings, weather and road conditions…',
  );
  root.querySelector('.first-run-back').click();
  await nextTick();
  assert.equal(
    root.querySelector('[data-first-run-next]'),
    null,
    'Back is inert while busy',
  );
  enter.click();
  assert.equal(calls, 3, 'a busy action cannot start a second request');
  // A failed mission says so and stays on the card.
  finish(false);
  await new Promise((resolve) => setTimeout(resolve));
  await nextTick();
  assert.equal(root.dataset.state, 'ready');
  assert.equal(enter.getAttribute('aria-disabled'), 'false');
  // Swedish fork: worded for starts that turn layers on.
  assert.match(
    root.querySelector('[data-first-run-status]').textContent,
    /^Could not turn on all the layers/,
  );
  // Swedish fork: one step back is the first, which has the starts and no
  // Back.
  root.querySelector('.first-run-back').focus();
  await move(root, frames, '.first-run-back');
  assert.equal(
    root
      .querySelector('[data-first-run-start="sweden-now"]')
      .getAttribute('aria-pressed'),
    'true',
  );
  assert.equal(root.querySelector('.first-run-back'), null);
  assert.ok(
    document.activeElement === root.querySelector('[data-first-run-primary]'),
    'focus moves when Back is removed',
  );
});

test('a refused write takes the tick back and says why', async (t) => {
  const { root, storage } = await launch(t, { refuse: true });
  const box = root.querySelector('[data-first-run-suppress]');
  box.click();
  await nextTick();
  assert.equal(box.checked, false, 'the tick is taken back');
  assert.equal(storage.read(), null);
  assert.equal(
    root.querySelector('[data-first-run-status]').textContent,
    'This browser is blocking storage, so that could not be saved.',
  );
});

test('a saved tick stays ticked', async (t) => {
  const { root, storage } = await launch(t);
  const box = root.querySelector('[data-first-run-suppress]');
  box.click();
  await nextTick();
  assert.equal(box.checked, true);
  assert.equal(storage.read(), 'suppressed');
});

test('the SKIP button closes the card the way ESC does', async (t) => {
  const { root, sessionStorageRef } = await launch(t);
  root.querySelector('[data-first-run-dismiss]').click();
  await nextTick();
  assert.equal(root.classList.contains('visible'), false);
  assert.equal(root.getAttribute('aria-hidden'), 'true');
  assert.notEqual(sessionStorageRef.read(), null, 'dismissed for the session');
  root
    .querySelector('.first-run-step')
    .dispatchEvent(new Event('transitionend', { bubbles: true }));
  await nextTick();
  assert.equal(
    document.getElementById('first-run-launcher'),
    root,
    'child transitions do not finish dismissal',
  );
  root.dispatchEvent(new Event('transitionend'));
  await nextTick();
  assert.equal(document.getElementById('first-run-launcher') === null, true);
});

test('BROWSE STORIES closes the card and opens Stories in place', async (t) => {
  const { root, pinia, frames, sessionStorageRef } = await launch(t);
  const stories = useStoriesStore(pinia);
  let opened = 0;
  let finishLoading;
  stories.connect({
    open: () => {
      opened++;
      return new Promise((resolve) => (finishLoading = resolve));
    },
  });
  // Swedish fork: two steps, so one move reaches the last.
  await move(root, frames);
  const button = root.querySelector('[data-first-run-stories]');
  assert.ok(button, 'the Stories card offers its button on the last step');
  assert.equal(button.tagName, 'BUTTON', 'opens in the app, not a new tab');
  assert.equal(button.hasAttribute('href'), false);
  button.click();
  await nextTick();
  assert.equal(opened, 1, 'Stories opened once');
  assert.equal(root.classList.contains('visible'), false, 'the card closed');
  assert.notEqual(sessionStorageRef.read(), null, 'dismissed for the session');
  assert.equal(
    document.body.classList.contains('first-run-opening-stories'),
    true,
    'the Stories announcement stays hidden while Stories loads',
  );
  finishLoading();
  await new Promise((resolve) => setTimeout(resolve));
  assert.equal(
    document.body.classList.contains('first-run-opening-stories'),
    false,
    'and may show again once Stories has opened (or failed to)',
  );
  button.dispatchEvent(new MouseEvent('click', { detail: 1 }));
  await nextTick();
  assert.equal(opened, 1, 'a closing card cannot open Stories again');
});

test('BROWSE STORIES keeps the welcome up when Stories refuses to open', async (t) => {
  const { root, pinia, frames, sessionStorageRef } = await launch(t);
  const stories = useStoriesStore(pinia);
  stories.connect({ open: () => false });
  // Swedish fork: two steps, so one move reaches the last.
  await move(root, frames);
  root.querySelector('[data-first-run-stories]').click();
  await nextTick();
  assert.equal(root.classList.contains('visible'), true, 'the card stays');
  assert.equal(sessionStorageRef.read(), null, 'not dismissed');
  assert.equal(
    document.body.classList.contains('first-run-opening-stories'),
    false,
  );
});

test('the Stories card is left out where Stories is not offered', async (t) => {
  const { root, pinia, frames } = await launch(t);
  const stories = useStoriesStore(pinia);
  stories.available = false;
  // Swedish fork: two steps, so one move reaches the last.
  await move(root, frames);
  assert.equal(root.querySelector('.first-run-stories'), null);
  assert.equal(root.querySelector('[data-first-run-stories]'), null);
});

test('the scroll fade clears when the tiles fit after a resize', async (t) => {
  const { root, list, box, frames } = await launch(t);
  assert.equal(list.dataset.scrollable, 'true');
  box.scrollHeight = 200;
  window.dispatchEvent(new Event('resize'));
  await nextTick();
  assert.equal(list.dataset.scrollable, 'false');
  box.scrollHeight = 400;
  await move(root, frames);
  assert.equal(
    list.dataset.scrollable,
    'true',
    'new step refreshes overflow without a resize',
  );
});

test('ESC closes the card, returns focus, and removes it without a transition', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { root, opener, sessionStorageRef } = await launch(t);
  assert.ok(document.activeElement !== opener, 'the launcher took focus');
  document.activeElement.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
  );
  await nextTick();
  assert.equal(root.getAttribute('aria-hidden'), 'true');
  assert.notEqual(sessionStorageRef.read(), null);
  assert.ok(document.activeElement === opener, 'focus returns where it was');
  // Reduced motion: no transitionend, so the bounded fallback removes it.
  t.mock.timers.tick(400);
  await nextTick();
  assert.equal(document.getElementById('first-run-launcher') === null, true);
});

// ── Swedish fork: what the welcome says ─────────────────────────────────────

test('Swedish fork: the welcome opens with the owner’s line and credits the original', async (t) => {
  setLocale('sv');
  t.after(() => setLocale('en'));
  const { root, frames } = await launch(t);
  assert.equal(
    root.querySelector('.first-run-kicker').textContent,
    'VÄLKOMMEN · SNABBSTART',
  );
  // The line from the owner's films; the product name is never translated.
  const title = root.querySelector('#first-run-title');
  assert.equal(
    title.textContent,
    "God's Eye View Sverige – en vidareutvecklad svensk version av Kaj Obst",
  );
  assert.equal(
    title.querySelector('[translate="no"]').textContent,
    "God's Eye View Sverige",
  );
  assert.equal(
    root.querySelector('.first-run-step-announcement').textContent,
    title.textContent,
  );
  assert.equal(
    root.querySelector('#first-run-description').textContent,
    'Öppna data om Sverige, mycket av det i realtid: trafik, väder, natur, samhälle och infrastruktur från myndigheter och öppna källor. Allt här är offentligt, och varje lager visar sin källa.',
  );
  assert.deepEqual(
    [...root.querySelectorAll('[data-first-run-start] strong')].map(
      (node) => node.textContent,
    ),
    ['SVERIGE JUST NU', 'NATUR OCH VÄDER', 'UTFORSKA SJÄLV'],
  );
  assert.match(
    root.querySelector('[data-first-run-start="sweden-now"] small').textContent,
    /väglag från Trafikverket \(nyckel krävs\)$/,
  );
  await move(root, frames);
  assert.match(
    root.querySelector('[data-first-run-primary]').textContent,
    /^\s*KOM IGÅNG\s/,
  );
  // One credit line, naming both of the original's maintainers, in place of
  // Halfpixel's social links, and the fork's own repository.
  const links = [...root.querySelectorAll('a')];
  assert.deepEqual(
    links.map((link) => [
      link.getAttribute('href'),
      link.querySelector('strong').textContent,
    ]),
    [
      [
        FIRST_RUN_LINKS.source,
        "Bygger på God's Eye View av Bilawal Sidhu och Sameh Khamis (MIT-licens)",
      ],
      [FIRST_RUN_LINKS.fork, 'Den svenska versionen på GitHub'],
    ],
  );
  // The original's name is never translated, and the credit link's name says
  // where it goes: its text without the hidden badge, as a reader hears it.
  const [credit] = links;
  assert.equal(
    credit.querySelector('strong [translate="no"]').textContent,
    "God's Eye View",
  );
  const heard = credit.cloneNode(true);
  for (const hidden of heard.querySelectorAll('[aria-hidden="true"]'))
    hidden.remove();
  assert.equal(
    heard.textContent.replace(/\s+/g, ' ').trim(),
    "Bygger på God's Eye View av Bilawal Sidhu och Sameh Khamis (MIT-licens) Originalets källkod på GitHub",
  );
});

/** The attributes whose text a reader sees or hears. */
const TEXT_ATTRIBUTES = Object.freeze([
  'aria-label',
  'aria-description',
  'aria-roledescription',
  'aria-valuetext',
  'aria-placeholder',
  'aria-braillelabel',
  'aria-brailleroledescription',
  'title',
  'alt',
  'placeholder',
  'data-callout',
]);

/**
 * Every word the card shows or speaks: its text, and the text-bearing
 * attributes of the card itself and of everything in it.
 */
function shownText(root) {
  const parts = [root.textContent];
  for (const node of [root, ...root.querySelectorAll('*')]) {
    for (const name of TEXT_ATTRIBUTES) {
      if (node.hasAttribute(name)) parts.push(node.getAttribute(name));
    }
  }
  return parts.join('\n');
}

// The fork's design rule (only true things; no spy, classified or military
// styling), as stems that must never come back into the welcome, however
// they are spelt or joined: "god mode", "god-mode" and "godmode" alike.
const FORBIDDEN = Object.freeze([
  /spion/,
  /spy/,
  /guds?[\s­​_-]*läge/,
  /god[\s­​_-]*mode/,
  /taktisk/,
  /tactic/,
  /förbjud/,
  /forbid/,
  /uppdragsledning/,
  /mission[\s­​_-]*control/,
  /nyckel[\s­​_-]*hål/,
  /key[\s­​_-]*hole/,
  /milit[aä]r/,
]);

test('Swedish fork: no spy, god-mode or military words in the welcome, in Swedish or English', async (t) => {
  t.after(() => setLocale('en'));
  // Read on the way: text, an attribute-only label, a start's progress line
  // and the line a refused layer leaves.
  const READ = {
    sv: ['kom igång', 'steg 1 av 2', 'slår på', 'det gick inte att slå på'],
    en: ['get started', 'step 1 of 2', 'turning on', 'could not turn on'],
  };
  for (const locale of ['sv', 'en']) {
    setLocale(locale);
    const pending = [];
    const { root, frames } = await launch(t, {
      dataManager: {
        setEnabled: () => new Promise((resolve) => pending.push(resolve)),
      },
    });
    const shown = [shownText(root)];
    const starts = [...root.querySelectorAll('[data-first-run-start]')].map(
      (node) => node.dataset.firstRunStart,
    );
    await move(root, frames);
    shown.push(shownText(root));
    // Each start's progress line, and the line a refused layer leaves; Explore
    // last, since it closes the card.
    for (const start of starts) {
      await move(root, frames, '.first-run-back');
      root.querySelector(`[data-first-run-start="${start}"]`).click();
      await move(root, frames);
      root.querySelector('[data-first-run-primary]').click();
      await nextTick();
      shown.push(shownText(root));
      for (const resolve of pending.splice(0)) resolve(false);
      await new Promise((resolve) => setTimeout(resolve));
      await nextTick();
      shown.push(shownText(root));
    }
    // Composed, so a decomposed "ä" cannot slip past a stem.
    const text = shown.join('\n').normalize('NFC').toLowerCase();
    // Not vacuous: both steps and every start's lines were read.
    assert.match(text, /god's eye view sverige/);
    for (const phrase of READ[locale]) {
      assert.ok(text.includes(phrase), `${locale}: read "${phrase}"`);
    }
    for (const stem of FORBIDDEN) {
      assert.doesNotMatch(
        text,
        stem,
        `${locale}: ${stem} is back in the welcome`,
      );
    }
  }
});

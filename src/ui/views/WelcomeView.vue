<script setup>
import { storeToRefs } from 'pinia';
import { nextTick, ref, watch } from 'vue';
import { msg, t } from '../../i18n/index.js';
import { FIRST_RUN_LINKS } from '../../firstRunCopy.js';
import UiButton from '../kit/UiButton.vue';
import UiCheckbox from '../kit/UiCheckbox.vue';
import UiIcon from '../kit/UiIcon.vue';
import { useFirstRunStore } from '../stores/firstRun.js';
import { useStoriesStore } from '../stores/stories.js';

// The launcher initFirstRunExperience presents, and the controls it connects.
const { launcher, controls } = storeToRefs(useFirstRunStore());

// Where the visitor starts: a tile selects it, GET STARTED runs it. A clean
// map unless they pick one of the Swedish starts (Swedish fork).
const start = ref('explore');
const settling = ref(false);
function selectStart(choice) {
  if (settling.value || launcher.value?.busy === 'true' || launcher.value?.closing) return;
  start.value = choice;
}

// Short steps instead of one dense card. Swedish fork: two, where to start
// and then the three things worth knowing; the original's mode step (God or
// Analyst) is not offered. Back and Next move between them; Skip closes.
// The suppress box's hook, as one object, so the box is not rendered again
// with every render of the welcome.
const suppressBoxAttrs = { 'data-first-run-suppress': '' };
const STEPS = 2;
const step = ref(1);
const direction = ref('forward');
function go(next, event) {
  if (event?.detail > 1) return;
  if (settling.value || launcher.value?.busy === 'true' || launcher.value?.closing) return;
  settling.value = true;
  direction.value = next > step.value ? 'forward' : 'back';
  step.value = Math.min(STEPS, Math.max(1, next));
}
// A press belongs to the step it began on: one begun while the steps were
// changing (and released after) runs nothing. Keyboard clicks (detail 0)
// have no press.
let pressedOn = null;
function onPrimaryDown() {
  pressedOn = settling.value ? null : step.value;
}
// A quick second click still moves to the next step, so the button never
// looks dead; only the launch itself takes a single click, so a double click
// that began on NEXT never confirms the start it lands on.
function onPrimary(event) {
  if (settling.value) return;
  const pressed = pressedOn;
  pressedOn = null;
  if (event.detail >= 1 && pressed !== step.value) return;
  if (step.value < STEPS) go(step.value + 1);
  else if (event.detail <= 1) controls.value?.choose(start.value);
}
// GEV Stories opens in place: the card closes as Skip would, then Explore
// takes the globe. The Stories announcement stays hidden while Stories loads,
// so it does not flash up between the card closing and Explore opening; it is
// still not marked seen. The card is left out where Stories is not offered.
const stories = useStoriesStore();
let openingStories = false;
function openStories(event) {
  if (event?.detail > 1) return;
  if (settling.value || launcher.value?.busy === 'true' || launcher.value?.closing) return;
  if (!stories.available || !stories.controller) return;
  if (openingStories) return;
  const body = globalThis.document?.body;
  // Stories says at once whether it opens (it refuses while another mode
  // holds the globe): only then does the card close, so a refusal never
  // leaves nothing on screen.
  const opening = stories.controller.open();
  if (opening === false) return;
  openingStories = true;
  body?.classList.add('first-run-opening-stories');
  controls.value?.dismiss();
  Promise.resolve(opening)
    .catch(() => {})
    .finally(() => {
      openingStories = false;
      body?.classList.remove('first-run-opening-stories');
    });
}
function onPrimaryKeydown(event) {
  if (event.repeat) event.preventDefault();
}
function beforeStepEnter() {
  globalThis.document?.querySelector('#first-run-launcher .first-run-choices')
    ?.scrollTo({ top: 0, behavior: 'instant' });
}
function afterStepEnter() {
  settling.value = false;
  controls.value?.refreshLayout();
}
// Keyboard users stay on the main action as the steps change.
watch(step, async () => {
  await nextTick();
  if (!launcher.value?.visible || launcher.value?.closing) return;
  globalThis.document
    ?.querySelector('#first-run-launcher [data-first-run-primary]')
    ?.focus?.({ preventScroll: true });
});
// Swedish fork: the first step's heading is the line from the owner's films,
// the product name first; the name is never translated (translate="no").
const PRODUCT_NAME = 'God\'s Eye View Sverige';
const TITLES = [
  msg('a Swedish version, developed further by Kaj Obst'),
  msg('Three things to know'),
];
const LEADS = [
  msg('Open data about Sweden, much of it in real time: traffic, weather, nature, society and infrastructure from public agencies and open sources. Everything here is public, and every layer shows its source.'),
  msg('That is all you need to get going.'),
];
// Swedish fork: the credit names the original's maintainers. The message holds
// the original's name as {product}, and the markup puts the name in its own
// translate="no" span, so no translation, by hand or by a browser, changes it.
const CREDIT = msg('Built on {product} by Bilawal Sidhu and Sameh Khamis (MIT licence)');
const ORIGINAL_NAME = 'God\'s Eye View';
const creditParts = () => t(CREDIT).split('{product}');

// A callout opens from the chip's start edge unless that would run past the
// scrolling list, which clips it; then it opens from the end edge, and where
// neither side has room it narrows (and wraps) to the roomier side.
function alignCallout(event) {
  const chip = event.target?.closest?.('[data-callout]');
  const list = chip?.closest('.first-run-choices');
  if (!chip || !list) return;
  delete chip.dataset.calloutAlign;
  chip.style.removeProperty('--first-run-callout-max');
  const after = globalThis.getComputedStyle?.(chip, '::after');
  const width = parseFloat(after?.width);
  if (!Number.isFinite(width)) return;
  const box = chip.getBoundingClientRect();
  const bounds = list.getBoundingClientRect();
  const inset = parseFloat(after.insetInlineStart) || 0;
  const extra = ['paddingLeft', 'paddingRight', 'borderLeftWidth', 'borderRightWidth']
    .reduce((sum, key) => sum + (parseFloat(after[key]) || 0), 0);
  const size = after.boxSizing === 'border-box' ? width : width + extra;
  const rtl = globalThis.getComputedStyle?.(chip).direction === 'rtl';
  const roomStart = rtl ? box.right - inset - bounds.left : bounds.right - box.left - inset;
  const roomEnd = rtl ? bounds.right - box.left - inset : box.right - inset - bounds.left;
  if (size <= roomStart) return;
  if (roomEnd > roomStart) chip.dataset.calloutAlign = 'end';
  if (size > Math.max(roomStart, roomEnd)) {
    chip.style.setProperty('--first-run-callout-max', `${Math.floor(Math.max(roomStart, roomEnd))}px`);
  }
}

// A refused save puts the box back where the stored preference is.
function onSuppress(event) {
  const box = event.currentTarget;
  if (controls.value?.suppress(box.checked) === false) box.checked = !box.checked;
}
</script>

<template>
  <!-- Explicit first choice on a fresh session. Live feeds are not auto-enabled
       until the visitor asks; shared links skip this surface entirely. It returns
       every session until "Don't show this again" is ticked — see
       src/firstRunExperience.js for the full show policy. -->
  <!-- Tints the globe behind the card; click-through, so the card stays non-modal. -->
  <div v-if="!launcher?.removed && launcher?.shown" class="first-run-backdrop" :class="{ visible: launcher?.visible }" aria-hidden="true"></div>
  <aside v-if="!launcher?.removed" id="first-run-launcher" role="dialog" aria-labelledby="first-run-title" aria-describedby="first-run-description" :class="{ visible: launcher?.visible }" :hidden="!launcher?.shown" :aria-hidden="launcher?.closing ? 'true' : undefined" :aria-busy="launcher?.busy ?? undefined" :data-state="launcher?.state ?? undefined">
    <div class="first-run-scanline" aria-hidden="true"></div>
    <header class="first-run-header">
      <!-- Swedish fork: a neutral label. The card returns every session until
           "Don't show this again", so it does not say "first launch". -->
      <span class="first-run-kicker">{{ t('WELCOME · QUICK START') }}</span>
      <ol role="img" class="first-run-dots" :aria-label="t('Step {step} of {total}', { step, total: STEPS })">
        <li v-for="n in STEPS" :key="n" :class="{ on: n === step, done: n < step }" aria-hidden="true"></li>
      </ol>
      <!-- A button, not just a hint: phones and tablets have no ESC key. It
           closes exactly as ESC does, for this session only. Touch screens
           see SKIP; a keyboard sees SKIP · ESC (first-run.css). -->
      <UiButton class="first-run-dismiss" data-first-run-dismiss @click="controls?.dismiss()">
        <span class="first-run-dismiss-key">{{ t('SKIP · ESC') }}</span>
        <span class="first-run-dismiss-touch">{{ t('SKIP') }}</span>
      </UiButton>
    </header>
    <!-- Swedish fork: the first step opens with the product line from the
         owner's films; the product name stays as it is in every language. -->
    <h2 id="first-run-title"><template v-if="step === 1"><span translate="no">{{ PRODUCT_NAME }}</span> – </template>{{ t(TITLES[step - 1]) }}</h2>
    <p class="first-run-step-announcement" role="status" aria-live="polite" aria-atomic="true"><template v-if="step === 1"><span translate="no">{{ PRODUCT_NAME }}</span> – </template>{{ t(TITLES[step - 1]) }}</p>
    <p id="first-run-description">{{ t(LEADS[step - 1]) }}</p>
    <div class="first-run-choices ui-scroll" :data-scrollable="launcher?.scrollable ?? undefined">
     <Transition :name="`first-run-step-${direction}`" mode="out-in" @before-enter="beforeStepEnter" @after-enter="afterStepEnter">
      <div v-if="step === 1" key="1" class="first-run-step">
      <!-- Swedish fork: no mode step (God or Analyst); the card opens on where
           to start, with Swedish starts in place of SPACE MISSIONS and
           ENVIRONMENTAL. Their layers are in FIRST_RUN_MISSIONS. -->
      <section class="first-run-section" aria-labelledby="first-run-start-heading">
        <h3 id="first-run-start-heading" class="first-run-section-title">{{ t('Start with') }}</h3>
        <div class="first-run-missions first-run-missions--tiles" role="group" aria-labelledby="first-run-start-heading">
          <UiButton data-first-run-start="sweden-now" :pressed="start === 'sweden-now'" :aria-disabled="String(settling || launcher?.busy === 'true')" @click="selectStart('sweden-now')">
            <UiIcon name="schedule" :size="null" />
            <!-- Trafikverket's roads need its key, so the tile says so; without
                 one the layer still switches on and its row explains. -->
            <span><strong>{{ t('SWEDEN RIGHT NOW') }}</strong><small>{{ t('Weather warnings and weather from SMHI, road conditions from Trafikverket (key required)') }}</small></span>
          </UiButton>
          <UiButton data-first-run-start="nature-weather" :pressed="start === 'nature-weather'" :aria-disabled="String(settling || launcher?.busy === 'true')" @click="selectStart('nature-weather')">
            <UiIcon name="eco" :size="null" />
            <span><strong>{{ t('NATURE AND WEATHER') }}</strong><small>{{ t('Protected nature from Naturvårdsverket, river flow from SMHI and the aurora forecast from NOAA') }}</small></span>
          </UiButton>
          <UiButton data-first-run-start="explore" :pressed="start === 'explore'" :aria-disabled="String(settling || launcher?.busy === 'true')" @click="selectStart('explore')">
            <UiIcon name="public" :size="null" />
            <span><strong>{{ t('EXPLORE ON YOUR OWN') }}</strong><small>{{ t('Begin with a clean map') }}</small></span>
          </UiButton>
        </div>
      </section>

      </div>
      <div v-else key="2" class="first-run-step">
      <ul class="first-run-tips">
        <li class="first-run-tip first-run-tip--search">
          <span class="first-run-tip-art" aria-hidden="true"><UiIcon name="search" :size="null" /><i class="first-run-tip-caret"></i></span>
          <strong>{{ t('Search places') }}</strong>
          <small>{{ t('Type a place into the search bar.') }}</small>
        </li>
        <li class="first-run-tip first-run-tip--layers">
          <span class="first-run-tip-art" aria-hidden="true"><UiIcon name="layers" :size="null" /><i class="first-run-tip-dot"></i></span>
          <strong>{{ t('Turn on layers') }}</strong>
          <small>{{ t('Turn layers on to see flights, ships, cameras, weather and more.') }}</small>
        </li>
        <li class="first-run-tip first-run-tip--context">
          <span class="first-run-tip-art" aria-hidden="true"><UiIcon name="my_location" :size="null" /><i class="first-run-tip-ring"></i></span>
          <strong>{{ t('Click anything') }}</strong>
          <small>{{ t('Select a map item to see its details.') }}</small>
        </li>
      </ul>
      <section class="first-run-section" aria-labelledby="first-run-deeper-heading">
        <h3 id="first-run-deeper-heading" class="first-run-section-title">{{ t('Go deeper') }}</h3>
        <div v-if="stories.available" class="first-run-link-card first-run-stories">
          <div class="first-run-preview first-run-preview--stories" aria-hidden="true"><UiIcon name="movie" :size="null" /></div>
          <div class="first-run-link-body">
            <p class="first-run-mode-title"><strong translate="no">GEV Stories</strong> <span class="first-run-tag">{{ t('NEW') }}</span></p>
            <p class="first-run-mode-copy">{{ t('Curated, interactive views of what is happening on Earth. Play one, take over the map whenever you like, then pick the story back up.') }}</p>
          </div>
          <UiButton class="first-run-link-button" data-first-run-stories :aria-disabled="String(settling || launcher?.busy === 'true')" @click="openStories">{{ t('BROWSE STORIES') }}</UiButton>
        </div>
      </section>


      <!-- Swedish fork: one line crediting the original, in place of More from
           Halfpixel and its social links, and the Swedish version's own
           repository. A grid rather than the chip row, so the long credit
           wraps on a phone instead of running past the card. -->
      <section class="first-run-section" aria-labelledby="first-run-more-heading">
        <h3 id="first-run-more-heading" class="first-run-section-title">{{ t('Source code') }}</h3>
        <div class="first-run-link-row" @pointerover="alignCallout" @focusin="alignCallout">
          <!-- The callout is visual only; the chip's hidden <small> gives the
               same words to the link's accessible name, so it says where it
               goes (first-run.css hides a quiet chip's <small>). -->
          <a class="first-run-link-card first-run-link-card--quiet" :href="FIRST_RUN_LINKS.source" :data-callout="t('The original\'s source code on GitHub')" target="_blank" rel="noopener noreferrer">
            <span class="first-run-link-badge" aria-hidden="true">&lt;/&gt;</span>
            <span class="first-run-link-body"><strong>{{ creditParts()[0] }}<span translate="no">{{ ORIGINAL_NAME }}</span>{{ creditParts()[1] }}</strong> <small>{{ t('The original\'s source code on GitHub') }}</small></span>
          </a>
          <a class="first-run-link-card first-run-link-card--quiet" :href="FIRST_RUN_LINKS.fork" :data-callout="t('Open source. Self-host, fork, add a layer.')" target="_blank" rel="noopener noreferrer">
            <span class="first-run-link-badge" aria-hidden="true">SE</span>
            <span class="first-run-link-body"><strong>{{ t('The Swedish version on GitHub') }}</strong></span>
          </a>
        </div>
      </section>
      </div>
     </Transition>
    </div>
    <div class="first-run-footer">
      <UiCheckbox class="first-run-suppress" :input-attrs="suppressBoxAttrs" @change="onSuppress">
        <span>{{ t('Don\'t show this again') }}</span>
      </UiCheckbox>
      <!-- The status line: empty until a mission reports progress or an
           error. It sits in the footer row, so it never changes the card's
           height. -->
      <p class="first-run-note" data-first-run-status role="status" aria-live="polite">{{ launcher?.status ?? '' }}</p>
      <!-- The card's main action: GET STARTED (Swedish fork), starting where
           the selected tile says (a clean map by default). -->
      <UiButton v-if="step > 1" class="first-run-back" :aria-disabled="String(settling || launcher?.busy === 'true')" @click="go(step - 1, $event)">{{ t('BACK') }}</UiButton>
      <UiButton class="first-run-enter" :data-first-run-choice="step === STEPS ? start : undefined" :data-first-run-next="step < STEPS ? '' : undefined" data-first-run-primary aria-describedby="first-run-title first-run-description" @pointerdown="onPrimaryDown" @keydown.enter="onPrimaryKeydown" :aria-disabled="String(settling || launcher?.busy === 'true')" @click="onPrimary">
        {{ step < STEPS ? t('NEXT') : t('GET STARTED') }} <UiIcon name="arrow_forward" :size="null" />
      </UiButton>
    </div>

  </aside>
</template>

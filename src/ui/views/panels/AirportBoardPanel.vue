<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { t } from '../../../i18n/index.js';
import { useAirportBoardStore } from '../../stores/airportBoard.js';
import SplitFlapText from './SplitFlapText.vue';

// The airport board (Swedish fork): a Swedavia airport's whole day, opened
// from the city dossier or from the card offered over the airport. The
// controller (src/ui/airportBoard.js) presents it and answers through act().
const store = useAirportBoardStore();
const { view } = storeToRefs(store);
const list = ref(null);
// Each opening (airport, tab or day) scrolls to "now" once its rows arrive.
let scrolledFor = null;

watch(
  () => [view.value.board?.scrollKey, view.value.board?.rows?.length ?? 0],
  async ([key, count]) => {
    if (key == null || key === scrolledFor || !count) return;
    scrolledFor = key;
    await nextTick();
    const box = list.value;
    if (!box) return;
    const mark = box.querySelector('[data-now]');
    box.scrollTop = mark ? Math.max(0, mark.offsetTop - 28) : 0;
  },
);

function toggle(row) {
  store.act('toggle', row.key);
}

function onKey(event) {
  if (event.key !== 'Escape' || !view.value.board) return;
  store.act('close');
}
onMounted(() => document.addEventListener('keydown', onKey));
onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
</script>

<template>
  <Teleport to="body">
    <Transition name="airport-card">
      <div v-if="view.card" :key="view.card.iata" class="airport-card">
        <button type="button" class="airport-card-open" @click="store.act('open', view.card.iata)">
          <span class="material-symbols-outlined" aria-hidden="true">flight</span>
          <span><strong>{{ view.card.name }}</strong><small>{{ view.card.label }}</small></span>
        </button>
        <button type="button" class="airport-card-close" :aria-label="t('Close')" @click="store.act('dismissCard')">
          <span class="material-symbols-outlined" aria-hidden="true">close</span>
        </button>
      </div>
    </Transition>
    <section v-if="view.board" class="airport-board" role="dialog" :aria-label="view.board.name">
      <header class="airport-board-head">
        <span class="material-symbols-outlined airport-board-logo" aria-hidden="true">flight</span>
        <div class="airport-board-title">
          <strong>{{ view.board.name }}</strong>
          <small>{{ [view.board.dateLabel, view.board.updated].filter(Boolean).join(' · ') }}</small>
        </div>
        <div class="airport-board-days" role="group" :aria-label="t('Day')">
          <button type="button" :aria-pressed="String(view.board.date === 'today')" @click="store.act('setDate', 'today')">{{ t('Today') }}</button>
          <button type="button" :aria-pressed="String(view.board.date === 'tomorrow')" @click="store.act('setDate', 'tomorrow')">{{ t('Tomorrow') }}</button>
        </div>
        <button type="button" class="airport-board-icon" :aria-label="t('Refresh')" @click="store.act('refresh')">
          <span class="material-symbols-outlined" :class="{ spinning: view.board.loading }" aria-hidden="true">refresh</span>
        </button>
        <button type="button" class="airport-board-icon" :aria-label="t('Close')" @click="store.act('close')">
          <span class="material-symbols-outlined" aria-hidden="true">close</span>
        </button>
      </header>
      <nav class="airport-board-tabs" role="tablist">
        <button v-for="tab in view.board.tabs" :key="tab.id" type="button" role="tab" :aria-selected="String(tab.active)" :class="{ active: tab.active }" @click="store.act('setTab', tab.id)">
          <span class="material-symbols-outlined" aria-hidden="true">{{ tab.icon }}</span>{{ tab.label }}
        </button>
        <label v-if="view.board.kind !== 'security'" class="airport-board-search">
          <span class="material-symbols-outlined" aria-hidden="true">search</span>
          <input type="search" :value="view.board.query" :placeholder="t('Flight, city or airline')" :aria-label="t('Search flights')" @input="store.act('setQuery', $event.target.value)" />
        </label>
      </nav>
      <div ref="list" class="airport-board-list ui-scroll">
        <template v-if="view.board.kind !== 'security'">
          <div class="airport-board-colhead" aria-hidden="true">
            <span>{{ t('Time') }}</span>
            <span>{{ view.board.kind === 'departures' ? t('To') : t('From') }}</span>
            <span>{{ t('Flight') }}</span>
            <span>{{ view.board.kind === 'departures' ? t('Gate') : t('Belt') }}</span>
            <span>{{ t('Status') }}</span>
          </div>
          <template v-for="row in view.board.rows" :key="row.key">
            <div v-if="row.nowBefore" class="airport-board-now" data-now><span>{{ t('Now') }}</span></div>
            <div class="airport-board-row" :data-tone="row.tone" :class="{ open: row.open }" role="button" tabindex="0" :aria-expanded="String(row.open)" @click="toggle(row)" @keydown.enter.prevent="toggle(row)" @keydown.space.prevent="toggle(row)">
              <span class="ab-time"><s v-if="row.newTime">{{ row.time }}</s><template v-else>{{ row.time }}</template><b v-if="row.newTime">{{ row.newTime }}</b></span>
              <span class="ab-place">{{ row.place }}<small v-if="row.via">{{ row.via }}</small></span>
              <span class="ab-flight">{{ row.flight }}<small>{{ [row.codeshares, row.airline].filter(Boolean).join(' · ') }}</small></span>
              <span class="ab-where">{{ row.where }}</span>
              <span class="ab-status">
                <button v-if="row.live" type="button" class="ab-follow" :aria-label="t('Follow the aircraft')" :title="t('Follow the aircraft')" @click.stop="store.act('follow', row.key)">
                  <span class="material-symbols-outlined" aria-hidden="true">flight</span>
                </button>
                <SplitFlapText :text="row.status" />
              </span>
            </div>
            <dl v-if="row.details" class="airport-board-details">
              <div v-for="item in row.details" :key="item.label"><dt>{{ item.label }}</dt><dd>{{ item.value }}</dd></div>
              <button v-if="row.live" type="button" class="airport-board-follow" @click="store.act('follow', row.key)">
                <span class="material-symbols-outlined" aria-hidden="true">flight</span>{{ t('Follow the aircraft') }}
              </button>
            </dl>
          </template>
        </template>
        <template v-else>
          <div v-for="row in view.board.rows" :key="row.key" class="airport-board-queue" :data-level="row.level" :class="{ fast: row.fastTrack }">
            <span class="material-symbols-outlined" aria-hidden="true">security</span>
            <span><strong>{{ row.name }}</strong><small>{{ row.lane }}</small></span>
            <b>{{ row.minutes }}</b>
            <button v-if="row.mapped" type="button" class="airport-board-icon" :aria-label="t('Show on the map')" :title="t('Show on the map')" @click="store.act('showQueue', row.key)">
              <span class="material-symbols-outlined" aria-hidden="true">my_location</span>
            </button>
          </div>
          <p v-if="view.board.rows.length" class="airport-board-note">{{ t('The wait projected for someone joining the queue now.') }}</p>
        </template>
        <p v-if="view.board.empty" class="airport-board-empty">{{ view.board.empty }}</p>
      </div>
      <footer class="airport-board-foot">
        <span>{{ t('Source: Swedavia') }}</span>
        <span v-if="view.board.flightsOff && view.board.kind !== 'security'" class="airport-board-flights-off">
          {{ t('Turn on the flights layer to follow aircraft from the board') }}
          <button type="button" @click="store.act('enableFlights')">{{ t('Turn on') }}</button>
        </span>
      </footer>
    </section>
  </Teleport>
</template>

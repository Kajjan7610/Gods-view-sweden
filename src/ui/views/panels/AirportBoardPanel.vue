<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { t } from '../../../i18n/index.js';
import { useAirportBoardStore } from '../../stores/airportBoard.js';
import { useAirportRoutesStore } from '../../stores/airportRoutes.js';
import UiButton from '../../kit/UiButton.vue';
import UiCloseButton from '../../kit/UiCloseButton.vue';
import UiIcon from '../../kit/UiIcon.vue';
import SplitFlapText from './SplitFlapText.vue';

// The airport board (Swedish fork): a Swedavia airport's whole day, opened
// from the city dossier or from the card offered over the airport. The
// controller (src/ui/airportBoard.js) presents it and answers through act().
// Today and Tomorrow are pressed toggles rather than a UiSegmented, whose
// radio group would change their keys and their look.
const store = useAirportBoardStore();
const { view } = storeToRefs(store);
const list = ref(null);
// Today's routes on the globe: the chip that names them and hides them.
const routesStore = useAirportRoutesStore();
const { view: routes } = storeToRefs(routesStore);
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
        <UiButton class="airport-card-open" @click="store.act('open', view.card.iata)">
          <UiIcon name="flight" :size="null" />
          <span><strong>{{ view.card.name }}</strong><small>{{ view.card.label }}</small></span>
        </UiButton>
        <UiCloseButton class="airport-card-close" glyph="icon" :label="t('Close')" @click="store.act('dismissCard')" />
      </div>
    </Transition>
    <Transition name="airport-card">
      <div v-if="routes" :key="routes.iata" class="airport-card airport-routes-chip">
        <UiButton class="airport-card-open" @click="routesStore.act('openBoard', routes.iata)">
          <UiIcon name="public" :size="null" />
          <span><strong>{{ routes.name }}</strong><small>{{ routes.label }}</small></span>
        </UiButton>
        <UiCloseButton class="airport-card-close" glyph="icon" :label="t('Hide the routes')" :title="t('Hide the routes')" @click="routesStore.act('hide')" />
      </div>
    </Transition>
    <section v-if="view.board" class="airport-board" role="dialog" :aria-label="view.board.name">
      <header class="airport-board-head">
        <UiIcon class="airport-board-logo" name="flight" :size="null" />
        <div class="airport-board-title">
          <strong>{{ view.board.name }}</strong>
          <small>{{ [view.board.dateLabel, view.board.updated].filter(Boolean).join(' · ') }}</small>
          <UiButton v-if="view.board.weather" class="airport-board-weather" :title="t('Weather')" @click="store.act('setTab', 'weather')">
            <b v-if="view.board.weather.category" :style="{ color: view.board.weather.color, borderColor: view.board.weather.color }">{{ view.board.weather.category }}</b>{{ view.board.weather.line }}
          </UiButton>
        </div>
        <div class="airport-board-days" role="group" :aria-label="t('Day')">
          <UiButton :pressed="view.board.date === 'today'" @click="store.act('setDate', 'today')">{{ t('Today') }}</UiButton>
          <UiButton :pressed="view.board.date === 'tomorrow'" @click="store.act('setDate', 'tomorrow')">{{ t('Tomorrow') }}</UiButton>
        </div>
        <UiButton v-if="view.board.routes" class="airport-board-icon" :aria-label="t('Today’s routes on the map')" :title="t('Today’s routes on the map')" @click="store.act('showRoutes')">
          <UiIcon name="public" :size="null" />
        </UiButton>
        <UiButton class="airport-board-icon" :aria-label="t('Refresh')" @click="store.act('refresh')">
          <UiIcon name="refresh" :class="{ spinning: view.board.loading }" :size="null" />
        </UiButton>
        <UiCloseButton class="airport-board-icon" glyph="icon" :label="t('Close')" @click="store.act('close')" />
      </header>
      <nav class="airport-board-tabs" role="tablist">
        <UiButton v-for="tab in view.board.tabs" :key="tab.id" role="tab" :aria-selected="String(tab.active)" :class="{ active: tab.active }" @click="store.act('setTab', tab.id)">
          <UiIcon :name="tab.icon" :size="null" />{{ tab.label }}
        </UiButton>
        <label v-if="view.board.kind === 'departures' || view.board.kind === 'arrivals'" class="airport-board-search">
          <UiIcon name="search" :size="null" />
          <input type="search" :value="view.board.query" :placeholder="t('Flight, city or airline')" :aria-label="t('Search flights')" @input="store.act('setQuery', $event.target.value)" />
        </label>
      </nav>
      <div ref="list" class="airport-board-list ui-scroll">
        <template v-if="view.board.kind === 'weather'">
          <dl v-if="view.board.rows.length" class="airport-board-details airport-board-weather-rows">
            <div v-for="item in view.board.rows" :key="item.label"><dt>{{ item.label }}</dt><dd>{{ item.value }}</dd></div>
          </dl>
          <pre v-if="view.board.metar" class="airport-board-raw">{{ view.board.metar }}</pre>
          <pre v-if="view.board.taf" class="airport-board-raw">{{ view.board.taf }}</pre>
          <p v-if="view.board.metar" class="airport-board-note">{{ t('METAR and TAF from the NOAA Aviation Weather Center (aviationweather.gov).') }}</p>
        </template>
        <template v-else-if="view.board.kind !== 'security'">
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
                <UiButton v-if="row.live" class="ab-follow" :class="{ inbound: row.inbound }" :aria-label="row.inbound ? t('Follow the aircraft, still on its way in') : t('Follow the aircraft')" :title="row.inbound ? t('Follow the aircraft, still on its way in') : t('Follow the aircraft')" @click.stop="store.act('follow', row.key)">
                  <UiIcon name="flight" :size="null" />
                </UiButton>
                <SplitFlapText :text="row.status" />
              </span>
            </div>
            <dl v-if="row.details" class="airport-board-details">
              <div v-for="item in row.details" :key="item.label"><dt>{{ item.label }}</dt><dd>{{ item.value }}</dd></div>
              <UiButton v-if="row.live" class="airport-board-follow" @click="store.act('follow', row.key)">
                <UiIcon name="flight" :size="null" />{{ row.inbound ? t('Follow the aircraft, still on its way in') : t('Follow the aircraft') }}
              </UiButton>
            </dl>
          </template>
        </template>
        <template v-else>
          <div v-for="row in view.board.rows" :key="row.key" class="airport-board-queue" :data-level="row.level" :class="{ fast: row.fastTrack }">
            <UiIcon name="security" :size="null" />
            <span><strong>{{ row.name }}</strong><small>{{ row.lane }}</small></span>
            <b>{{ row.minutes }}</b>
            <UiButton v-if="row.mapped" class="airport-board-icon" :aria-label="t('Show on the map')" :title="t('Show on the map')" @click="store.act('showQueue', row.key)">
              <UiIcon name="my_location" :size="null" />
            </UiButton>
          </div>
          <p v-if="view.board.rows.length" class="airport-board-note">{{ t('The wait projected for someone joining the queue now.') }}</p>
        </template>
        <p v-if="view.board.empty" class="airport-board-empty">{{ view.board.empty }}</p>
      </div>
      <footer class="airport-board-foot">
        <span>{{ t('Source: Swedavia') }}</span>
        <span v-if="view.board.flightsOff && view.board.kind !== 'security'" class="airport-board-flights-off">
          {{ t('Turn on the flights layer to follow aircraft from the board') }}
          <UiButton @click="store.act('enableFlights')">{{ t('Turn on') }}</UiButton>
        </span>
      </footer>
    </section>
  </Teleport>
</template>

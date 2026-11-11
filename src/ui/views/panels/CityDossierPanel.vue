<script setup>
import { nextTick, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { t } from '../../../i18n/index.js';
import RailPanel from '../../rail/RailPanel.vue';
import { useCityDossierStore } from '../../stores/cityDossier.js';
import { useAirportBoardStore } from '../../stores/airportBoard.js';

// The city dossier on the right rail. The dossier controller presents the
// town the view is visiting (src/ui/cityDossier.js); the panel stays hidden
// until the first visit and answers its tabs and radio button through act().
const store = useCityDossierStore();
const { view: d } = storeToRefs(store);
// "Full board" opens the airport board (src/ui/airportBoard.js).
const airportBoard = useAirportBoardStore();
// A sight picked on the map scrolls into view in the list.
watch(
  () => d.value?.sights?.chosen,
  async (id) => {
    if (!id) return;
    await nextTick();
    document
      .querySelector(`#city-panel-body [data-sight="${id}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  },
);
</script>

<template>
  <RailPanel id="city-panel" :hidden="!d" start-collapsed :title="t('CITY')" sideways rail-scroller>
    <template #badge><span id="city-panel-name">{{ d?.name || '' }}</span></template>
    <div id="city-panel-body" class="city-dossier ui-scroll" data-rail-scroller>
      <template v-if="d">
        <header class="city-dossier-head">
          <img v-if="d.coatOfArms" class="city-dossier-arms" :src="d.coatOfArms" alt="" loading="lazy" referrerpolicy="no-referrer" />
          <div>
            <strong class="city-dossier-name">{{ d.name }}</strong>
            <small class="city-dossier-sub">{{ d.subtitle }}</small>
            <small v-if="d.visits" class="city-dossier-visits"><span class="material-symbols-outlined" aria-hidden="true">approval</span>{{ d.visits }}</small>
          </div>
        </header>
        <nav class="city-dossier-tabs" role="tablist" :aria-label="t('City dossier sections')">
          <button v-for="tab in d.tabs" :key="tab.id" type="button" role="tab" :aria-selected="String(tab.active)" :class="{ active: tab.active }" @click="store.act('setTab', tab.id)">{{ tab.label }}</button>
        </nav>
        <p v-if="d.error" class="city-dossier-note">{{ d.error }}</p>

        <section v-if="d.tab === 'about' && d.about" class="city-dossier-section" role="tabpanel">
          <img v-if="d.about.image" class="city-dossier-photo" :src="d.about.image" alt="" loading="lazy" referrerpolicy="no-referrer" />
          <small v-if="d.about.imageCredit || d.coatOfArmsCredit" class="city-dossier-note city-dossier-credits"><a v-if="d.about.imageCredit" :href="d.about.imageCredit" target="_blank" rel="noopener noreferrer">{{ t('Photo: Wikimedia Commons') }}</a><a v-if="d.coatOfArmsCredit" :href="d.coatOfArmsCredit" target="_blank" rel="noopener noreferrer">{{ t('Coat of arms: Wikimedia Commons') }}</a></small>
          <p class="city-dossier-text">{{ d.about.extract }}</p>
          <dl v-if="d.about.rows.length" class="city-dossier-rows">
            <div v-for="row in d.about.rows" :key="row.label"><dt>{{ row.label }}</dt><dd>{{ row.value }}</dd></div>
          </dl>
          <a v-if="d.about.credit" class="city-dossier-credit" :href="d.about.credit.url" target="_blank" rel="noopener noreferrer">{{ d.about.credit.text }}</a>
        </section>

        <section v-else-if="d.tab === 'people' && d.people" class="city-dossier-section" role="tabpanel">
          <dl class="city-dossier-rows">
            <div v-for="row in d.people.rows" :key="row.label"><dt>{{ row.label }}</dt><dd>{{ row.value }} <small v-if="row.detail">{{ row.detail }}</small></dd></div>
          </dl>
          <figure v-if="d.people.spark" class="city-dossier-spark" :class="{ falling: !d.people.spark.rising }">
            <svg viewBox="0 0 220 44" preserveAspectRatio="none" aria-hidden="true" focusable="false"><polyline :points="d.people.spark.points" fill="none" /></svg>
            <figcaption><span>{{ d.people.spark.from }}</span><strong>{{ d.people.spark.text }}</strong><span>{{ d.people.spark.to }}</span></figcaption>
          </figure>
        </section>

        <section v-else-if="d.tab === 'society' && d.society" class="city-dossier-section" role="tabpanel">
          <dl class="city-dossier-rows">
            <div v-for="row in d.society.rows" :key="row.label"><dt>{{ row.label }}</dt><dd>{{ row.value }} <small v-if="row.detail">{{ row.detail }}</small></dd></div>
          </dl>
          <div v-if="d.society.election" class="city-dossier-election">
            <strong>{{ d.society.election.title }}</strong>
            <div v-for="row in d.society.election.parties" :key="row.party" class="city-dossier-party">
              <span :title="row.party">{{ row.party }}</span>
              <i :style="{ width: row.width, background: row.color }"></i>
              <small>{{ row.share }}</small>
            </div>
          </div>
        </section>

        <section v-else-if="d.tab === 'now'" class="city-dossier-section" role="tabpanel">
          <p v-if="d.now.loading" class="city-dossier-note">{{ d.now.status }}</p>
          <template v-else>
            <dl class="city-dossier-rows">
              <div v-if="d.now.weather"><dt>{{ t('Weather now') }}</dt><dd>{{ d.now.weather.value }} <small>{{ d.now.weather.detail }}</small></dd></div>
              <div v-if="d.now.air"><dt>{{ t('Air quality') }}</dt><dd><i class="city-dossier-dot" :style="{ background: d.now.air.color }"></i>{{ d.now.air.value }} <small>{{ d.now.air.risk }}</small></dd></div>
              <div><dt>{{ t('Sun') }}</dt><dd>{{ d.now.sun }}</dd></div>
            </dl>
            <ul v-if="d.now.alerts.length" class="city-dossier-alerts">
              <li v-for="alert in d.now.alerts" :key="alert.key" :data-level="alert.level"><strong>{{ alert.title }}</strong><span>{{ alert.meta }}</span></li>
            </ul>
            <p v-else-if="d.now.alertsNote" class="city-dossier-note">{{ d.now.alertsNote }}</p>
            <div v-if="d.now.aurora" class="city-dossier-aurora" :data-level="d.now.aurora.level">
              <strong><span class="material-symbols-outlined" aria-hidden="true">auto_awesome</span>{{ d.now.aurora.title }}</strong>
              <small v-if="d.now.aurora.detail">{{ d.now.aurora.detail }}</small>
              <button v-if="!d.now.aurora.layerOn" type="button" @click="store.act('showAurora')">{{ t('Show the aurora oval on the map') }}</button>
            </div>
            <div v-if="d.now.kris" class="city-dossier-kris">
              <a v-for="vma in d.now.kris.vmas" :key="vma.key" class="city-dossier-vma" :href="vma.url || undefined" target="_blank" rel="noopener noreferrer">
                <strong><span class="material-symbols-outlined" aria-hidden="true">campaign</span>{{ vma.headline }}</strong>
                <span v-if="vma.text">{{ vma.text }}</span>
                <small>{{ vma.meta }}</small>
              </a>
              <strong class="city-dossier-kris-title">{{ d.now.kris.title }}</strong>
              <p v-if="d.now.kris.empty" class="city-dossier-note">{{ d.now.kris.empty }}</p>
              <a v-for="item in d.now.kris.news" :key="item.key" :href="item.url || undefined" target="_blank" rel="noopener noreferrer"><small>{{ item.meta }}</small> {{ item.headline }}</a>
            </div>
            <div v-if="d.now.cameras" class="city-dossier-trains city-dossier-cameras">
              <strong><span class="material-symbols-outlined" aria-hidden="true">speed_camera</span>{{ d.now.cameras.title }}</strong>
              <button v-for="row in d.now.cameras.items" :key="row.key" type="button" class="city-dossier-camera" :title="t('Show on the map')" @click="store.act('showCamera', row.key)">
                <span class="city-dossier-camera-road">{{ row.road }}</span>
                <span class="city-dossier-dest">{{ row.name }}<small v-if="row.detail">{{ row.detail }}</small></span>
                <span class="material-symbols-outlined" aria-hidden="true">my_location</span>
              </button>
            </div>
            <div v-if="d.now.trains" class="city-dossier-trains">
              <strong>{{ d.now.trains.title }}</strong>
              <p v-if="d.now.trains.empty" class="city-dossier-note">{{ d.now.trains.empty }}</p>
              <div v-for="row in d.now.trains.items" :key="row.key" class="city-dossier-departure" :class="{ late: row.late }">
                <span class="city-dossier-time">{{ row.time }}</span>
                <span class="city-dossier-dest">{{ row.destination }}<small v-if="row.detail">{{ row.detail }}</small></span>
                <span class="city-dossier-delay">{{ row.status }}</span>
              </div>
            </div>
            <div v-if="d.now.jams" class="city-dossier-jams">
              <strong>{{ t('Queues around the town') }}</strong>
              <p v-if="d.now.jams.empty" class="city-dossier-note">{{ d.now.jams.empty }}</p>
              <div v-for="row in d.now.jams.items" :key="row.key" class="city-dossier-jam"><span>{{ row.title }}</span><small>{{ row.detail }}</small></div>
            </div>
            <div v-for="airport in d.now.flights || []" :key="airport.key" class="city-dossier-trains city-dossier-flights">
              <div class="city-dossier-flights-head">
                <strong>{{ airport.title }}</strong>
                <button type="button" class="city-dossier-board-open" @click="airportBoard.act('open', airport.key)">
                  <span class="material-symbols-outlined" aria-hidden="true">open_in_full</span>{{ t('Full board') }}
                </button>
              </div>
              <div v-if="airport.security.length" class="city-dossier-security">
                <span class="city-dossier-board"><span class="material-symbols-outlined" aria-hidden="true">security</span>{{ t('Security queue') }}</span>
                <span v-for="queue in airport.security" :key="queue.key" class="city-dossier-queue" :class="{ busy: queue.busy }"><small v-if="queue.label">{{ queue.label }}</small>{{ queue.value }}</span>
              </div>
              <template v-for="board in airport.boards" :key="board.key">
                <span class="city-dossier-board"><span class="material-symbols-outlined" aria-hidden="true">{{ board.icon }}</span>{{ board.label }}</span>
                <p v-if="!board.items.length" class="city-dossier-note">{{ board.empty }}</p>
                <div v-for="row in board.items" :key="row.key" class="city-dossier-departure" :class="{ late: row.late }">
                  <span class="city-dossier-time">{{ row.time }}<small v-if="row.tomorrow">{{ row.tomorrow }}</small></span>
                  <span class="city-dossier-dest">{{ row.destination }}<small v-if="row.detail">{{ row.detail }}</small></span>
                  <span class="city-dossier-delay">{{ row.status }}</span>
                </div>
              </template>
            </div>
            <div v-if="d.now.police" class="city-dossier-police">
              <strong>{{ d.now.police.summary }}</strong>
              <a v-for="item in d.now.police.items" :key="item.key" :href="item.url" target="_blank" rel="noopener noreferrer"><small>{{ item.time }}</small> {{ item.title }}</a>
            </div>
            <small v-if="d.now.air" class="city-dossier-note">{{ d.now.air.station }}</small>
            <small v-if="d.now.pending" class="city-dossier-note">{{ d.now.pending }}</small>
            <small v-if="d.now.failed" class="city-dossier-note">{{ d.now.failed }}</small>
            <button type="button" class="city-dossier-radio" :disabled="d.now.radioBusy" @click="store.act('playRadio')">
              <span class="material-symbols-outlined" aria-hidden="true">radio</span>{{ d.now.radioLabel }}
            </button>
          </template>
        </section>
        <section v-else-if="d.tab === 'sights' && d.sights" class="city-dossier-section" role="tabpanel">
          <p v-if="d.sights.note" class="city-dossier-note">{{ d.sights.note }}</p>
          <ul class="city-dossier-sights">
            <li v-for="item in d.sights.items" :key="item.key" :class="{ chosen: item.chosen }" :data-sight="item.key">
              <button type="button" :aria-pressed="String(item.chosen)" @click="store.act(item.chosen ? 'clearSight' : 'chooseSight', item.key)">
                <i :style="{ background: item.color }" aria-hidden="true"></i>
                <span><strong>{{ item.name }}</strong><small>{{ item.kind }} · {{ item.distance }}</small></span>
              </button>
              <div v-if="item.chosen && (item.image || item.article)" class="city-dossier-sight-more">
                <img v-if="item.image" :src="item.image" alt="" loading="lazy" referrerpolicy="no-referrer" />
                <a v-if="item.imageCredit" class="city-dossier-note" :href="item.imageCredit" target="_blank" rel="noopener noreferrer">{{ t('Photo: Wikimedia Commons') }}</a>
                <a v-if="item.article" :href="item.article" target="_blank" rel="noopener noreferrer">{{ t('Read on Wikipedia') }}</a>
              </div>
            </li>
          </ul>
        </section>
        <section v-else-if="d.tab === 'pass'" class="city-dossier-section" role="tabpanel">          <strong class="city-dossier-pass-summary">{{ d.pass.summary }}</strong>
          <small class="city-dossier-note">{{ d.pass.total }}</small>
          <div v-for="row in d.pass.challenges" :key="row.id" class="city-dossier-challenge" :class="{ done: row.done }">
            <span>{{ row.label }}</span><small>{{ row.progress }}</small>
            <i><b :style="{ width: row.width }"></b></i>
          </div>
          <div class="city-dossier-pass-toggles">
            <button type="button" :aria-pressed="String(d.pass.showMap)" @click="store.act('togglePassMap')">{{ t('Show my journey on the map') }}</button>
            <button type="button" :aria-pressed="String(d.pass.cinematic)" @click="store.act('toggleCinematic')">{{ t('Town card on a first visit') }}</button>
          </div>
          <template v-if="d.pass.most.length">
            <strong class="city-dossier-kris-title">{{ t('Most visited') }}</strong>
            <ol class="city-dossier-stamps">
              <li v-for="stamp in d.pass.most" :key="stamp.key"><strong>{{ stamp.name }} <b class="city-dossier-count">{{ stamp.count }}</b></strong><small>{{ stamp.detail }}</small></li>
            </ol>
          </template>
          <strong class="city-dossier-kris-title">{{ t('Latest stamps') }}</strong>
          <ol class="city-dossier-stamps">
            <li v-for="stamp in d.pass.recent" :key="stamp.key"><strong>{{ stamp.name }} <b v-if="stamp.count" class="city-dossier-count">{{ stamp.count }}</b></strong><small>{{ stamp.detail }}</small></li>
          </ol>
        </section>
        <footer class="city-dossier-source">{{ d.source }}</footer>
      </template>
    </div>
  </RailPanel>
  <!-- A first visit's card at the side of the map: the town, a few facts and
       the offer to fly in. Nothing moves until the offer is taken. -->
  <Teleport to="body">
    <Transition name="city-arrival">
      <aside v-if="d?.arrival" :key="d.arrival.key" class="city-arrival" aria-live="polite">
        <div class="city-arrival-hero" :class="{ plain: !d.arrival.image }">
          <img v-if="d.arrival.image" :src="d.arrival.image" alt="" loading="lazy" referrerpolicy="no-referrer" />
        </div>
        <button type="button" class="city-arrival-close" :aria-label="t('Close')" :title="t('Close')" @click="store.act('dismissArrival')">×</button>
        <div class="city-arrival-body">
          <img v-if="d.arrival.coatOfArms" class="city-arrival-arms" :src="d.arrival.coatOfArms" alt="" loading="lazy" referrerpolicy="no-referrer" />
          <small class="city-arrival-eyebrow">{{ t('New stamp in your passport') }}</small>
          <strong>{{ d.arrival.name }}</strong>
          <span v-if="d.arrival.county" class="city-arrival-county">{{ d.arrival.county }}</span>
          <dl v-if="d.arrival.stats.length" class="city-arrival-stats">
            <div v-for="stat in d.arrival.stats" :key="stat.label"><dd>{{ stat.value }}</dd><dt>{{ stat.label }}</dt></div>
          </dl>
          <button type="button" class="city-arrival-offer" @click="store.act('flyIn')">{{ t('Fly in and read more') }}<i aria-hidden="true">→</i></button>
          <small v-if="d.arrival.imageCredit || d.arrival.coatOfArmsCredit" class="city-arrival-credit"><a v-if="d.arrival.imageCredit" :href="d.arrival.imageCredit" target="_blank" rel="noopener noreferrer">{{ t('Photo: Wikimedia Commons') }}</a><a v-if="d.arrival.coatOfArmsCredit" :href="d.arrival.coatOfArmsCredit" target="_blank" rel="noopener noreferrer">{{ t('Coat of arms: Wikimedia Commons') }}</a></small>
        </div>
      </aside>
    </Transition>
  </Teleport>
</template>

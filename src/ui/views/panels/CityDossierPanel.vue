<script setup>
import { storeToRefs } from 'pinia';
import { t } from '../../../i18n/index.js';
import RailPanel from '../../rail/RailPanel.vue';
import { useCityDossierStore } from '../../stores/cityDossier.js';

// The city dossier on the right rail. The dossier controller presents the
// town the view is visiting (src/ui/cityDossier.js); the panel stays hidden
// until the first visit and answers its tabs and radio button through act().
const store = useCityDossierStore();
const { view: d } = storeToRefs(store);
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
          </div>
        </header>
        <nav class="city-dossier-tabs" role="tablist" :aria-label="t('City dossier sections')">
          <button v-for="tab in d.tabs" :key="tab.id" type="button" role="tab" :aria-selected="String(tab.active)" :class="{ active: tab.active }" @click="store.act('setTab', tab.id)">{{ tab.label }}</button>
        </nav>
        <p v-if="d.error" class="city-dossier-note">{{ d.error }}</p>

        <section v-if="d.tab === 'about' && d.about" class="city-dossier-section" role="tabpanel">
          <img v-if="d.about.image" class="city-dossier-photo" :src="d.about.image" alt="" loading="lazy" referrerpolicy="no-referrer" />
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
            <div v-if="d.now.police" class="city-dossier-police">
              <strong>{{ d.now.police.summary }}</strong>
              <a v-for="item in d.now.police.items" :key="item.key" :href="item.url" target="_blank" rel="noopener noreferrer"><small>{{ item.time }}</small> {{ item.title }}</a>
            </div>
            <small v-if="d.now.air" class="city-dossier-note">{{ d.now.air.station }}</small>
            <small v-if="d.now.pending" class="city-dossier-note">{{ d.now.pending }}</small>
            <button type="button" class="city-dossier-radio" :disabled="d.now.radioBusy" @click="store.act('playRadio')">
              <span class="material-symbols-outlined" aria-hidden="true">radio</span>{{ d.now.radioLabel }}
            </button>
          </template>
        </section>
        <footer class="city-dossier-source">{{ d.source }}</footer>
      </template>
    </div>
  </RailPanel>
</template>

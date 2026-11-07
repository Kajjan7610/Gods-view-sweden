<script setup>
import { storeToRefs } from 'pinia';
import { t } from '../../../i18n/index.js';
import { useCockpitFlightLegStore } from '../../stores/cockpitFlightLeg.js';

// The cockpit's Swedavia card (Swedish fork): the flown aircraft's own board
// rows. Under the flight plan in the briefing window; `compact` is the phone's
// one-line strip, the briefing window being hidden there.
defineProps({ compact: { type: Boolean, default: false } });
const { view: v } = storeToRefs(useCockpitFlightLegStore());
const KICKER = 'SWEDAVIA'; // i18n-ignore: provider name
</script>

<template>
  <section v-if="v && !compact" class="cockpit-flight-leg" :aria-label="t('Swedavia flight information')">
    <div class="cockpit-flight-leg-heading">
      <span class="cockpit-flight-leg-kicker">{{ KICKER }}</span>
      <small>{{ [v.flight, v.codeshares].filter(Boolean).join(' · ') }}</small>
    </div>
    <div v-for="leg in v.legs" :key="leg.key" class="cockpit-flight-leg-row" :data-tone="leg.tone">
      <span class="cockpit-flight-leg-label">{{ leg.label }}</span>
      <strong>{{ leg.time }}<em v-if="leg.delay">{{ leg.delay }}</em></strong>
      <small v-if="leg.detail || leg.status">{{ [leg.detail, leg.status].filter(Boolean).join(' · ') }}</small>
      <small v-if="leg.weather" class="cockpit-flight-leg-weather"><b v-if="leg.category" :style="{ color: leg.categoryColor }">{{ leg.category }}</b> {{ leg.weather }}</small>
    </div>
  </section>
  <Teleport v-else-if="v && compact" to="body">
    <div class="cockpit-flight-leg-strip" :aria-label="t('Swedavia flight information')">
      <span v-for="leg in v.legs" :key="leg.key" :data-tone="leg.tone">
        <b>{{ leg.label }}</b> {{ leg.time }}<em v-if="leg.delay"> {{ leg.delay }}</em><template v-if="leg.detail"> · {{ leg.detail }}</template>
      </span>
    </div>
  </Teleport>
</template>

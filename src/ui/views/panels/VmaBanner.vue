<script setup>
import { storeToRefs } from 'pinia';
import { t } from '../../../i18n/index.js';
import { useVmaBannerStore } from '../../stores/vmaBanner.js';

// The public alert banner (Swedish fork): an active VMA anywhere in Sweden,
// across the top of the app (src/ui/vmaBanner.js).
const store = useVmaBannerStore();
const { rows } = storeToRefs(store);
const KICKER = 'VMA'; // i18n-ignore: the Swedish alert's own name
</script>

<template>
  <Teleport to="body">
    <div v-if="rows.length" class="vma-banner" role="alert">
      <div v-for="row in rows" :key="row.key" class="vma-banner-row">
        <span class="material-symbols-outlined" aria-hidden="true">campaign</span>
        <b>{{ KICKER }}</b>
        <span class="vma-banner-text"><strong>{{ row.headline }}</strong><small v-if="row.area">{{ row.area }}</small><small v-if="row.note" class="vma-banner-note">{{ row.note }}</small></span>
        <a v-if="row.url" :href="row.url" target="_blank" rel="noopener noreferrer">{{ t('Read more') }}</a>
        <button type="button" :aria-label="t('Close')" @click="store.act('close', row.key)">
          <span class="material-symbols-outlined" aria-hidden="true">close</span>
        </button>
      </div>
    </div>
  </Teleport>
</template>

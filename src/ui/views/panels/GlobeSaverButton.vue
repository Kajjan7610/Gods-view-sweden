<script setup>
import { computed, ref } from 'vue';
import { t } from '../../../i18n/index.js';
import { readGlobeSaver, saveGlobeSaver } from '../../../globeSaver.js';
import UiButton from '../../kit/UiButton.vue';
import UiIcon from '../../kit/UiIcon.vue';
import { useCornerActions } from './cornerActions.js';

// The 3D button (Swedish fork), in the bottom-right corner row: Google 3D
// Tiles on, or saver mode (the keyless globe, no 3D Tiles session spent).
// The tiles load only at start, so a change reloads the page; the view
// itself is kept in the address.
const storage = globalThis.localStorage;
const saver = ref(readGlobeSaver(storage, globalThis.location?.search));
const corner = useCornerActions();
const label = computed(() =>
  saver.value
    ? t('Saver mode: flat map without Google 3D. Press to turn the 3D city back on (reloads the page).')
    : t('Google 3D city on: each start uses one Cesium ion session. Press for saver mode (reloads the page).'),
);

function toggle() {
  saveGlobeSaver(storage, !saver.value);
  // A forcing ?globe= in the address would undo the choice: drop it.
  const url = new URL(globalThis.location.href);
  url.searchParams.delete('globe');
  globalThis.location.replace(url.toString());
}
</script>

<template>
  <Teleport v-if="corner" :to="corner">
    <UiButton id="globe-saver-button" :class="{ saver }" :pressed="!saver" :aria-label="label" :title="label" @click="toggle">
      <UiIcon name="public" :size="null" />
      <span class="globe-saver-label">{{ saver ? t('2D') : t('3D') }}</span>
    </UiButton>
  </Teleport>
</template>
<script setup>
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import { msg, t } from '../../../i18n/index.js';
import {
  TEXT_SIZES,
  applyTextSize,
  nextTextSize,
  readTextSize,
  saveTextSize,
} from '../../textSize.js';

// The text size button (Swedish fork), beside the language picker in the
// bottom-right corner row: each press steps Normal → Larger → Largest.
const storage = globalThis.localStorage;
const size = ref(readTextSize(storage));
applyTextSize(size.value);

const LABELS = {
  normal: msg('Normal'),
  large: msg('Larger'),
  largest: msg('Largest'),
};
const label = computed(() =>
  t('Text size: {size}', { size: t(LABELS[size.value]) }),
);
const level = computed(() => TEXT_SIZES.indexOf(size.value));

// The corner row is mounted by the provider settings view, which may come
// after this one: wait for it rather than teleport into nothing.
const corner = shallowRef(null);
let watcher = null;
onMounted(() => {
  const find = () => document.getElementById('corner-actions');
  corner.value = find();
  if (corner.value) return;
  watcher = new MutationObserver(() => {
    corner.value = find();
    if (corner.value) watcher?.disconnect();
  });
  watcher.observe(document.body, { childList: true, subtree: true });
});
onBeforeUnmount(() => watcher?.disconnect());

function step() {
  size.value = nextTextSize(size.value);
  applyTextSize(size.value);
  saveTextSize(storage, size.value);
}
</script>

<template>
  <Teleport v-if="corner" :to="corner">
    <button id="text-size-button" type="button" :aria-label="label" :title="label" @click="step">
      <span class="text-size-glyph" aria-hidden="true">A<small>A</small></span>
      <span class="text-size-level" aria-hidden="true"><i v-for="n in 3" :key="n" :class="{ on: n - 1 <= level }"></i></span>
    </button>
  </Teleport>
</template>

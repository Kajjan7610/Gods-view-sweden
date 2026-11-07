import { onBeforeUnmount, onMounted, shallowRef } from 'vue';

/**
 * The bottom-right corner row (#corner-actions), for the Swedish fork's own
 * buttons. The provider settings view mounts it and may come after the
 * caller: this waits for it rather than teleport into nothing.
 * @returns {import('vue').ShallowRef<?HTMLElement>}
 */
export function useCornerActions() {
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
  return corner;
}

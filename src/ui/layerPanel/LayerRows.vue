<script setup>
import { reactive } from 'vue';
import { t } from '../../i18n/index.js';
import RailChips from '../rail/RailChips.vue';
import RailRowList from '../rail/RailRowList.vue';
import RowSlider from './RowSlider.vue';
import RowSwitch from './RowSwitch.vue';
import RowText from './RowText.vue';
import { vClassToggle } from '../rail/classToggle.js';

// The data layer rows under their group headings. LayerPanel presents every
// value; clicks reach it with the layer id, and it re-reads the live
// descriptor before acting.
defineProps({
  items: { type: Array, required: true },
  onToggle: { type: Function, default: () => {} },
  onChip: { type: Function, default: () => {} },
  onListItem: { type: Function, default: () => {} },
  onSlider: { type: Function, default: () => {} },
  onFilter: { type: Function, default: () => {} },
});
// Which rows show their sources; kept here, so a repaint leaves them open.
const open = reactive(new Set());
const toggleSources = (id) => (open.has(id) ? open.delete(id) : open.add(id));
</script>

<template>
  <template v-for="item in items" :key="item.key"
    ><div v-if="item.filter" class="data-layer-filter"
      ><RowSwitch :segmented="item.filter" :on-select="onFilter" /></div
    ><h3 v-else-if="item.heading" class="data-layer-group-heading">{{
      item.heading
    }}</h3
    ><div
      v-else
      class="data-toggle-row"
      v-class-toggle="{
        'data-toggle-row--count-line': item.count?.countLine,
      }"
      :data-layer-id="item.id"
      :data-layer-name="item.englishName"
      ><div class="data-toggle-top"
        ><div class="data-toggle-left"
          ><span class="data-icon" aria-hidden="true">{{ item.icon }}</span
          ><RowText class="data-name" :text="item.name" /></div
        ><div class="data-toggle-right"
          ><RowText
            v-if="item.count"
            :class="['data-count', { 'data-count-empty': item.count.empty }]"
            :text="item.count.text"
          /><button
            type="button"
            :class="['data-toggle-btn', item.toggle.classes]"
            :data-feed-state="item.toggle.feedState"
            :aria-disabled="String(item.toggle.ariaDisabled)"
            :aria-busy="String(item.toggle.ariaBusy)"
            :title="item.toggle.title"
            :aria-label="item.toggle.ariaLabel"
            @click="onToggle(item.id)"
            >{{ item.toggle.text }}</button
          ></div
        ></div
      ><div v-if="item.provenance" class="data-toggle-meta-line"
        ><span
          :class="[
            'data-layer-mark',
            { 'data-layer-mark--added': item.mark.text !== 'SE' },
          ]"
          :title="item.mark.title"
          >{{ item.mark.text }}</span
        ><RowText tag="div" class="data-toggle-meta" :text="item.meta" /><button
          type="button"
          class="data-provenance-btn"
          :aria-expanded="String(open.has(item.id))"
          :aria-label="t('Sources and coverage')"
          :title="t('Sources and coverage')"
          @click="toggleSources(item.id)"
          ><span class="material-symbols-outlined" aria-hidden="true"
            >info</span
          ></button
        ></div
      ><RowText
        v-else
        tag="div"
        class="data-toggle-meta"
        :text="item.meta" /><dl
        v-if="item.provenance && open.has(item.id)"
        class="data-provenance"
        ><div v-for="line in item.provenance" :key="line.label"
          ><dt>{{ line.label }}</dt
          ><dd>{{ line.text }}</dd></div
        ></dl
      ><template v-if="item.controls"
        ><div class="data-toggle-controls" :hidden="item.controls.hidden"
          ><RailChips
            :chips="item.controls.chips"
            :on-select="(chip) => onChip(item.id, chip.id)"
          /><RowSwitch
            v-if="item.controls.segmented"
            :segmented="item.controls.segmented"
            :on-select="(optionId) => onChip(item.id, optionId)"
          /><RowSlider
            v-if="item.controls.slider"
            :slider="item.controls.slider"
            :on-input="
              (value) => onSlider(item.id, item.controls.slider.id, value)
            "
          /><span
            v-for="(entry, index) in item.controls.legend"
            :key="index"
            class="data-toggle-legend-item"
            :title="entry.blurb || undefined"
            ><span
              class="data-toggle-legend-swatch"
              :style="{ background: entry.color }"
            ></span
            ><span>{{ entry.text }}</span></span
          ><div
            v-if="item.controls.info"
            class="data-toggle-controls-info"
            :title="item.controls.info.title"
            :hidden="!item.controls.info.text"
            >{{ item.controls.info.text }}</div
          ></div
        ><RailRowList
          :list="item.controls.list"
          :on-select="
            (entry) => onListItem(item.id, entry.id)
          " /></template></div
  ></template>
</template>

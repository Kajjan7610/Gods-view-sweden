<script setup>
import { computed, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { t } from '../../../i18n/index.js';
import RailPanel from '../../rail/RailPanel.vue';
import { usePowerDayStore } from '../../stores/powerDay.js';

// Sweden's power day (or week) on the right rail while the power grid layer
// is on: the production stacked by type with the consumption over it, and the
// exchange below, per quarter-hour. The layer presents it (src/layers/
// powerGrid/dayPanel.js); pointing at the chart reads one quarter-hour.
const store = usePowerDayStore();
const { view: d } = storeToRefs(store);
const hover = ref(null);
// A new chart drops the quarter-hour the pointer last read.
watch(
  () => d.value?.chart,
  () => (hover.value = null),
);

function onPointer(event) {
  const chart = d.value?.chart;
  if (!chart?.points.length) return;
  const box = event.currentTarget.getBoundingClientRect();
  const x = ((event.clientX - box.left) / box.width) * chart.width;
  let nearest = chart.points[0];
  for (const point of chart.points)
    if (Math.abs(point.x - x) < Math.abs(nearest.x - x)) nearest = point;
  hover.value = nearest;
}

const readout = computed(() =>
  d.value ? (hover.value ? d.value.readout(hover.value) : d.value.latest) : null,
);
</script>

<template>
  <RailPanel id="power-panel" :hidden="!d" start-collapsed :title="t('POWER')" sideways rail-scroller>
    <div id="power-panel-body" class="power-day ui-scroll" data-rail-scroller>
      <template v-if="d">
        <div class="power-day-choices" role="group" :aria-label="t('Time span')">
          <button
            v-for="choice in d.spans"
            :key="choice.id"
            type="button"
            :class="['power-day-choice', { active: choice.id === d.span }]"
            :aria-pressed="String(choice.id === d.span)"
            @click="store.act('show', choice.id)"
          >{{ choice.label }}</button>
        </div>
        <p v-if="!d.chart" class="power-day-note">{{ d.failed ? t('Power day unavailable') : t('Loading…') }}</p>
        <template v-else>
          <small class="power-day-caption">{{ t('Production by type and consumption') }}</small>
          <svg
            class="power-day-chart"
            :viewBox="`0 0 ${d.chart.width} ${d.chart.height}`"
            role="img"
            :aria-label="d.summary"
            @pointermove="onPointer"
            @pointerdown="onPointer"
            @pointerleave="hover = null"
          >
            <line v-for="tick in d.yLabels" :key="`g${tick.y}`" class="power-day-grid" :x1="d.chart.plotLeft" :x2="d.chart.plotRight" :y1="tick.y" :y2="tick.y" />
            <line v-for="tick in d.dayLines" :key="`d${tick.at}`" class="power-day-grid" :x1="tick.x" :x2="tick.x" y1="0" :y2="d.chart.height" />
            <text v-for="tick in d.yLabels" :key="`t${tick.y}`" class="power-day-axis" :x="d.chart.plotLeft - 3" :y="tick.y + 3" text-anchor="end">{{ tick.text }}</text>
            <path v-for="area in d.chart.areas" :key="area.id" :d="area.d" :fill="area.color" fill-opacity="0.78" />
            <path :d="d.chart.consumption" fill="none" :stroke="d.colors.consumption" stroke-width="1.5" />
            <line v-if="hover" class="power-day-cursor" :x1="hover.x" :x2="hover.x" y1="0" :y2="d.chart.height" />
          </svg>
          <small class="power-day-caption">{{ t('Exchange: export up, import down') }} · {{ d.netLabel }}</small>
          <svg
            class="power-day-chart"
            :viewBox="`0 0 ${d.chart.width} ${d.chart.netHeight + 12}`"
            role="img"
            :aria-label="d.exchange"
            @pointermove="onPointer"
            @pointerdown="onPointer"
            @pointerleave="hover = null"
          >
            <line class="power-day-grid" :x1="d.chart.plotLeft" :x2="d.chart.plotRight" :y1="d.chart.net.zeroY" :y2="d.chart.net.zeroY" />
            <line v-for="tick in d.dayLines" :key="`d${tick.at}`" class="power-day-grid" :x1="tick.x" :x2="tick.x" y1="0" :y2="d.chart.netHeight" />
            <path :d="d.chart.net.exported" :fill="d.colors.export" fill-opacity="0.8" />
            <path :d="d.chart.net.imported" :fill="d.colors.import" fill-opacity="0.8" />
            <text v-for="label in d.xLabels" :key="`x${label.x}`" class="power-day-axis" :x="label.x" :y="d.chart.netHeight + 10" text-anchor="middle">{{ label.text }}</text>
            <line v-if="hover" class="power-day-cursor" :x1="hover.x" :x2="hover.x" y1="0" :y2="d.chart.netHeight" />
          </svg>
          <div v-if="readout" class="power-day-readout" aria-live="polite">
            <strong>{{ readout.time }}</strong>
            <span v-for="line in readout.lines" :key="line.label"
              ><i v-if="line.color" :style="{ background: line.color }"></i>{{ line.label }} {{ line.value }}</span
            >
          </div>
          <p class="power-day-summary">{{ d.summary }}<br />{{ d.exchange }}</p>
          <p v-if="d.note" class="power-day-note power-day-caption">{{ d.note }}</p>
          <ul class="power-day-legend">
            <li v-for="item in d.legend" :key="item.id"><i :style="{ background: item.color }"></i>{{ item.label }}</li>
          </ul>
          <small class="power-day-source">{{ d.source }}</small>
        </template>
      </template>
    </div>
  </RailPanel>
</template>

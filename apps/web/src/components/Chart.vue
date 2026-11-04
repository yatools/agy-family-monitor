<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import { init, use, type EChartsType, type EChartsCoreOption } from 'echarts/core';
import { LineChart, PieChart } from 'echarts/charts';
import {
  GridComponent,
  TooltipComponent,
  LegendComponent,
  AriaComponent,
  GraphicComponent,
} from 'echarts/components';
import { CanvasRenderer } from 'echarts/renderers';
use([
  LineChart,
  PieChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  AriaComponent,
  GraphicComponent,
  CanvasRenderer,
]);
const props = defineProps<{ option: EChartsCoreOption; label: string }>();
const element = ref<HTMLDivElement>();
let chart: EChartsType | undefined;
let observer: ResizeObserver | undefined;
onMounted(() => {
  if (element.value) {
    chart = init(element.value);
    chart.setOption(props.option);
    observer = new ResizeObserver(() => chart?.resize());
    observer.observe(element.value);
  }
});
watch(
  () => props.option,
  (option) => chart?.setOption(option, { notMerge: true }),
  { deep: true },
);
onBeforeUnmount(() => {
  observer?.disconnect();
  chart?.dispose();
});
</script>
<template><div ref="element" class="chart" role="img" :aria-label="label" /></template>
<style scoped>
.chart {
  width: 100%;
  height: 290px;
  min-width: 0;
}
</style>

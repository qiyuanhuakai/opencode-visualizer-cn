<template>
  <div ref="containerRef" class="hex-renderer-root" @scroll="onScroll">
    <div :style="{ height: topPadding + 'px' }" />
    
    <CodeContent
      v-for="row in visibleRows"
      :key="row.index"
      :html="row.html"
      variant="binary"
      class="hex-row"
    />
    
    <div :style="{ height: bottomPadding + 'px' }" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { hexdump } from '@kikuchan/hexdump';
import CodeContent from '../CodeContent.vue';

const props = defineProps<{
  bytes?: Uint8Array;
}>();

const BYTES_PER_ROW = 16;
const ROW_HEIGHT = 20;
const OVERSCAN_ROWS = 8;

const containerRef = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const containerHeight = ref(600);

const totalRows = computed(() => {
  if (!props.bytes || props.bytes.length === 0) return 0;
  return Math.ceil(props.bytes.length / BYTES_PER_ROW);
});

const startRow = computed(() => {
  if (totalRows.value === 0) return 0;
  return Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN_ROWS);
});

const endRow = computed(() => {
  if (totalRows.value === 0) return 0;
  const visibleCount = Math.ceil(containerHeight.value / ROW_HEIGHT);
  return Math.min(totalRows.value, startRow.value + visibleCount + OVERSCAN_ROWS * 2);
});

const visibleRows = computed(() => {
  if (!props.bytes || props.bytes.length === 0) return [];

  const rows = [];
  for (let i = startRow.value; i < endRow.value; i++) {
    const byteOffset = i * BYTES_PER_ROW;
    const rowBytes = props.bytes.slice(byteOffset, byteOffset + BYTES_PER_ROW);
    const html = hexdump(rowBytes, { color: 'html' });
    rows.push({
      index: i,
      html,
    });
  }
  return rows;
});

const topPadding = computed(() => startRow.value * ROW_HEIGHT);

const bottomPadding = computed(() => {
  const remainingRows = totalRows.value - endRow.value;
  return Math.max(0, remainingRows * ROW_HEIGHT);
});

function onScroll(e: Event) {
  scrollTop.value = (e.target as HTMLElement).scrollTop;
}

function updateContainerHeight() {
  if (containerRef.value) {
    containerHeight.value = containerRef.value.clientHeight;
  }
}

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  updateContainerHeight();
  resizeObserver = new ResizeObserver(() => updateContainerHeight());
  if (containerRef.value) {
    resizeObserver.observe(containerRef.value);
  }
});

onUnmounted(() => {
  if (resizeObserver) {
    resizeObserver.disconnect();
  }
});
</script>

<style scoped>
.hex-renderer-root {
  height: 100%;
  overflow: auto;
  background: var(--floating-surface, #1a1d24);
}

.hex-row {
  height: 20px;
  display: flex;
  align-items: center;
  white-space: pre;
  padding: 0 12px;
  box-sizing: border-box;
  font-family: var(--term-font-family, 'JetBrains Mono', 'Fira Code', monospace);
  font-size: 13px;
  line-height: 20px;
  color: var(--floating-text, #e2e8f0);
}

.hex-row :deep(.hexdump-address) {
  color: var(--floating-text-soft, #8a8f9a);
  width: 80px;
  flex-shrink: 0;
  user-select: none;
}

.hex-row :deep(.hexdump-separator) {
  color: var(--floating-text-soft, #8a8f9a);
}

.hex-row :deep(.hexdump-ascii) {
  color: var(--floating-text-secondary, #cbd5e1);
}

.hex-row :deep(.hexdump-null) {
  color: var(--theme-status-danger, #f87171);
}

.hex-row :deep(.hexdump-control) {
  color: var(--theme-status-warning, #fbbf24);
}
</style>

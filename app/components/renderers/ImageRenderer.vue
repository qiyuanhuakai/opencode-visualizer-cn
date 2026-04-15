<template>
  <div
    class="image-viewer-root"
    :class="{ 'is-dragging': isDragging }"
    @wheel.prevent="handleWheel"
    @dblclick.prevent="resetView"
    @pointerdown="handlePointerDown"
    @pointermove="handlePointerMove"
    @pointerup="handlePointerUp"
    @pointercancel="handlePointerUp"
  >
    <div class="image-wrapper" :style="wrapperStyle">
      <img
        :src="src"
        :alt="alt"
        class="image-content"
        draggable="false"
        @error="handleError"
        @load="handleLoad"
      />
    </div>
    <div v-if="error" class="error-message">{{ t('imageViewer.failedToLoad') }}</div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';

const { t } = useI18n();

defineProps<{
  src: string;
  alt?: string;
}>();

const scale = ref(1);
const translateX = ref(0);
const translateY = ref(0);
const isDragging = ref(false);
const error = ref(false);

const startX = ref(0);
const startY = ref(0);
const lastX = ref(0);
const lastY = ref(0);

const MIN_SCALE = 0.1;
const MAX_SCALE = 10;

const wrapperStyle = computed(() => ({
  transform: `translate(${translateX.value}px, ${translateY.value}px) scale(${scale.value})`,
}));

function handleWheel(e: WheelEvent) {
  const delta = -Math.sign(e.deltaY) * 0.1;
  const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, scale.value + delta * scale.value));

  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const cx = rect.width / 2;
  const cy = rect.height / 2;
  const dx = x - cx;
  const dy = y - cy;

  translateX.value = dx - (dx - translateX.value) * (newScale / scale.value);
  translateY.value = dy - (dy - translateY.value) * (newScale / scale.value);
  scale.value = newScale;
}

function handlePointerDown(e: PointerEvent) {
  isDragging.value = true;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  startX.value = e.clientX;
  startY.value = e.clientY;
  lastX.value = translateX.value;
  lastY.value = translateY.value;
}

function handlePointerMove(e: PointerEvent) {
  if (!isDragging.value) return;
  const dx = e.clientX - startX.value;
  const dy = e.clientY - startY.value;
  translateX.value = lastX.value + dx;
  translateY.value = lastY.value + dy;
}

function handlePointerUp(e: PointerEvent) {
  isDragging.value = false;
  (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
}

function resetView() {
  scale.value = 1;
  translateX.value = 0;
  translateY.value = 0;
}

function handleError() {
  error.value = true;
}

function handleLoad() {
  error.value = false;
}
</script>

<style scoped>
.image-viewer-root {
  width: 100%;
  height: 100%;
  overflow: hidden;
  position: relative;
  background: var(--floating-surface-subtle, var(--theme-surface-panel, #0f172a));
  cursor: grab;
  display: flex;
  align-items: center;
  justify-content: center;
  user-select: none;
}

.image-viewer-root.is-dragging {
  cursor: grabbing;
}

.image-wrapper {
  transform-origin: 50% 50%;
  will-change: transform;
  display: flex;
  align-items: center;
  justify-content: center;
}

.image-content {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  pointer-events: none;
  user-select: none;
}

.error-message {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: var(--theme-status-danger, #f87171);
  background: color-mix(in srgb, var(--floating-surface-strong, rgba(0, 0, 0, 0.7)) 92%, transparent);
  padding: 8px 16px;
  border-radius: 4px;
}
</style>

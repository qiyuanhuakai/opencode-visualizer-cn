<script setup lang="ts">
import { ref, computed, provide, watch, onBeforeUnmount } from 'vue';
import CodeContent from './CodeContent.vue';
import { FLOATING_WINDOW_KEY, type FloatingWindowAPI } from '../composables/useFloatingWindow';
import type { FloatingWindowEntry, useFloatingWindows } from '../composables/useFloatingWindows';
import { useAutoScroller, type ScrollMode } from '../composables/useAutoScroller';
import { Icon } from '@iconify/vue';

const props = defineProps<{
  entry: FloatingWindowEntry;
  manager: ReturnType<typeof useFloatingWindows>;
}>();

const emit = defineEmits<{
  focus: [key: string];
  close: [key: string];
}>();

const windowEl = ref<HTMLElement>();
const bodyEl = ref<HTMLElement>();

const scrollMode = computed<ScrollMode>(() => props.entry.scroll || 'manual');
const { showResumeButton, isFollowing, resumeFollow, notifyContentChange } = useAutoScroller(
  bodyEl,
  scrollMode,
);

function handleResumeFollowClick() {
  resumeFollow();
}

let pendingScrollTop: number | null = null;
let shouldRestoreScrollTop = false;

function shouldPreserveScrollPosition() {
  if (scrollMode.value === 'manual' || scrollMode.value === 'none') return true;
  return scrollMode.value === 'follow' && !isFollowing.value;
}

watch(
  () => props.entry.resolvedHtml,
  () => {
    const el = bodyEl.value;
    if (!el) {
      pendingScrollTop = null;
      shouldRestoreScrollTop = false;
      return;
    }
    shouldRestoreScrollTop = shouldPreserveScrollPosition();
    pendingScrollTop = shouldRestoreScrollTop ? el.scrollTop : null;
  },
  { flush: 'pre' },
);

watch(
  () => props.entry.resolvedHtml,
  () => {
    const el = bodyEl.value;
    if (!el) return;
    if (shouldRestoreScrollTop && pendingScrollTop !== null) {
      el.scrollTop = pendingScrollTop;
    }
    pendingScrollTop = null;
    shouldRestoreScrollTop = false;
    notifyContentChange();
  },
  { flush: 'post' },
);

const api: FloatingWindowAPI = {
  key: props.entry.key,
  content: computed(() => props.entry.content ?? ''),
  html: computed(() => props.entry.resolvedHtml),
  title: computed(() => props.entry.title || ''),
  status: computed(() => props.entry.status || ''),
  notifyContentChange: (smooth?: boolean) => {
    notifyContentChange(smooth);
  },
  setContent: (text: string) => {
    props.manager.setContent(props.entry.key, text);
  },
  appendContent: (text: string) => {
    props.manager.appendContent(props.entry.key, text);
  },
  setTitle: (title: string) => {
    props.entry.title = title;
  },
  setStatus: (status: string) => {
    props.entry.status = status as 'running' | 'completed' | 'error';
  },
  setColor: (color: string) => {
    props.entry.color = color;
  },
  bringToFront: () => {
    emit('focus', props.entry.key);
  },
  close: () => {
    emit('close', props.entry.key);
  },
  onResize: (callback: (w: number, h: number) => void) => {
    // Store callback for resize events
  },
};

provide(FLOATING_WINDOW_KEY, api);

const windowStyle = computed(() => {
  const color = props.entry.color || '#3a4150';
  return {
    '--win-x': `${props.entry.x}px`,
    '--win-y': `${props.entry.y}px`,
    width: props.entry.width ? `${props.entry.width}px` : '600px',
    height: props.entry.height ? `${props.entry.height}px` : '400px',
    zIndex: props.entry.zIndex,
    '--window-color': color,
  };
});

const scrollClass = computed(() => {
  return {
    'scroll-none': props.entry.scroll === 'none' || props.entry.scroll === 'force',
  };
});

function onFocus() {
  emit('focus', props.entry.key);
}

function onClose() {
  emit('close', props.entry.key);
}

// Drag handling — direct DOM manipulation to avoid triggering Vue restyle
// During drag, we bypass Vue reactivity entirely and sync back on drag end.
let lastPointerX = 0;
let lastPointerY = 0;
let snapAnimId: number | null = null;

// Non-reactive drag position (avoids Vue overhead during drag)
let dragX = 0;
let dragY = 0;
let dragTarget: HTMLElement | null = null;
let dragPointerId = -1;

function applyTransform(x: number, y: number) {
  const el = windowEl.value;
  if (!el) return;
  el.style.setProperty('--win-x', `${x}px`);
  el.style.setProperty('--win-y', `${y}px`);
}

function cancelSnapAnimation() {
  if (snapAnimId !== null) {
    cancelAnimationFrame(snapAnimId);
    snapAnimId = null;
  }
}

function getDragBounds() {
  const extent = props.manager.getExtent();
  const w = props.entry.width || 600;
  const h = props.entry.height || 400;
  return { minX: 0, maxX: extent.width - w, minY: 0, maxY: extent.height - h, w, h, extent };
}

function onDragStart(e: PointerEvent) {
  if ((e.target as HTMLElement).closest('.close-btn')) return;
  e.preventDefault();
  cancelSnapAnimation();

  dragTarget = e.currentTarget as HTMLElement;
  dragTarget.setPointerCapture(e.pointerId);
  dragPointerId = e.pointerId;

  lastPointerX = e.clientX;
  lastPointerY = e.clientY;
  dragX = props.entry.x;
  dragY = props.entry.y;

  dragTarget.addEventListener('pointermove', onDragMove);
  dragTarget.addEventListener('pointerup', onDragEnd);
}

function onDragMove(e: PointerEvent) {
  const dx = e.clientX - lastPointerX;
  const dy = e.clientY - lastPointerY;
  lastPointerX = e.clientX;
  lastPointerY = e.clientY;
  const { minX, maxX, minY, maxY } = getDragBounds();
  dragX += dx * (dragX < minX || dragX > maxX ? 0.5 : 1);
  dragY += dy * (dragY < minY || dragY > maxY ? 0.5 : 1);

  // Direct DOM update — bypasses Vue reactivity and restyle cascade
  applyTransform(dragX, dragY);
}

function cleanupDrag() {
  if (dragTarget) {
    dragTarget.removeEventListener('pointermove', onDragMove);
    dragTarget.removeEventListener('pointerup', onDragEnd);
    if (dragPointerId >= 0) {
      dragTarget.releasePointerCapture(dragPointerId);
    }
    dragTarget = null;
    dragPointerId = -1;
  }
}

function onDragEnd() {
  cleanupDrag();
  // Sync final position to Vue reactive state (single restyle)
  props.entry.x = dragX;
  props.entry.y = dragY;
  snapBack();
}

function snapBack() {
  const { minX, maxX, minY, maxY, w, h, extent } = getDragBounds();
  const x = dragX;
  const y = dragY;
  if (x >= minX && x <= maxX && y >= minY && y <= maxY) return;

  const cx = extent.width / 2 - w / 2;
  const cy = extent.height / 2 - h / 2;
  const dx = cx - x;
  const dy = cy - y;
  const validX = maxX >= minX;
  const validY = maxY >= minY;

  let t = 1;
  const candidates: number[] = [];
  if (validX && dx !== 0) {
    if (x < minX) candidates.push((minX - x) / dx);
    if (x > maxX) candidates.push((maxX - x) / dx);
  }
  if (validY && dy !== 0) {
    if (y < minY) candidates.push((minY - y) / dy);
    if (y > maxY) candidates.push((maxY - y) / dy);
  }
  if (candidates.length > 0) {
    const tc = Math.min(Math.max(...candidates), 1);
    const tx = x + tc * dx;
    const ty = y + tc * dy;
    if ((!validX || (tx >= minX && tx <= maxX)) && (!validY || (ty >= minY && ty <= maxY))) {
      t = tc;
    }
  }

  const finalX = x + t * dx;
  const finalY = y + t * dy;
  const startX = x;
  const startY = y;
  const startTime = performance.now();
  const duration = 150;

  function frame(now: number) {
    const progress = Math.min((now - startTime) / duration, 1);
    const ease = 1 - (1 - progress) * (1 - progress) * (1 - progress);
    dragX = startX + (finalX - startX) * ease;
    dragY = startY + (finalY - startY) * ease;
    applyTransform(dragX, dragY);
    if (progress < 1) {
      snapAnimId = requestAnimationFrame(frame);
    } else {
      // Sync final position to Vue reactive state
      props.entry.x = dragX;
      props.entry.y = dragY;
      snapAnimId = null;
    }
  }

  snapAnimId = requestAnimationFrame(frame);
}

onBeforeUnmount(() => {
  cancelSnapAnimation();
  cleanupDrag();
});

watch(() => props.entry, () => {
  if (dragTarget) {
    applyTransform(dragX, dragY);
  }
}, { deep: true, flush: 'post' });

// Resize handling
let resizeStartX = 0;
let resizeStartY = 0;
let windowStartWidth = 0;
let windowStartHeight = 0;

function onResizeStart(e: PointerEvent) {
  e.stopPropagation();
  resizeStartX = e.clientX;
  resizeStartY = e.clientY;
  windowStartWidth = props.entry.width || 600;
  windowStartHeight = props.entry.height || 400;
  
  const target = e.target as HTMLElement;
  target.setPointerCapture(e.pointerId);
  target.addEventListener('pointermove', onResizeMove);
  target.addEventListener('pointerup', onResizeEnd);
}

function onResizeMove(e: PointerEvent) {
  const dx = e.clientX - resizeStartX;
  const dy = e.clientY - resizeStartY;
  props.entry.width = Math.max(200, windowStartWidth + dx);
  props.entry.height = Math.max(150, windowStartHeight + dy);
}

function onResizeEnd(e: PointerEvent) {
  const target = e.target as HTMLElement;
  target.removeEventListener('pointermove', onResizeMove);
  target.removeEventListener('pointerup', onResizeEnd);
  target.releasePointerCapture(e.pointerId);
  
  if (props.entry.onResize) {
    props.entry.onResize(props.entry.width || 600, props.entry.height || 400);
  }
}
</script>

<template>
  <div 
    ref="windowEl"
    class="floating-window" 
    :style="windowStyle" 
    @pointerdown.capture="onFocus"
    :data-floating-key="entry.key"
  >
    <div class="floating-window-titlebar" @pointerdown="onDragStart">
      <span class="title">{{ entry.title || 'Tool' }}</span>
      <button 
        v-if="entry.closable" 
        class="close-btn"
        @click.stop="onClose"
      >×</button>
    </div>
    <div class="floating-window-body-wrapper">
      <div 
        class="floating-window-body" 
        :class="scrollClass"
        ref="bodyEl"
      >
        <template v-if="entry.component">
          <component 
            :is="entry.component" 
            v-bind="entry.props || {}"
          />
        </template>
        <CodeContent v-else :html="entry.resolvedHtml || (typeof entry.content === 'string' ? entry.content : '')" :variant="entry.variant" />
      </div>
      <Transition name="fade">
        <button
          v-if="showResumeButton"
          class="follow-resume-btn"
          @click.stop="handleResumeFollowClick"
        ><Icon icon="lucide:arrow-down" :width="14" :height="14" /></button>
      </Transition>
    </div>
    <div 
      v-if="entry.resizable" 
      class="floating-window-resizer" 
      @pointerdown="onResizeStart"
    />
  </div>
</template>

<style scoped>
.floating-window {
  --win-x: 0px;
  --win-y: 0px;
  --win-scale-x: 1;
  --win-scale-y: 1;
  position: absolute;
  left: 0;
  top: 0;
  transform: translate3d(var(--win-x), var(--win-y), 0) scale(var(--win-scale-x), var(--win-scale-y));
  will-change: transform;
  contain: layout paint;
  display: flex;
  flex-direction: column;
  background: color-mix(in srgb, var(--window-color, #3a4150) 12%, #1a1d24);
  border: 1px solid var(--window-color, #3a4150);
  border-radius: 5px;
  overflow: hidden;
  font-family: var(--term-font-family, monospace);
  font-size: var(--term-font-size, 14px);
  line-height: var(--term-line-height, 1.5);
  color: #e2e8f0;
  pointer-events: auto;
}

.floating-window-titlebar {
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 4px;
  font-size: 12px;
  color: color-mix(in srgb, var(--window-color, #3a4150) 40%, #e2e8f0);
  background: color-mix(in srgb, var(--window-color, #3a4150) 22%, rgba(36, 40, 50, 0.95));
  border-bottom: 1px solid color-mix(in srgb, var(--window-color, #3a4150) 35%, rgba(90, 100, 120, 0.35));
  cursor: grab;
  user-select: none;
}

.floating-window-titlebar:active {
  cursor: grabbing;
}

.floating-window-titlebar .title {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.close-btn {
  background: transparent;
  border: none;
  color: inherit;
  font-size: 16px;
  cursor: pointer;
  padding: 0 4px;
  line-height: 1;
}

.close-btn:hover {
  opacity: 0.8;
}

.floating-window-body-wrapper {
  flex: 1;
  position: relative;
  overflow: hidden;
  min-height: 0;
}

.floating-window-body {
  height: 100%;
  overflow: auto;
  padding: 2px 4px;
}

.floating-window-body.scroll-none {
  overflow: hidden;
}

.follow-resume-btn {
  position: absolute;
  bottom: 6px;
  right: 14px;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.15);
  background: rgba(30, 34, 42, 0.85);
  color: #94a3b8;
  font-size: 13px;
  line-height: 1;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1;
  transition: background 0.15s, color 0.15s;
}

.follow-resume-btn:hover {
  background: rgba(50, 58, 72, 0.95);
  color: #e2e8f0;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.15s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.floating-window-resizer {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 14px;
  height: 14px;
  cursor: se-resize;
  background: transparent;
}

.floating-window-resizer::before {
  content: '';
  position: absolute;
  right: 1px;
  bottom: 1px;
  width: 0;
  height: 0;
  border-style: solid;
  border-width: 0 0 5px 5px;
  border-color: transparent transparent var(--window-color, #3a4150) transparent;
}

.floating-window-resizer:hover::before {
  filter: brightness(1.15);
}
</style>

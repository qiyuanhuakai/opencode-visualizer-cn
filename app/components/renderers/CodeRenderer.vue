<template>
  <div ref="rootEl" class="code-renderer-content">
    <div ref="viewerBodyEl" class="viewer-body" @mousedown="onMouseDown" @scroll="onScroll">
      <div v-if="streamError" class="stream-error">{{ streamError }}</div>
      <div v-if="showLoading" class="viewer-loading">{{ t('common.loading') }}</div>
      <div v-else-if="props.streaming && streamingRenderParams && !streamDone" ref="streamContainerRef" class="code-scroll-content" />
      <div v-else-if="useVirtualScroll" class="code-scroll-content virtual-scroll">
        <div :style="{ height: topPadding + 'px' }" />
        <CodeContent
          v-for="row in visibleRows"
          :key="`${startRow}-${row.key}`"
          :html="row.html"
          :variant="viewerVariant"
          class="virtual-row"
        />
        <div :style="{ height: bottomPadding + 'px' }" />
      </div>
      <div v-else class="code-scroll-content">
        <CodeContent :html="nonVirtualHtml" :variant="viewerVariant" />
      </div>
    </div>
    <LineCommentOverlay
      v-if="showOverlay"
      :editing-line="editingLine"
      :selected-range="selectedRange"
      :row-rects="rowRects"
      :container-width="containerWidth"
      @cancel="onOverlayCancel"
      @submit="onOverlaySubmit"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSettings } from '../../composables/useSettings';
import CodeContent from '../CodeContent.vue';
import LineCommentOverlay from '../LineCommentOverlay.vue';
import { type CodeRenderParams, useCodeRender } from '../../utils/useCodeRender';
import { type StreamCodeRenderParams, useStreamCodeRender } from '../../utils/useStreamCodeRender';
import { DEFAULT_SYNTAX_THEME } from '../../utils/themeTokens';
import {
  buildAbsoluteRowRects,
  calculateVirtualRowWindow,
  findLineAtY,
  shouldVirtualizeCodeRows,
  type CodeRowRect,
} from '../../utils/virtualCodeRows';

const { t } = useI18n();
const { appFontSizePx, floatingPreviewWordWrap } = useSettings();

const props = withDefaults(
  defineProps<{
    path?: string;
    absolutePath?: string;
    rawHtml?: string;
    fileContent?: string;
    lang?: string;
    gutterMode?: 'default' | 'none' | 'grep-source';
    theme?: string;
    lines?: string;
    streaming?: boolean;
    onRequestAddLineComment?: (payload: { path: string; startLine: number; endLine: number; text: string }) => void;
  }>(),
  { streaming: false },
);

const emit = defineEmits<{
  (event: 'rendered'): void;
}>();

const DRAG_THRESHOLD_PX = 4;

const rootEl = ref<HTMLDivElement | null>(null);
const viewerBodyEl = ref<HTMLDivElement | null>(null);
const anchorLine = ref<number | null>(null);
const selectedEndLine = ref<number | null>(null);
const isSelecting = ref(false);
const editingLine = ref<number | null>(null);
const rowRects = ref<Map<number, CodeRowRect>>(new Map());
const dragStartX = ref(0);
const dragStartY = ref(0);

const selectedRange = computed<{ start: number; end: number } | null>(() => {
  if (anchorLine.value == null || selectedEndLine.value == null) return null;
  const start = Math.min(anchorLine.value, selectedEndLine.value);
  const end = Math.max(anchorLine.value, selectedEndLine.value);
  return { start, end };
});

const viewerGutterMode = computed<'none' | 'single'>(() => {
  if (props.gutterMode === 'none') return 'none';
  return 'single';
});

const viewerVariant = computed<'code' | 'binary' | 'plain'>(() => {
  if (props.rawHtml && !props.fileContent) return 'binary';
  if (props.gutterMode === 'none') return 'plain';
  return 'code';
});

const showOverlay = computed(
  () => !!props.path && viewerVariant.value !== 'binary' && !!props.onRequestAddLineComment,
);

const containerWidth = computed(() => rootEl.value?.clientWidth ?? 0);

const renderParams = computed<CodeRenderParams | null>(() => {
  if (props.rawHtml && !props.fileContent) return null;
  const code = props.fileContent ?? '';
  if (!code && !props.rawHtml) return null;
  if (!code) return null;
  return {
    code,
    lang: props.lang ?? 'text',
    theme: props.theme ?? DEFAULT_SYNTAX_THEME,
    gutterMode: viewerGutterMode.value,
  };
});

const streamingRenderParams = computed<StreamCodeRenderParams | null>(() => {
  if (!props.streaming) return null;
  if (props.rawHtml && !props.fileContent) return null;
  const code = props.fileContent ?? '';
  if (!code) return null;
  return {
    code,
    lang: props.lang ?? 'text',
    theme: props.theme ?? DEFAULT_SYNTAX_THEME,
    gutterMode: viewerGutterMode.value,
  };
});

const { html: renderedHtml } = useCodeRender(
  computed(() => (props.streaming ? null : renderParams.value)),
);

const streamContainerRef = ref<HTMLElement | null>(null);
const {
  containerRef: streamContainer,
  html: streamRenderedHtml,
  done: streamDone,
  error: streamError,
} = useStreamCodeRender(streamingRenderParams);

watch(streamContainerRef, (el) => {
  streamContainer.value = el;
});

const effectiveHtml = computed(() =>
  props.streaming ? streamRenderedHtml.value : renderedHtml.value,
);

// Virtual scroll state
const VIRTUAL_SCROLL_THRESHOLD = 500;
const DEFAULT_ROW_HEIGHT = 20;
const OVERSCAN_ROWS = 10;
const scrollTop = ref(0);
const containerHeight = ref(600);
const rowHeight = ref(DEFAULT_ROW_HEIGHT);

function extractCodeRows(html: string) {
  const matches = html.match(/<div class="code-row[^"]*">[\s\S]*?<\/div>/g);
  if (!matches) return [];
  return matches.map((rowHtml, index) => ({
    key: `rendered-${index}`,
    html: rowHtml,
  }));
}

const allRows = computed(() => {
  const html = effectiveHtml.value || props.rawHtml || '';
  if (!html) return [];
  return extractCodeRows(html);
});

const nonVirtualHtml = computed(() => effectiveHtml.value || props.rawHtml || '');

const wrapsCode = computed(
  () => viewerVariant.value === 'code' && floatingPreviewWordWrap.value,
);
const useVirtualScroll = computed(() =>
  shouldVirtualizeCodeRows(allRows.value.length, VIRTUAL_SCROLL_THRESHOLD, wrapsCode.value),
);

const totalRows = computed(() => allRows.value.length);

const startRow = computed(() => {
  if (!useVirtualScroll.value) return 0;
  return calculateVirtualRowWindow({
    totalRows: totalRows.value,
    scrollTop: scrollTop.value,
    containerHeight: containerHeight.value,
    rowHeight: rowHeight.value,
    overscanRows: OVERSCAN_ROWS,
  }).start;
});

const endRow = computed(() => {
  if (!useVirtualScroll.value) return totalRows.value;
  return calculateVirtualRowWindow({
    totalRows: totalRows.value,
    scrollTop: scrollTop.value,
    containerHeight: containerHeight.value,
    rowHeight: rowHeight.value,
    overscanRows: OVERSCAN_ROWS,
  }).end;
});

const visibleRows = computed(() => {
  if (!useVirtualScroll.value) return allRows.value;
  return allRows.value.slice(startRow.value, endRow.value);
});

const topPadding = computed(() => startRow.value * rowHeight.value);

const bottomPadding = computed(() => {
  const remainingRows = totalRows.value - endRow.value;
  return Math.max(0, remainingRows * rowHeight.value);
});

function getScrollContentEl(): HTMLElement | null {
  return viewerBodyEl.value?.querySelector('.code-scroll-content') ?? null;
}

function updateRowRects() {
  const root = rootEl.value;
  const scrollContent = getScrollContentEl();
  if (!root || !scrollContent) {
    rowRects.value = new Map();
    return;
  }
  const containerRect = root.getBoundingClientRect();
  const rows = Array.from(scrollContent.querySelectorAll<HTMLElement>('.code-row'));
  if (useVirtualScroll.value) {
    const measuredHeight = rows[0]?.getBoundingClientRect().height;
    if (measuredHeight && Math.abs(measuredHeight - rowHeight.value) > 0.5) {
      rowHeight.value = measuredHeight;
      void nextTick(updateRowRects);
      return;
    }
  }
  const firstRenderedLine = useVirtualScroll.value ? startRow.value : 0;
  const visibleRowRects = rows.map((row) => {
    const rect = row.getBoundingClientRect();
    return {
      top: rect.top - containerRect.top,
      height: rect.height,
      right: rect.right - containerRect.left,
    };
  });
  rowRects.value = buildAbsoluteRowRects(firstRenderedLine, visibleRowRects);
}

function getLineFromMouse(e: MouseEvent): number | null {
  const root = rootEl.value;
  if (!root) return null;
  const containerRect = root.getBoundingClientRect();
  const y = e.clientY - containerRect.top;
  return findLineAtY(rowRects.value, y);
}

function isScrollbarClick(e: MouseEvent): boolean {
  const el = viewerBodyEl.value;
  if (!el || e.target !== el) return false;
  return e.offsetX > el.clientWidth || e.offsetY > el.clientHeight;
}

function onMouseDown(e: MouseEvent) {
  if (e.button !== 0) return;
  if (isScrollbarClick(e)) return;

  const target = e.target as HTMLElement;
  if (target.closest('.line-comment-overlay')) return;

  const line = getLineFromMouse(e);
  if (line == null) {
    if (editingLine.value != null) {
      onOverlayCancel();
    }
    return;
  }

  anchorLine.value = line;
  selectedEndLine.value = line;
  isSelecting.value = true;
  dragStartX.value = e.clientX;
  dragStartY.value = e.clientY;
  editingLine.value = null;

  document.addEventListener('mousemove', onDocMouseMove);
  document.addEventListener('mouseup', onDocMouseUp);
}

function onDocMouseMove(e: MouseEvent) {
  if (!isSelecting.value) return;
  const line = getLineFromMouse(e);
  if (line != null) {
    selectedEndLine.value = line;
  }
}

function onDocMouseUp(e: MouseEvent) {
  document.removeEventListener('mousemove', onDocMouseMove);
  document.removeEventListener('mouseup', onDocMouseUp);

  if (!isSelecting.value) return;
  isSelecting.value = false;

  const line = anchorLine.value;
  if (line == null) {
    anchorLine.value = null;
    selectedEndLine.value = null;
    return;
  }

  const dx = e.clientX - dragStartX.value;
  const dy = e.clientY - dragStartY.value;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const range = selectedRange.value;
  const didDrag = distance >= DRAG_THRESHOLD_PX || (range != null && range.start !== range.end);

  if (!didDrag) {
    anchorLine.value = null;
    selectedEndLine.value = null;
    return;
  }

  if (range && range.start !== range.end) {
    editingLine.value = range.end;
  } else {
    editingLine.value = line;
  }
}

function onOverlaySubmit(text: string) {
  const range = selectedRange.value;
  const line = editingLine.value ?? 0;
  const startLine = range ? range.start : line;
  const endLine = range ? range.end : line;
  props.onRequestAddLineComment?.({
    path: props.absolutePath || props.path || '',
    startLine: startLine + 1,
    endLine: endLine + 1,
    text,
  });
  editingLine.value = null;
  anchorLine.value = null;
  selectedEndLine.value = null;
}

function onOverlayCancel() {
  editingLine.value = null;
  anchorLine.value = null;
  selectedEndLine.value = null;
}

function clearLineHighlights() {
  const scrollContent = getScrollContentEl();
  if (!scrollContent) return;
  scrollContent.querySelectorAll('.code-row.line-highlight').forEach((row) => {
    row.classList.remove('line-highlight');
  });
}

function parseLineSpecs(raw?: string): Array<{ start: number; end: number }> {
  if (!raw) return [];
  const specs: Array<{ start: number; end: number }> = [];
  for (const part of raw.split(',')) {
    const m = part.match(/^(\d+)(?:-(\d+))?$/);
    if (!m) continue;
    const s = Number(m[1]);
    const e = m[2] != null ? Number(m[2]) : s;
    if (s >= 1 && e >= s) specs.push({ start: s, end: e });
  }
  return specs;
}

function applyLineSelection() {
  const scrollContent = getScrollContentEl();
  if (!scrollContent) return;
  clearLineHighlights();

  const specs = parseLineSpecs(props.lines);
  if (specs.length === 0) return;
  const rows = Array.from(scrollContent.querySelectorAll<HTMLElement>('.code-row'));
  if (rows.length === 0) return;
  const visibleStart = useVirtualScroll.value ? startRow.value + 1 : 1;
  const visibleEnd = visibleStart + rows.length - 1;
  for (const { start, end } of specs) {
    const clampedStart = Math.max(start, visibleStart);
    const clampedEnd = Math.min(end, visibleEnd);
    if (clampedStart > clampedEnd) continue;
    for (let index = clampedStart - visibleStart; index <= clampedEnd - visibleStart; index += 1) {
      rows[index]?.classList.add('line-highlight');
    }
  }

  const firstStart = specs[0]?.start;
  if (!firstStart) return;
  if (useVirtualScroll.value && viewerBodyEl.value) {
    viewerBodyEl.value.scrollTop = Math.max(
      0,
      (firstStart - 1) * rowHeight.value - viewerBodyEl.value.clientHeight / 2,
    );
    return;
  }
  rows[Math.min(firstStart, rows.length) - 1]?.scrollIntoView({ block: 'center', inline: 'nearest' });
}

watch(
  [
    () => renderedHtml.value,
    () => props.rawHtml,
    () => props.lines,
    () => streamRenderedHtml.value,
    () => streamDone.value,
    () => appFontSizePx.value,
    () => floatingPreviewWordWrap.value,
  ],
  () => {
    nextTick(() => {
      applyLineSelection();
      updateRowRects();
      emit('rendered');
    });
    setTimeout(() => {
      updateRowRects();
    }, 50);
  },
  { immediate: true },
);

function onWindowResize() {
  updateRowRects();
}

function onScroll() {
  if (useVirtualScroll.value && viewerBodyEl.value) {
    scrollTop.value = viewerBodyEl.value.scrollTop;
    void nextTick(updateRowRects);
    return;
  }
  updateRowRects();
}

let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  window.addEventListener('resize', onWindowResize);
  const root = viewerBodyEl.value;
  if (root) {
    resizeObserver = new ResizeObserver(() => {
      updateRowRects();
      if (useVirtualScroll.value) {
        containerHeight.value = root.clientHeight;
      }
    });
    resizeObserver.observe(root);
    if (useVirtualScroll.value) {
      containerHeight.value = root.clientHeight;
    }
  }
  updateRowRects();
  setTimeout(() => updateRowRects(), 50);
  setTimeout(() => updateRowRects(), 300);
});

onBeforeUnmount(() => {
  window.removeEventListener('resize', onWindowResize);
  document.removeEventListener('mousemove', onDocMouseMove);
  document.removeEventListener('mouseup', onDocMouseUp);
  if (resizeObserver) {
    resizeObserver.disconnect();
    resizeObserver = null;
  }
});

const showLoading = computed(() => {
  if (props.streaming) {
    if (streamDone.value || streamRenderedHtml.value) return false;
    if (streamingRenderParams.value) return false;
    if (props.rawHtml) return false;
    return props.fileContent == null;
  }
  if (renderedHtml.value || props.rawHtml) return false;
  if (renderParams.value) return true;
  if (props.fileContent == null) return true;
  return false;
});
</script>

<style scoped>
.code-renderer-content {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  position: relative;
}

.viewer-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.code-scroll-content {
  min-height: 100%;
}

.code-scroll-content.virtual-scroll {
  min-height: 0;
}

.virtual-row {
  min-height: v-bind('rowHeight + "px"');
  overflow: hidden;
}

.code-renderer-content :deep(.code-row.line-highlight) {
  background: rgba(148, 163, 184, 0.15);
}

.viewer-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--theme-text-muted, #64748b);
  font-size: var(--app-monospace-font-size, 13px);
  user-select: none;
}

.stream-error {
  padding: 8px 12px;
  color: var(--theme-danger-text, #fca5a5);
  font-size: var(--app-monospace-font-size, 13px);
  background: rgba(148, 163, 184, 0.15);
}
</style>

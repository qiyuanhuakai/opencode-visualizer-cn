<template>
  <div class="file-viewer" :style="style" @pointerdown.capture="onFocus">
    <div class="viewer-titlebar" @pointerdown="onDragStart">
      <span class="viewer-title">{{ title }}</span>
      <button
        type="button"
        class="viewer-close"
        aria-label="Close file viewer"
        @pointerdown.stop
        @click.stop="onClose"
      >
        ×
      </button>
    </div>
    <div v-if="entry.diffTabs && entry.diffTabs.length > 1" class="viewer-tabs">
      <button
        v-for="(tab, i) in entry.diffTabs"
        :key="tab.file"
        type="button"
        class="viewer-tab"
        :class="{ active: i === activeTabIndex }"
        @click="activeTabIndex = i"
      >
        {{ basename(tab.file) }}
      </button>
    </div>
    <div class="viewer-body" @scroll="onFloatingScroll" @wheel="onFloatingWheel">
      <div v-if="showLoading" class="viewer-loading">Loading…</div>
      <CodeContent
        v-else
        :html="renderedHtml || entry.html"
        :variant="entry.isDiff ? 'diff' : entry.isBinary ? 'binary' : 'code'"
        :gutter-mode="viewerGutterMode"
      />
    </div>
    <div class="viewer-resizer" @pointerdown="onResizeStart"></div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import CodeContent from './CodeContent.vue';
import { type CodeRenderParams, useCodeRender } from '../utils/useCodeRender';

type ViewerEntry = {
  x: number;
  y: number;
  zIndex?: number;
  width?: number;
  height?: number;
  path?: string;
  html: string;
  content?: string;
  isBinary?: boolean;
  isDiff?: boolean;
  isLoading?: boolean;
  diffCode?: string;
  diffAfter?: string;
  lang?: string;
  diffTabs?: Array<{ file: string; before: string; after: string }>;
  toolGutterMode?: 'default' | 'none' | 'grep-source';
};

const props = defineProps<{
  entry: ViewerEntry;
  title: string;
  onFocusEntry: (entry: ViewerEntry, event: PointerEvent) => void;
  onDragEntry: (entry: ViewerEntry, event: PointerEvent) => void;
  onResizeEntry: (entry: ViewerEntry, event: PointerEvent) => void;
  onFloatingScrollEntry: (entry: ViewerEntry, event: Event) => void;
  onFloatingWheelEntry: (entry: ViewerEntry, event: WheelEvent) => void;
  onCloseEntry: (entry: ViewerEntry) => void;
  theme: string;
}>();

const entry = computed(() => props.entry);

const activeTabIndex = ref(0);

const activeDiffCode = computed(() => {
  const tabs = props.entry.diffTabs;
  if (!tabs || tabs.length === 0) return props.entry.diffCode ?? '';
  return tabs[activeTabIndex.value]?.before ?? '';
});

const activeDiffAfter = computed(() => {
  const tabs = props.entry.diffTabs;
  if (!tabs || tabs.length === 0) return props.entry.diffAfter;
  return tabs[activeTabIndex.value]?.after;
});

const activeDiffLang = computed(() => {
  const tabs = props.entry.diffTabs;
  if (!tabs || tabs.length === 0) return props.entry.lang ?? 'text';
  const file = tabs[activeTabIndex.value]?.file ?? '';
  const ext = file.split('.').pop() ?? '';
  const langMap: Record<string, string> = {
    ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
    vue: 'vue', css: 'css', scss: 'scss', html: 'html',
    json: 'json', md: 'markdown', py: 'python', rs: 'rust',
    go: 'go', rb: 'ruby', java: 'java', c: 'c', cpp: 'cpp',
    sh: 'bash', yaml: 'yaml', yml: 'yaml', toml: 'toml',
  };
  return langMap[ext] ?? 'text';
});

const viewerGutterMode = computed<'none' | 'single' | 'double'>(() => {
  if (props.entry.isDiff) return 'double';
  if (props.entry.toolGutterMode === 'none') return 'none';
  return 'single';
});

const renderParams = computed<CodeRenderParams | null>(() => {
  const e = props.entry;
  if (e.isDiff) {
    const hasTabs = e.diffTabs && e.diffTabs.length > 0;
    return {
      code: activeDiffCode.value,
      after: activeDiffAfter.value,
      patch: hasTabs ? undefined : (e.content || undefined),
      lang: activeDiffLang.value,
      theme: props.theme,
      gutterMode: viewerGutterMode.value,
    };
  }
  if (e.isBinary && e.html) return null;
  const code = e.content ?? '';
  if (!code && !e.html) return null;
  if (!code) return null;
  return {
    code,
    lang: e.lang ?? 'text',
    theme: props.theme,
    gutterMode: viewerGutterMode.value,
  };
});

const { html: renderedHtml } = useCodeRender(renderParams);

const showLoading = computed(() => {
  return props.entry.isLoading && !renderedHtml.value && !props.entry.html;
});

function basename(filepath: string) {
  return filepath.split('/').pop() ?? filepath;
}

const style = computed(() => ({
  left: `${entry.value.x ?? 0}px`,
  top: `calc(var(--tool-top-offset) + ${entry.value.y ?? 0}px)`,
  '--term-width': entry.value.width ? `${entry.value.width}px` : undefined,
  '--term-height': entry.value.height ? `${entry.value.height}px` : undefined,
  zIndex: entry.value.zIndex ?? undefined,
}));

function onFocus(event: PointerEvent) {
  props.onFocusEntry(entry.value, event);
}

function onDragStart(event: PointerEvent) {
  props.onDragEntry(entry.value, event);
}

function onResizeStart(event: PointerEvent) {
  props.onResizeEntry(entry.value, event);
}

function onFloatingScroll(event: Event) {
  props.onFloatingScrollEntry(entry.value, event);
}

function onFloatingWheel(event: WheelEvent) {
  props.onFloatingWheelEntry(entry.value, event);
}

function onClose() {
  props.onCloseEntry(entry.value);
}
</script>

<style scoped>
.viewer-tabs {
  display: flex;
  gap: 0;
  background: rgba(26, 29, 36, 0.95);
  border-bottom: 1px solid rgba(90, 100, 120, 0.35);
  overflow-x: auto;
  scrollbar-width: none;
  flex-shrink: 0;
}

.viewer-tabs::-webkit-scrollbar {
  display: none;
}

.viewer-tab {
  border: 0;
  background: transparent;
  color: #8a8f9a;
  font-size: 11px;
  font-family: inherit;
  padding: 3px 10px;
  cursor: pointer;
  white-space: nowrap;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s;
}

.viewer-tab:hover {
  color: #cbd5e1;
}

.viewer-tab.active {
  color: #e2e8f0;
  border-bottom-color: #60a5fa;
}

.file-viewer {
  position: absolute;
  font-size: var(--term-font-size);
  width: var(--term-width);
  height: var(--term-height);
  background: #1a1d24;
  color: #f3f4f6;
  border: 1px solid #3a4150;
  overflow: hidden;
  font-family: var(--term-font-family);
  line-height: var(--term-line-height);
  padding: 0;
  display: flex;
  flex-direction: column;
  pointer-events: auto;
}

.viewer-titlebar {
  height: 22px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 4px;
  font-size: 12px;
  color: #cbd5e1;
  background: rgba(36, 40, 50, 0.95);
  border-bottom: 1px solid rgba(90, 100, 120, 0.35);
  cursor: grab;
  user-select: none;
}

.viewer-title {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
}

.viewer-close {
  border: 0;
  background: transparent;
  color: #cbd5e1;
  cursor: pointer;
  font-size: 15px;
  line-height: 1;
  width: 18px;
  height: 18px;
}

.viewer-close:hover {
  color: #fca5a5;
}

.viewer-body {
  flex: 1;
  min-height: 0;
  padding: 2px 4px;
  overflow: auto;
  white-space: normal;
}

.viewer-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: #64748b;
  font-size: 13px;
  user-select: none;
}


.viewer-resizer {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 14px;
  height: 14px;
  cursor: se-resize;
  background: transparent;
  z-index: 2;
}

.viewer-resizer::before {
  content: '';
  position: absolute;
  right: 1px;
  bottom: 1px;
  width: 0;
  height: 0;
  border-style: solid;
  border-width: 0 0 5px 5px;
  border-color: transparent transparent #3a4150 transparent;
}
</style>

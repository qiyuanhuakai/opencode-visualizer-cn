<template>
  <div class="file-viewer-body">
    <div v-if="state.isLoading" class="file-loading">Loading...</div>
    <div v-else-if="state.error" class="file-loading">{{ state.error }}</div>
    <div
      v-else
      class="file-content"
      :class="{ 'is-binary': entry.isBinary, 'no-gutter': entry.toolGutterMode === 'none' }"
      v-html="state.html"
    ></div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, reactive, watch } from 'vue';
import { renderWorkerHtml } from '../utils/workerRenderer';

const props = defineProps<{
  entry: {
    html: string;
    content?: string;
    toolLang?: string;
    isBinary?: boolean;
    toolGutterMode?: 'default' | 'none' | 'grep-source';
  };
  theme: string;
}>();

const { entry } = props;
const state = reactive({
  isLoading: true,
  html: '',
  error: '',
  requestId: 0,
});

async function startRender() {
  state.requestId += 1;
  const current = state.requestId;
  state.isLoading = true;
  state.error = '';
  await nextTick();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  if (entry.isBinary) {
    state.html = entry.html;
    state.isLoading = false;
    return;
  }
  if (!entry.content) {
    if (entry.html) {
      state.html = entry.html;
      state.isLoading = false;
      return;
    }
    if (entry.isLoading !== false) {
      state.isLoading = true;
      return;
    }
    state.html = '<pre class="shiki"><code></code></pre>';
    state.isLoading = false;
    return;
  }
  const nextId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  renderWorkerHtml({
    id: nextId,
    code: entry.content,
    lang: entry.toolLang ?? 'text',
    theme: props.theme,
  })
    .then((html) => {
      if (current !== state.requestId) return;
      state.html = html;
      state.isLoading = false;
    })
    .catch((error) => {
      if (current !== state.requestId) return;
      state.error = error instanceof Error ? error.message : 'Render failed';
      state.isLoading = false;
    });
}

watch(
  () => [entry.html, entry.content, entry.toolLang, entry.isBinary, entry.isLoading],
  startRender,
  { immediate: true },
);

onBeforeUnmount(() => {
  state.requestId += 1;
});
</script>

<style scoped>
.file-viewer-body {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

.file-loading {
  margin: auto;
  color: rgba(148, 163, 184, 0.9);
  font-size: 12px;
}

.file-content {
  line-height: var(--term-line-height);
  color: #c9d1d9;
}

.file-content :deep(pre),
.file-content :deep(code) {
  margin: 0;
  padding: 0;
  background: transparent !important;
  background-color: transparent !important;
  line-height: inherit !important;
  font-family: inherit;
  font-size: inherit;
  white-space: normal;
}

.file-content :deep(pre.shiki) {
  background: transparent !important;
  background-color: transparent !important;
  color: inherit;
  display: block;
  line-height: inherit !important;
}

.file-content :deep(.line) {
  line-height: inherit !important;
}

.file-content :deep(code) {
  display: grid;
  grid-template-columns: max-content max-content 1fr;
  column-gap: 0;
}

.file-content :deep(.code-row) {
  display: grid;
  grid-template-columns: subgrid;
  grid-column: 1 / -1;
  align-items: start;
}

.file-content :deep(.code-gutter) {
  text-align: right;
  color: #8a8a8a;
  white-space: pre;
  font-variant-numeric: tabular-nums;
  padding: 0 1ch 0 0;
}

.file-content :deep(.code-gutter.span-2) {
  grid-column: 1 / 3;
}

.file-content :deep(.line) {
  display: block;
  min-height: 1em;
  white-space: pre;
  box-sizing: border-box;
  padding-left: 2ch;
}

.file-content.no-gutter :deep(.line) {
  padding-left: 0;
}

.file-content.no-gutter :deep(code) {
  grid-template-columns: 1fr;
}

.file-content.no-gutter :deep(.code-gutter) {
  display: none;
}

.file-content.is-binary :deep(pre) {
  white-space: pre;
}

.file-content.is-binary :deep(.hexdump-address) {
  color: #60a5fa;
}

.file-content.is-binary :deep(.hexdump-separator) {
  color: #64748b;
}

.file-content.is-binary :deep(.hexdump-control) {
  color: #f59e0b;
}

.file-content.is-binary :deep(.hexdump-ascii) {
  color: #dbeafe;
}

.file-content.is-binary :deep(.hexdump-exascii) {
  color: #fca5a5;
}

.file-content.is-binary :deep(.hexdump-null) {
  color: #64748b;
}
</style>

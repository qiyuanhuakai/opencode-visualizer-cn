<template>
  <div class="diff-viewer">
    <div v-if="state.isLoading" class="diff-loading">Loading...</div>
    <div v-else-if="state.error" class="diff-loading">{{ state.error }}</div>
    <div v-else class="diff-content" v-html="state.html"></div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, reactive, watch } from 'vue';
import { renderWorkerHtml } from '../utils/workerRenderer';

const props = defineProps<{
  code: string;
  patch?: string;
  after?: string;
  lang: string;
  theme: string;
}>();

const state = reactive({
  isLoading: true,
  html: '',
  error: '',
  requestId: 0,
});

async function startRender() {
  const nextId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  state.requestId += 1;
  const current = state.requestId;
  state.isLoading = true;
  state.error = '';
  await nextTick();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  const codePayload = props.code;
  if (!props.patch && !codePayload.trim()) {
    state.error = 'Render failed';
    state.isLoading = false;
    return;
  }
  renderWorkerHtml({
    id: nextId,
    code: codePayload,
    patch: props.patch,
    after: props.after,
    lang: props.lang,
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
  () => [props.code, props.patch, props.after, props.lang, props.theme],
  startRender,
  { immediate: true },
);

onBeforeUnmount(() => {
  state.requestId += 1;
});
</script>

<style scoped>
.diff-viewer {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

.diff-loading {
  margin: auto;
  color: rgba(148, 163, 184, 0.9);
  font-size: 12px;
}

.diff-content {
  line-height: var(--term-line-height);
  color: #c9d1d9;
}

.diff-content :deep(pre),
.diff-content :deep(code) {
  margin: 0;
  padding: 0;
  background: transparent !important;
  background-color: transparent !important;
  line-height: inherit !important;
  font-family: inherit;
  font-size: inherit;
  white-space: normal;
}

.diff-content :deep(pre.shiki) {
  background: transparent !important;
  background-color: transparent !important;
  color: inherit;
  display: block;
  line-height: inherit !important;
}

.diff-content :deep(code) {
  display: grid;
  grid-template-columns: max-content max-content 1fr;
  column-gap: 0;
}

.diff-content :deep(.code-row) {
  display: grid;
  grid-template-columns: subgrid;
  grid-column: 1 / -1;
  align-items: start;
}

.diff-content :deep(.code-gutter) {
  text-align: right;
  color: #8a8a8a;
  white-space: pre;
  font-variant-numeric: tabular-nums;
  padding: 0 1ch 0 0;
}

.diff-content :deep(.code-gutter.span-2) {
  grid-column: 1 / 3;
}

.diff-content :deep(.line) {
  display: block;
  min-height: 1em;
  white-space: pre;
  box-sizing: border-box;
  padding-left: 2ch;
}



.diff-content :deep(.code-row.line-added) {
  background: rgba(46, 160, 67, 0.22);
}

.diff-content :deep(.code-row.line-added) .line {
  box-shadow: inset 3px 0 0 #2ea043;
  color: #aff5b4;
}

.diff-content :deep(.code-row.line-removed) {
  background: rgba(248, 81, 73, 0.2);
}

.diff-content :deep(.code-row.line-removed) .line {
  box-shadow: inset 3px 0 0 #f85149;
  color: #ffdcd7;
}

.diff-content :deep(.code-row.line-hunk) {
  background: rgba(56, 139, 253, 0.18);
}

.diff-content :deep(.code-row.line-hunk) .line {
  box-shadow: inset 3px 0 0 rgba(56, 139, 253, 0.55);
  color: #c9d1d9;
}

.diff-content :deep(.code-row.line-header) {
  background: rgba(110, 118, 129, 0.18);
}

.diff-content :deep(.code-row.line-header) .line {
  box-shadow: inset 3px 0 0 rgba(110, 118, 129, 0.55);
  color: #c9d1d9;
}
</style>

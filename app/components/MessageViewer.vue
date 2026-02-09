<template>
  <div
    class="message-viewer shiki-host"
    :class="{
      'wrap-soft': wrapMode === 'soft',
      'no-gutter': gutterMode === 'none',
      'is-message': isMessage,
    }"
  >
    <div v-if="state.html" class="message-content" v-html="state.html"></div>
    <div v-else-if="state.error" class="message-loading">{{ state.error }}</div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, reactive, toRaw, watch } from 'vue';
import { renderWorkerHtml } from '../utils/workerRenderer';

const props = defineProps<{
  code: string;
  lang: string;
  theme: string;
  wrapMode?: 'default' | 'soft';
  gutterMode?: 'none' | 'single' | 'double';
  gutterLines?: string[];
  grepPattern?: string;
  lineOffset?: number;
  lineLimit?: number;
  isMessage?: boolean;
}>();

const emit = defineEmits<{
  (event: 'rendered'): void;
}>();

const state = reactive({
  isLoading: true,
  html: '',
  error: '',
  requestId: 0,
});

async function startRender() {
  const nextId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const hasPreviousHtml = state.html.length > 0;
  state.requestId += 1;
  const current = state.requestId;
  state.isLoading = !hasPreviousHtml;
  if (!hasPreviousHtml) state.error = '';
  await nextTick();
  await new Promise((resolve) => requestAnimationFrame(resolve));
  renderWorkerHtml({
    id: nextId,
    code: props.code,
    lang: props.lang,
    theme: props.theme,
    gutterMode: props.gutterMode ?? 'none',
    gutterLines: props.gutterLines ? toRaw(props.gutterLines) : undefined,
    grepPattern: props.grepPattern,
    lineOffset: props.lineOffset,
    lineLimit: props.lineLimit,
  })
    .then((html) => {
      if (current !== state.requestId) return;
      state.html = html;
      state.error = '';
      state.isLoading = false;
      emit('rendered');
    })
    .catch((error) => {
      if (current !== state.requestId) return;
      if (!state.html) {
        state.error = error instanceof Error ? error.message : 'Render failed';
      }
      state.isLoading = false;
      emit('rendered');
    });
}

watch(
  () => [
    props.code,
    props.lang,
    props.theme,
    props.wrapMode,
    props.gutterMode,
    props.grepPattern,
    props.lineOffset,
    props.lineLimit,
    props.gutterLines?.join('\n') ?? '',
  ],
  startRender,
  { immediate: true },
);

onBeforeUnmount(() => {
  state.requestId += 1;
});
</script>

<style scoped>
.message-viewer {
  line-height: inherit;
  color: inherit;
  min-height: 1.2em;
}

.message-loading {
  margin: auto;
  color: rgba(148, 163, 184, 0.9);
  font-size: 12px;
}

.message-content {
  line-height: inherit;
  color: inherit;
}

.message-content :deep(pre),
.message-content :deep(code) {
  margin: 0;
  padding: 0;
  background: transparent !important;
  background-color: transparent !important;
  line-height: inherit !important;
  font-family: inherit;
  font-size: inherit;
  white-space: normal;
}

.message-content :deep(pre.shiki) {
  background: transparent !important;
  background-color: transparent !important;
  color: inherit;
  display: block;
  line-height: inherit !important;
}

.message-content :deep(code) {
  display: grid;
  grid-template-columns: max-content max-content 1fr;
  column-gap: 0;
}

.message-content :deep(.code-row) {
  display: grid;
  grid-template-columns: subgrid;
  grid-column: 1 / -1;
  align-items: start;
}

.message-content :deep(.code-gutter) {
  text-align: right;
  color: #8a8a8a;
  white-space: pre;
  font-variant-numeric: tabular-nums;
  padding: 0 1ch 0 1ch;
}

.message-content :deep(.code-gutter.span-2) {
  grid-column: 1 / 3;
}

.message-content :deep(.line) {
  display: block;
  min-height: 1em;
  white-space: pre;
  box-sizing: border-box;
  padding-left: 1ch;
}

.message-viewer.no-gutter .message-content :deep(code) {
  grid-template-columns: 1fr;
}

.message-viewer.no-gutter .message-content :deep(.code-gutter) {
  display: none;
}

.message-viewer.no-gutter .message-content :deep(.line) {
  padding-left: 0;
}

.message-viewer.wrap-soft .message-content :deep(.line),
.message-viewer.is-message .message-content :deep(.line) {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}

.message-content :deep(.line:empty)::after {
  content: ' ';
}

.message-content :deep(.grep-match) {
  color: #fef08a;
  background: rgba(234, 179, 8, 0.3);
  border-radius: 2px;
  padding: 0 0.08em;
  font-weight: 700;
}

.message-content :deep(.grep-match strong) {
  font-weight: inherit;
}
</style>

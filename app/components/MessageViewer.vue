<template>
  <div v-if="state.html" class="message-viewer min-h-[1.2em] leading-[inherit] text-[inherit]">
    <div class="message-content leading-[inherit] text-[inherit]" v-html="state.html"></div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, reactive, watch } from 'vue';
import { renderWorkerHtml } from '../utils/workerRenderer';

// { code, lang, theme } | { html } — 排他的に使う
const props = defineProps<{
  code?: string;
  lang?: string;
  theme?: string;
  html?: string;
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
  const code = props.code ?? '';
  const lang = props.lang ?? 'text';
  const theme = props.theme ?? 'github-dark';
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
    code,
    lang,
    theme,
    gutterMode: 'none',
  })
    .then(async (html) => {
      if (current !== state.requestId) return;
      state.html = html;
      state.error = '';
      state.isLoading = false;
      await nextTick();
      if (current !== state.requestId) return;
      emit('rendered');
    })
    .catch(async (error) => {
      if (current !== state.requestId) return;
      if (!state.html) {
        state.error = error instanceof Error ? error.message : 'Render failed';
      }
      state.isLoading = false;
      await nextTick();
      if (current !== state.requestId) return;
      emit('rendered');
    });
}

// html パス: 外部から pre-rendered HTML を受け取る
watch(
  () => props.html,
  async (newHtml) => {
    if (newHtml == null) return;
    state.requestId += 1;
    state.html = newHtml;
    state.isLoading = false;
    state.error = '';
    await nextTick();
    emit('rendered');
  },
  { immediate: true },
);

// code パス: html が無いときだけ自力で worker render
watch(
  () => [props.code, props.lang, props.theme],
  () => {
    if (props.html != null) return;
    startRender();
  },
  { immediate: true },
);

onBeforeUnmount(() => {
  state.requestId += 1;
});
</script>

<style scoped>
.message-content :deep(pre.shiki),
.message-content :deep(pre.shiki > code) {
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

.message-content :deep(pre.shiki > code) {
  display: block;
}

.message-content :deep(.code-row) {
  display: block;
}

.message-content :deep(.code-gutter) {
  display: none;
}

.message-content :deep(.line) {
  display: inline;
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

.message-content :deep(.markdown-host) {
  line-height: 1.2;
  color: inherit;
  overflow-wrap: anywhere;
  white-space: normal;
}

.message-content
  :deep(.markdown-host :where(p, ul, ol, li, blockquote, pre, hr, h1, h2, h3, h4, h5, h6)) {
  margin: 0;
  margin-block: 0;
  padding: 0;
}

.message-content :deep(.markdown-host p + p) {
  margin-top: 0.5em;
}

.message-content :deep(.markdown-host h1),
.message-content :deep(.markdown-host h2),
.message-content :deep(.markdown-host h3),
.message-content :deep(.markdown-host h4),
.message-content :deep(.markdown-host h5),
.message-content :deep(.markdown-host h6) {
  line-height: 1.2;
}

.message-content :deep(.markdown-host h1) {
  margin: 0.5em 0 0.25em;
  font-size: 1.3em;
  font-weight: 700;
}

.message-content :deep(.markdown-host h2) {
  margin: 0.4em 0 0.2em;
  font-size: 1.2em;
  font-weight: 700;
}

.message-content :deep(.markdown-host h3) {
  margin: 0.35em 0 0.15em;
  font-size: 1.12em;
  font-weight: 600;
}

.message-content :deep(.markdown-host h4) {
  margin: 0.3em 0 0.1em;
  font-size: 1.06em;
  font-weight: 600;
}

.message-content :deep(.markdown-host h5),
.message-content :deep(.markdown-host h6) {
  margin: 0.12em 0 0.04em;
  font-size: 1em;
  font-weight: 600;
}

.message-content :deep(.markdown-host ul),
.message-content :deep(.markdown-host ol) {
  padding: 0.5em;
  margin: 0;
}

.message-content :deep(.markdown-host ol) {
  counter-reset: md-ol;
  padding-left: 1.8em;
}

.message-content :deep(.markdown-host ol > li) {
  list-style: none;
  position: relative;
  padding-left: 0.4em;
  counter-increment: md-ol;
}

.message-content :deep(.markdown-host ol > li)::before {
  content: counter(md-ol) '.';
  position: absolute;
  left: -1.4em;
  color: #60a5fa;
  font-variant-numeric: tabular-nums;
}

.message-content :deep(.markdown-host ul > li) {
  list-style: none;
  position: relative;
  padding-left: 0.9em;
}

.message-content :deep(.markdown-host ul > li)::before {
  content: '-';
  position: absolute;
  left: 0;
  color: #60a5fa;
}

.message-content :deep(.markdown-host li + li) {
  margin-top: 0.5em;
}

.message-content :deep(.markdown-host blockquote) {
  margin: 0.2em 0;
  padding-left: 0.7em;
  border-left: 2px solid rgba(148, 163, 184, 0.5);
  color: rgba(226, 232, 240, 0.85);
  background: rgba(15, 23, 42, 0.35);
  border-radius: 0 4px 4px 0;
}

.message-content :deep(.markdown-host a) {
  color: #7dd3fc;
  text-decoration: underline;
  text-decoration-color: rgba(125, 211, 252, 0.55);
  text-underline-offset: 2px;
}

.message-content :deep(.markdown-host a:hover) {
  text-decoration-color: #7dd3fc;
}

.message-content :deep(.markdown-host strong) {
  font-weight: 700;
}

.message-content :deep(.markdown-host em) {
  font-style: italic;
}

.message-content :deep(.markdown-host hr) {
  border: 0;
  border-top: 1px solid rgba(148, 163, 184, 0.35);
  margin: 0.3em 0;
}

.message-content :deep(.markdown-host table) {
  border-collapse: collapse;
  margin: 0.3em 0;
  width: max-content;
  max-width: 100%;
  display: block;
  overflow-x: auto;
}

.message-content :deep(.markdown-host th),
.message-content :deep(.markdown-host td) {
  border: 1px solid rgba(148, 163, 184, 0.3);
  padding: 0.2em 0.55em;
}

.message-content :deep(.markdown-host th) {
  font-weight: 600;
  background: rgba(51, 65, 85, 0.35);
}

.message-content :deep(.markdown-host tr:nth-child(even)) {
  background: rgba(51, 65, 85, 0.12);
}

.message-content :deep(.markdown-host img) {
  max-width: 100%;
  height: auto;
}

.message-content :deep(.markdown-host del) {
  text-decoration: line-through;
  opacity: 0.6;
}

.message-content :deep(.markdown-host code:not(pre code)) {
  display: inline;
  white-space: pre-wrap;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
  font-size: 0.95em;
  color: #79b8ff;
}

.message-content :deep(.markdown-host pre) {
  margin: 0.5em 0.25em;
  padding: 0.45em 0.6em;
  border-radius: 6px;
  background: rgba(15, 23, 42, 0.5);
  border: 1px solid rgba(148, 163, 184, 0.18);
  overflow-x: auto;
}

.message-content :deep(.markdown-host pre code) {
  display: block;
  white-space: pre-line;
  background: transparent;
  border: 0;
  padding: 0;
  color: inherit;
}
</style>

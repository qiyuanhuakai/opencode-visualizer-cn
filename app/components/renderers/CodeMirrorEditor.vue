<template>
  <div class="code-mirror-editor-root">
    <CodeMirror
      v-model="localValue"
      class="code-mirror-editor"
      basic
      :dark="isDark"
      :lang="languageSupport"
      :extensions="extensions"
      :wrap="wordWrap"
      @update="handleUpdate"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import CodeMirror from 'vue-codemirror6';
import type { LanguageSupport } from '@codemirror/language';
import type { Extension } from '@codemirror/state';
import { EditorView, type ViewUpdate } from '@codemirror/view';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { json } from '@codemirror/lang-json';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { yaml } from '@codemirror/lang-yaml';
import { xml } from '@codemirror/lang-xml';
import { oneDark } from '@codemirror/theme-one-dark';

const props = defineProps<{
  modelValue: string;
  lang?: string;
  theme?: string;
  wordWrap?: boolean;
}>();

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void;
}>();

const localValue = ref(props.modelValue);

watch(() => props.modelValue, (value) => {
  if (value !== localValue.value) localValue.value = value;
});

const isDark = computed(() => props.theme !== 'light');
const wordWrap = computed(() => props.wordWrap === true);

const languageSupport = computed<LanguageSupport | undefined>(() => {
  switch (props.lang) {
    case 'typescript':
      return javascript({ typescript: true });
    case 'tsx':
      return javascript({ typescript: true, jsx: true });
    case 'javascript':
    case 'jsx':
      return javascript({ jsx: props.lang === 'jsx' });
    case 'vue':
    case 'astro':
    case 'svelte':
      return javascript();
    case 'python':
      return python();
    case 'markdown':
      return markdown();
    case 'json':
      return json();
    case 'html':
      return html();
    case 'css':
      return css();
    case 'yaml':
      return yaml();
    case 'xml':
    case 'svg':
      return xml();
    default:
      return undefined;
  }
});

const visualTheme = EditorView.theme({
  '&': {
    color: 'var(--floating-text, #e2e8f0)',
    backgroundColor: 'transparent',
    fontSize: 'var(--floating-font-size, var(--app-monospace-font-size, 13px))',
  },
  '.cm-scroller': {
    fontFamily: 'var(--floating-font-family, var(--app-monospace-font-family, ui-monospace, SFMono-Regular, Menlo, monospace))',
    lineHeight: 'var(--code-preview-line-height, 1.2)',
    backgroundColor: 'transparent',
  },
  '.cm-content': {
    caretColor: 'var(--floating-accent, #76e4f7)',
    fontFamily: 'var(--floating-font-family, var(--app-monospace-font-family, ui-monospace, SFMono-Regular, Menlo, monospace))',
    fontSize: 'var(--floating-font-size, var(--app-monospace-font-size, 13px))',
    lineHeight: 'var(--code-preview-line-height, 1.2)',
    selectionBackground: 'rgba(148, 163, 184, 0.22)',
  },
  '.cm-line': {
    lineHeight: 'var(--code-preview-line-height, 1.2)',
  },
  '&.cm-focused .cm-cursor, & .cm-cursor': {
    borderLeftColor: 'var(--floating-accent, #76e4f7)',
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-selectionLayer .cm-selectionBackground': {
    backgroundColor: 'rgba(148, 163, 184, 0.22)',
  },
  '&.cm-focused .cm-matchingBracket, &.cm-focused .cm-nonmatchingBracket': {
    backgroundColor: 'rgba(148, 163, 184, 0.12)',
  },
  '.cm-gutters': {
    color: 'var(--floating-text-muted, #94a3b8)',
    backgroundColor: 'var(--floating-surface-muted, #242832)',
    border: 'none',
    borderRight: '1px solid var(--floating-border-muted, rgba(90, 100, 120, 0.35))',
  },
  '.cm-lineNumbers, .cm-foldGutter': {
    color: 'var(--floating-text-muted, #94a3b8)',
    backgroundColor: 'var(--floating-surface-muted, #242832)',
  },
  '.cm-gutterElement': {
    color: 'var(--floating-text-muted, #94a3b8)',
    backgroundColor: 'var(--floating-surface-muted, #242832)',
  },
  '.cm-activeLine, .cm-activeLineGutter': {
    backgroundColor: 'rgba(148, 163, 184, 0.15)',
  },
  '.cm-tooltip, .cm-panels': {
    color: 'var(--floating-text, #e2e8f0)',
    backgroundColor: 'var(--floating-surface-muted, #242832)',
    borderColor: 'var(--floating-border-subtle, rgba(100, 110, 130, 0.5))',
  },
}, { dark: true });

const extensions = computed<Extension[]>(() => {
  const base = [visualTheme];
  if (isDark.value) base.unshift(oneDark);
  return base;
});

function handleUpdate(update: ViewUpdate) {
  if (!update.docChanged) return;
  const value = update.state.doc.toString();
  localValue.value = value;
  emit('update:modelValue', value);
}
</script>

<style scoped>
.code-mirror-editor-root {
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.code-mirror-editor {
  height: 100%;
  overflow: hidden;
}

.code-mirror-editor :deep(.cm-editor) {
  height: 100%;
  color: var(--floating-text, #e2e8f0);
  font-family: var(--app-monospace-font-family, monospace);
  font-size: var(--app-monospace-font-size, 13px);
  background: color-mix(in srgb, var(--floating-accent, #3a4150) 12%, var(--floating-surface-base, #1a1d24));
}

.code-mirror-editor :deep(.cm-scroller),
.code-mirror-editor :deep(.cm-content),
.code-mirror-editor :deep(.cm-line),
.code-mirror-editor :deep(.cm-gutters),
.code-mirror-editor :deep(.cm-gutterElement),
.code-mirror-editor :deep(.cm-tooltip),
.code-mirror-editor :deep(.cm-panels) {
  font-family: var(--floating-font-family, var(--app-monospace-font-family, ui-monospace, SFMono-Regular, Menlo, monospace));
  font-size: var(--floating-font-size, var(--app-monospace-font-size, 13px));
  line-height: var(--code-preview-line-height, 1.2);
}

.code-mirror-editor :deep(.cm-scroller) {
  overflow: auto;
  scrollbar-gutter: stable;
}

.code-mirror-editor :deep(.cm-gutters) {
  color: var(--floating-text-muted, #94a3b8);
  background: var(--floating-surface-muted, #242832);
  border-right: 1px solid var(--floating-border-muted, rgba(90, 100, 120, 0.35));
}

.code-mirror-editor :deep(.cm-activeLineGutter) {
  color: var(--floating-text-secondary, #cbd5e1);
}
</style>

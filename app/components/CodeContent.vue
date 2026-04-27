<template>
  <div class="code-content" :class="rootClass" v-html="html"></div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useSettings } from '../composables/useSettings';

const props = defineProps<{
  html: string;
  variant?: 'code' | 'diff' | 'message' | 'binary' | 'term' | 'plain';
  wordWrap?: boolean;
}>();

const { floatingPreviewWordWrap } = useSettings();

const rootClass = computed(() => {
  const v = props.variant ?? 'code';
  const shouldWrapSoft =
    v === 'message' ||
    v === 'term' ||
    props.wordWrap ||
    (floatingPreviewWordWrap.value && (v === 'code' || v === 'diff'));
  return {
    'is-diff': v === 'diff',
    'is-message': v === 'message',
    'is-binary': v === 'binary',
    'is-term': v === 'term',
    'is-plain': v === 'plain',
    'no-gutter': v === 'message' || v === 'binary' || v === 'term' || v === 'plain',
    'wrap-soft': shouldWrapSoft,
  };
});
</script>

<style scoped>
.code-content {
  line-height: inherit;
  color: inherit;
  min-height: 1.2em;
}

.code-content :deep(pre),
.code-content :deep(code) {
  margin: 0;
  padding: 0;
  background: transparent !important;
  background-color: transparent !important;
  line-height: inherit !important;
  font-family: inherit;
  font-size: inherit;
  white-space: normal;
}

.code-content :deep(pre.shiki) {
  background: transparent !important;
  background-color: transparent !important;
  color: inherit;
  display: block;
  line-height: inherit !important;
}

.code-content :deep(code) {
  display: block;
}

.code-content :deep(.code-row) {
  display: grid;
  grid-template-columns: max-content max-content auto;
  align-items: start;
}

.code-content :deep(.code-gutter) {
  grid-column: auto;
  text-align: right;
  color: #8a8a8a;
  white-space: pre;
  font-variant-numeric: tabular-nums;
  padding: 0 1ch 0 1ch;
  user-select: none;
}

.code-content :deep(.code-gutter.span-2) {
  grid-column: 1 / 3;
}

.code-content :deep(.line) {
  grid-column: 3;
  display: block;
  min-height: 1em;
  line-height: 1.2;
  white-space: pre;
  box-sizing: border-box;
  padding-left: 1ch;
}

.code-content :deep(.line:empty)::after {
  content: ' ';
}

/* no-gutter */

.code-content.no-gutter :deep(.code-row) {
  grid-template-columns: 1fr;
}

.code-content.no-gutter :deep(.code-gutter) {
  display: none;
}

.code-content.no-gutter :deep(.line) {
  grid-column: 1;
  padding-left: 0;
}

/* wrap-soft */

.code-content.wrap-soft :deep(.line) {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  word-break: break-word;
}

/* grep */

.code-content :deep(.grep-match) {
  color: #fef08a;
  background: rgba(234, 179, 8, 0.3);
  border-radius: 2px;
  padding: 0 0.08em;
  font-weight: 700;
}

.code-content :deep(.grep-match strong) {
  font-weight: inherit;
}

/* diff */

.code-content.is-diff :deep(.code-row.line-added) {
  background: rgba(46, 160, 67, 0.22);
}

.code-content.is-diff :deep(.code-row.line-added) .line {
  box-shadow: inset 3px 0 0 #2ea043;
  color: #aff5b4;
}

.code-content.is-diff :deep(.code-row.line-removed) {
  background: rgba(248, 81, 73, 0.2);
}

.code-content.is-diff :deep(.code-row.line-removed) .line {
  box-shadow: inset 3px 0 0 #f85149;
  color: #ffdcd7;
}

.code-content.is-diff :deep(.code-row.line-hunk) {
  background: rgba(56, 139, 253, 0.18);
}

.code-content.is-diff :deep(.code-row.line-hunk) .line {
  box-shadow: inset 3px 0 0 rgba(56, 139, 253, 0.55);
  color: #c9d1d9;
}

.code-content.is-diff :deep(.code-row.line-header) {
  background: rgba(110, 118, 129, 0.18);
}

.code-content.is-diff :deep(.code-row.line-header) .line {
  box-shadow: inset 3px 0 0 rgba(110, 118, 129, 0.55);
  color: #c9d1d9;
}

/* binary (hexdump) */

.code-content.is-binary :deep(pre) {
  white-space: pre;
}

.code-content.is-binary :deep(code) {
  display: block;
  white-space: pre;
}

.code-content.is-binary :deep(.hexdump-address) {
  color: #60a5fa;
}

.code-content.is-binary :deep(.hexdump-separator) {
  color: #64748b;
}

.code-content.is-binary :deep(.hexdump-control) {
  color: #f59e0b;
}

.code-content.is-binary :deep(.hexdump-ascii) {
  color: #dbeafe;
}

.code-content.is-binary :deep(.hexdump-exascii) {
  color: #fca5a5;
}

.code-content.is-binary :deep(.hexdump-null) {
  color: #64748b;
}
</style>

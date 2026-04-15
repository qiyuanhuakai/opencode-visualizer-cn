<template>
  <div class="code-renderer-content">
    <div ref="viewerBodyEl" class="viewer-body">
      <div v-if="showLoading" class="viewer-loading">{{ t('common.loading') }}</div>
      <CodeContent v-else :html="renderedHtml || rawHtml || ''" :variant="viewerVariant" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import CodeContent from '../CodeContent.vue';
import { type CodeRenderParams, useCodeRender } from '../../utils/useCodeRender';
import { DEFAULT_SYNTAX_THEME } from '../../utils/themeTokens';

const { t } = useI18n();

const props = defineProps<{
  path?: string;
  rawHtml?: string;
  fileContent?: string;
  lang?: string;
  gutterMode?: 'default' | 'none' | 'grep-source';
  theme?: string;
  lines?: string;
}>();

const emit = defineEmits<{
  (event: 'rendered'): void;
}>();

const viewerBodyEl = ref<HTMLDivElement | null>(null);

const viewerGutterMode = computed<'none' | 'single'>(() => {
  if (props.gutterMode === 'none') return 'none';
  return 'single';
});

const viewerVariant = computed<'code' | 'binary' | 'plain'>(() => {
  if (props.rawHtml && !props.fileContent) return 'binary';
  if (props.gutterMode === 'none') return 'plain';
  return 'code';
});

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

const { html: renderedHtml } = useCodeRender(renderParams);

function clearLineHighlights() {
  const root = viewerBodyEl.value;
  if (!root) return;
  root.querySelectorAll('.code-row.line-highlight').forEach((row) => {
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
  const root = viewerBodyEl.value;
  if (!root) return;
  clearLineHighlights();

  const specs = parseLineSpecs(props.lines);
  if (specs.length === 0) return;
  const rows = Array.from(root.querySelectorAll<HTMLElement>('.code-row'));
  if (rows.length === 0) return;
  for (const { start, end } of specs) {
    const clampedStart = Math.min(start, rows.length);
    const clampedEnd = Math.min(end, rows.length);
    for (let index = clampedStart - 1; index < clampedEnd; index += 1) {
      rows[index]?.classList.add('line-highlight');
    }
  }

  const firstStart = Math.min(specs[0].start, rows.length);
  rows[firstStart - 1]?.scrollIntoView({ block: 'center', inline: 'nearest' });
}

watch(
  [() => renderedHtml.value, () => props.rawHtml, () => props.lines],
  () => {
    nextTick(() => {
      applyLineSelection();
      emit('rendered');
    });
  },
  { immediate: true },
);

const showLoading = computed(() => {
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
}

.viewer-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
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
  font-size: 13px;
  user-select: none;
}
</style>

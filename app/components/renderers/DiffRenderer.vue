<template>
  <div class="diff-renderer-content">
    <div v-if="hasTabs" class="viewer-tabs">
      <button
        v-for="(tab, i) in diffTabs"
        :key="tab.file"
        type="button"
        class="viewer-tab"
        :class="{ active: i === activeTabIndex }"
        @click="activeTabIndex = i"
      >
        {{ basename(tab.file) }}
      </button>
    </div>
    <div class="viewer-body">
      <div v-if="showLoading" class="viewer-loading">{{ t('common.loading') }}</div>
      <CodeContent v-else :html="renderedHtml || ''" variant="diff" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch, nextTick } from 'vue';
import { useI18n } from 'vue-i18n';
import CodeContent from '../CodeContent.vue';
import { type CodeRenderParams, useCodeRender } from '../../utils/useCodeRender';
import { DEFAULT_SYNTAX_THEME } from '../../utils/themeTokens';

const { t } = useI18n();
import { guessLanguageFromPath } from '../ToolWindow/utils';

const props = defineProps<{
  path?: string;
  diffCode?: string;
  diffAfter?: string;
  diffPatch?: string;
  diffTabs?: Array<{ file: string; before: string; after: string }>;
  gutterMode?: 'none' | 'double';
  lang?: string;
  theme?: string;
}>();

const emit = defineEmits<{
  (event: 'rendered'): void;
}>();

const activeTabIndex = ref(0);
const hasTabs = computed(() => !!props.diffTabs && props.diffTabs.length > 1);

const activePath = computed(() => {
  const tabs = props.diffTabs;
  if (!tabs || tabs.length === 0) return props.path;
  return tabs[activeTabIndex.value]?.file;
});

const activeDiffCode = computed(() => {
  const tabs = props.diffTabs;
  if (!tabs || tabs.length === 0) return props.diffCode ?? '';
  return tabs[activeTabIndex.value]?.before ?? '';
});

const activeDiffAfter = computed(() => {
  const tabs = props.diffTabs;
  if (!tabs || tabs.length === 0) return props.diffAfter;
  return tabs[activeTabIndex.value]?.after;
});

const activeDiffLang = computed(() => {
  if (props.lang && props.lang !== 'text') return props.lang;
  return guessLanguageFromPath(activePath.value);
});

const renderParams = computed<CodeRenderParams | null>(() => {
  const hasDiffTabs = !!props.diffTabs && props.diffTabs.length > 0;
  if (!activeDiffCode.value && !activeDiffAfter.value && !props.diffPatch) return null;
  return {
    code: activeDiffCode.value,
    after: activeDiffAfter.value,
    patch: hasDiffTabs ? undefined : props.diffPatch || undefined,
    lang: activeDiffLang.value,
    theme: props.theme ?? DEFAULT_SYNTAX_THEME,
    gutterMode: props.gutterMode ?? 'double',
  };
});

const { html: renderedHtml } = useCodeRender(renderParams);

watch(
  [() => renderedHtml.value, () => activeTabIndex.value],
  () => {
    nextTick(() => emit('rendered'));
  },
  { immediate: true },
);

const showLoading = computed(() => {
  if (renderedHtml.value) return false;
  return !!renderParams.value;
});

function basename(filepath: string) {
  return filepath.split('/').pop() ?? filepath;
}
</script>

<style scoped>
.diff-renderer-content {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

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
  transition:
    color 0.15s,
    border-color 0.15s;
}

.viewer-tab:hover {
  color: #cbd5e1;
}

.viewer-tab.active {
  color: #e2e8f0;
  border-bottom-color: #60a5fa;
}

.viewer-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
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
</style>

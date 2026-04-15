<template>
  <div class="diff-viewer-root">
    <div v-if="hasFileTabs" class="viewer-tabs">
      <button
        v-for="(tab, i) in diffTabs"
        :key="tab.file"
        type="button"
        class="viewer-tab"
        :class="{ active: i === activeFileIndex }"
        @click="activeFileIndex = i"
      >
        {{ basename(tab.file) }}
      </button>
    </div>

    <div class="viewer-tabs">
      <button
        v-for="mode in primaryModes"
        :key="mode.id"
        type="button"
        class="viewer-tab"
        :class="{ active: mode.id === primaryMode }"
        @click="primaryMode = mode.id"
      >
        {{ mode.label }}
      </button>
    </div>

    <div class="viewer-body">
      <DiffRenderer
        v-if="primaryMode === 'diff'"
        :path="activeFilePath"
        :diff-code="activeBefore"
        :diff-after="activeAfter"
        :diff-patch="activeDiffPatch"
        :gutter-mode="diffGutterMode"
        :lang="lang"
        :theme="theme"
        @rendered="emit('rendered')"
      />
      <ContentViewer
        v-else
        :path="activeFilePath"
        :file-content="isBitmapFile ? undefined : activeText"
        :binary-base64="isBitmapFile ? activeBase64 : undefined"
        :lang="activeLanguage"
        :theme="theme"
        @rendered="emit('rendered')"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { guessLanguageFromPath } from '../ToolWindow/utils';
import DiffRenderer from '../renderers/DiffRenderer.vue';
import ContentViewer from './ContentViewer.vue';

const { t } = useI18n();

type PrimaryMode = 'original' | 'modified' | 'diff';

const props = defineProps<{
  path?: string;
  diffCode?: string;
  diffAfter?: string;
  diffCodeBase64?: string;
  diffAfterBase64?: string;
  diffPatch?: string;
  diffTabs?: Array<{
    file: string;
    before: string;
    after: string;
    beforeBase64?: string;
    afterBase64?: string;
  }>;
  gutterMode?: 'none' | 'double';
  lang?: string;
  theme?: string;
}>();

const emit = defineEmits<{
  (event: 'rendered'): void;
}>();

const activeFileIndex = ref(0);
const primaryMode = ref<PrimaryMode>('diff');

const hasFileTabs = computed(() => !!props.diffTabs && props.diffTabs.length > 1);
const hasBeforeAfter = computed(() => {
  if (props.diffTabs && props.diffTabs.length > 0) return true;
  return props.diffAfter != null;
});

const activeEntry = computed(() => {
  const tabs = props.diffTabs;
  if (!tabs || tabs.length === 0) {
    return {
      file: props.path ?? '',
      before: props.diffCode ?? '',
      after: props.diffAfter ?? '',
      beforeBase64: props.diffCodeBase64,
      afterBase64: props.diffAfterBase64,
    };
  }
  return tabs[activeFileIndex.value] ?? tabs[0];
});

const BITMAP_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp']);

const isBitmapFile = computed(() => {
  const filepath = activeEntry.value.file || props.path || '';
  const ext = filepath.split('.').pop()?.toLowerCase();
  if (!ext) return false;
  return BITMAP_EXTENSIONS.has(ext);
});

const primaryModes = computed<Array<{ id: PrimaryMode; label: string }>>(() => {
  if (!hasBeforeAfter.value) return [{ id: 'diff', label: t('viewers.diff.diff') }];
  if (isBitmapFile.value) {
    return [
      { id: 'modified', label: t('viewers.diff.modified') },
      { id: 'original', label: t('viewers.diff.original') },
    ];
  }
  return [
    { id: 'original', label: t('viewers.diff.original') },
    { id: 'modified', label: t('viewers.diff.modified') },
    { id: 'diff', label: t('viewers.diff.diff') },
  ];
});

watch(
  primaryModes,
  (modes) => {
    const valid = modes.some((mode) => mode.id === primaryMode.value);
    if (!valid && modes[0]) primaryMode.value = modes[0].id;
  },
  { immediate: true },
);

const activeFilePath = computed(() => activeEntry.value.file || props.path || '');
const activeBefore = computed(() => activeEntry.value.before ?? '');
const activeAfter = computed(() => activeEntry.value.after ?? '');
const activeDiffPatch = computed(() =>
  props.diffTabs && props.diffTabs.length > 0 ? undefined : props.diffPatch,
);

const activeText = computed(() => {
  if (primaryMode.value === 'original') return activeBefore.value;
  if (primaryMode.value === 'modified') return activeAfter.value;
  return '';
});

const activeBase64 = computed(() => {
  if (primaryMode.value === 'original') return activeEntry.value.beforeBase64;
  if (primaryMode.value === 'modified') return activeEntry.value.afterBase64;
  return undefined;
});

const activeLanguage = computed(() => guessLanguageFromPath(activeFilePath.value));

const diffGutterMode = computed<'none' | 'double'>(() => props.gutterMode ?? 'double');

function basename(filepath: string) {
  return filepath.split('/').pop() ?? filepath;
}
</script>

<style scoped>
.diff-viewer-root {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.viewer-tabs {
  display: flex;
  gap: 0;
  background: var(--floating-surface-muted, rgba(26, 29, 36, 0.95));
  border-bottom: 1px solid var(--floating-border-muted, rgba(90, 100, 120, 0.35));
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
  color: var(--floating-text-soft, #8a8f9a);
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
  color: var(--floating-text-secondary, #cbd5e1);
}

.viewer-tab.active {
  color: var(--floating-text, #e2e8f0);
  border-bottom-color: color-mix(in srgb, var(--window-color, #3a4150) 50%, #60a5fa);
}

.viewer-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>

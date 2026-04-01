<template>
  <div class="message-viewer-shell">
    <div v-if="showModeTabs" class="viewer-tabs">
      <button
        v-for="mode in availableModes"
        :key="mode.id"
        type="button"
        class="viewer-tab"
        :class="{ active: mode.id === activeMode }"
        @click="activeMode = mode.id"
      >
        {{ mode.label }}
      </button>
    </div>
    <component :is="activeComponent" v-bind="mergedProps" @rendered="emit('rendered')" />
  </div>
</template>

<script setup lang="ts">
import { computed, ref, useAttrs, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import CodeRenderer from './renderers/CodeRenderer.vue';
import MarkdownRenderer from './renderers/MarkdownRenderer.vue';

const { t } = useI18n();

type MessageMode = 'auto' | 'markdown' | 'code';
type ActiveMode = 'markdown' | 'code';

const props = defineProps<{
  code?: string;
  lang?: string;
  theme?: string;
  html?: string;
  files?: string[];
  copyButton?: boolean;
  mode?: MessageMode;
  allowModeToggle?: boolean;
}>();

const emit = defineEmits<{
  (event: 'rendered'): void;
}>();

const attrs = useAttrs();
const activeMode = ref<ActiveMode>('markdown');

const availableModes = computed<Array<{ id: ActiveMode; label: string }>>(() => {
  if (props.html != null) return [{ id: 'markdown', label: t('messageViewer.rendered') }];
  if (props.mode === 'markdown') return [{ id: 'markdown', label: t('messageViewer.rendered') }];
  if (props.mode === 'code') return [{ id: 'code', label: t('messageViewer.source') }];
  if (props.lang === 'markdown') {
    if (props.allowModeToggle) {
      return [
        { id: 'markdown', label: t('messageViewer.rendered') },
        { id: 'code', label: t('messageViewer.source') },
      ];
    }
    return [{ id: 'markdown', label: t('messageViewer.rendered') }];
  }
  return [{ id: 'code', label: t('messageViewer.source') }];
});

watch(
  availableModes,
  (modes) => {
    const valid = modes.some((mode) => mode.id === activeMode.value);
    if (!valid && modes[0]) activeMode.value = modes[0].id;
  },
  { immediate: true },
);

const showModeTabs = computed(
  () => props.allowModeToggle === true && availableModes.value.length > 1,
);

const activeComponent = computed(() => {
  if (activeMode.value === 'markdown') return MarkdownRenderer;
  return CodeRenderer;
});

const activeProps = computed(() => {
  if (activeMode.value === 'markdown') {
    return {
      code: props.code,
      lang: props.lang ?? 'markdown',
      theme: props.theme,
      html: props.html,
      files: props.files,
      copyButton: props.copyButton,
      copyButtonLabel: t('render.copyCode'),
      copiedLabel: t('render.copied'),
      copyCodeAriaLabel: t('render.copyCodeAria'),
      copyMarkdownAriaLabel: t('render.copyMarkdownAria'),
    };
  }
  return {
    fileContent: props.code,
    lang: props.lang ?? 'text',
    theme: props.theme,
    gutterMode: 'none' as const,
  };
});

const mergedProps = computed(() => ({
  ...attrs,
  ...activeProps.value,
}));
</script>

<style scoped>
.message-viewer-shell {
  display: flex;
  flex-direction: column;
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
  margin-bottom: 0.25rem;
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
  padding: 2px 8px;
  cursor: pointer;
  white-space: nowrap;
  border-bottom: 2px solid transparent;
}

.viewer-tab:hover {
  color: #cbd5e1;
}

.viewer-tab.active {
  color: #e2e8f0;
  border-bottom-color: #60a5fa;
}
</style>

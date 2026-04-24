<template>
  <div class="pdf-renderer-root">
    <div v-if="error" class="pdf-error">
      {{ t('pdfViewer.failedToLoad') }}
    </div>
    <div v-else-if="!source" class="pdf-loading">
      {{ t('pdfViewer.loading') }}
    </div>
    <VuePdfEmbed
      v-else
      :source="source"
      :page="currentPage"
      :scale="scale"
      class="pdf-viewer"
      @rendered="() => onRendered()"
      @rendering-failed="onError"
    />
    <div v-if="numPages > 1" class="pdf-controls">
      <button
        type="button"
        class="pdf-control-btn"
        :disabled="currentPage <= 1"
        @click="currentPage--"
      >
        ←
      </button>
      <span class="pdf-page-info">{{ currentPage }} / {{ numPages }}</span>
      <button
        type="button"
        class="pdf-control-btn"
        :disabled="currentPage >= numPages"
        @click="currentPage++"
      >
        →
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import VuePdfEmbed from 'vue-pdf-embed';

const { t } = useI18n();

const props = defineProps<{
  src: string; // base64 data URL or URL
}>();

const emit = defineEmits<{
  (event: 'rendered'): void;
}>();

const currentPage = ref(1);
const numPages = ref(1);
const scale = ref(1.5);
const error = ref(false);

const source = computed(() => props.src);

watch(
  () => props.src,
  () => {
    currentPage.value = 1;
    numPages.value = 1;
    error.value = false;
  },
);

function onRendered(pages?: number) {
  if (pages !== undefined) {
    numPages.value = pages;
  }
  error.value = false;
  emit('rendered');
}

function onError() {
  error.value = true;
}
</script>

<style scoped>
.pdf-renderer-root {
  width: 100%;
  height: 100%;
  overflow: auto;
  background: var(--floating-surface-subtle, var(--theme-surface-panel, #0f172a));
  display: flex;
  flex-direction: column;
}

.pdf-viewer {
  flex: 1;
  display: flex;
  justify-content: center;
  padding: 16px;
}

.pdf-viewer :deep(canvas) {
  max-width: 100%;
  box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -1px rgba(0, 0, 0, 0.06);
}

.pdf-controls {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 8px 16px;
  background: var(--floating-surface-muted, rgba(26, 29, 36, 0.95));
  border-top: 1px solid var(--floating-border-muted, rgba(90, 100, 120, 0.35));
  flex-shrink: 0;
}

.pdf-control-btn {
  background: var(--floating-surface, rgba(30, 35, 45, 0.85));
  border: 1px solid var(--floating-border, rgba(90, 100, 120, 0.35));
  color: var(--floating-text, #e2e8f0);
  padding: 4px 12px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  transition: all 0.15s;
}

.pdf-control-btn:hover:not(:disabled) {
  background: var(--floating-surface-strong, rgba(40, 45, 55, 0.95));
}

.pdf-control-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.pdf-page-info {
  font-size: 12px;
  color: var(--floating-text-secondary, #cbd5e1);
  min-width: 60px;
  text-align: center;
}

.pdf-error,
.pdf-loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--floating-text-secondary, #cbd5e1);
  font-size: 14px;
}

.pdf-error {
  color: var(--theme-status-danger, #f87171);
}
</style>

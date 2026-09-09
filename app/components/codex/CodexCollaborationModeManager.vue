<template>
  <section class="codex-collaboration-mode-manager" :aria-label="t('codexPanel.collaborationModesTitle')">
    <div class="codex-section-title">
      <span>{{ t('codexPanel.collaborationModesTitle') }}</span>
      <div class="codex-collaboration-mode-tools">
        <button
          type="button"
          class="codex-small-button"
          :disabled="!api.connected.value || api.collaborationModesLoading.value"
          :title="t('common.refresh')"
          @click="refreshModes"
        >
          <Icon icon="mdi:refresh" width="16" :class="{ 'codex-spin': api.collaborationModesLoading.value }" />
        </button>
      </div>
    </div>

    <p class="codex-collaboration-mode-description">{{ t('hint') }}</p>
    <div v-if="!api.connected.value" class="codex-empty" role="status">
      {{ t('codexPanel.connectToLoad') }}
    </div>
    <div v-else-if="api.collaborationModesLoading.value" class="codex-empty" role="status">
      {{ t('common.loading') }}
    </div>
    <div v-else-if="api.collaborationModesError.value || refreshError" class="codex-empty" role="alert">
      {{ t('unavailable') }}
      <p>{{ api.collaborationModesError.value || refreshError }}</p>
    </div>
    <div v-else-if="api.collaborationModes.value.length === 0" class="codex-empty">
      {{ api.connected.value ? t('codexPanel.collaborationModesNoModes') : t('codexPanel.connectToLoad') }}
    </div>
    <div v-else class="codex-collaboration-mode-list">
      <button
          v-for="mode in api.collaborationModes.value"
          :key="mode.mode"
          type="button"
          :aria-pressed="modeSelection?.selectedMode.value === mode.mode"
          :disabled="!modeSelection"
          @click="modeSelection?.onSelectMode(mode.mode)"
        class="codex-collaboration-mode-item"
      >
        <div class="codex-collaboration-mode-header">
          <Icon icon="mdi:account-group" width="16" class="codex-collaboration-mode-icon" />
          <span class="codex-collaboration-mode-name">{{ mode.name }}</span>
          <span v-if="mode.reasoningEffort" class="codex-collaboration-mode-effort">
            · {{ mode.reasoningEffort }}
          </span>
        </div>
        <span v-if="modeSelection?.selectedMode.value === mode.mode" class="codex-collaboration-mode-description" role="status">{{ t('selected') }}</span>
        <p v-if="mode.mode === 'plan' || mode.mode === 'default'" class="codex-collaboration-mode-description">{{ t(mode.mode) }}</p>
        <p v-if="mode.model" class="codex-collaboration-mode-description">
          {{ mode.model }}
        </p>
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { useCodexApi } from '../../composables/useCodexApi';
import type { CodexModeSelection } from '../../utils/codexSubpanelProps';
import { codexCollaborationUi } from '../../locales/codexCollaborationUi';

const { t } = useI18n({ useScope: 'local', messages: codexCollaborationUi });
const refreshError = ref('');

const props = defineProps<{
  api: Pick<ReturnType<typeof useCodexApi>, 'connected' | 'collaborationModesLoading' | 'collaborationModes' | 'collaborationModesError' | 'refreshCollaborationModes'>;
  modeSelection?: CodexModeSelection;
}>();

async function refreshModes() {
  refreshError.value = '';
  try {
    await props.api.refreshCollaborationModes();
  } catch (error) {
    refreshError.value = error instanceof Error ? error.message : String(error);
  }
}
</script>

<style scoped>
.codex-collaboration-mode-manager {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  min-height: 0;
}

.codex-collaboration-mode-tools {
  display: flex;
  gap: 6px;
}

.codex-collaboration-mode-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: auto;
}

.codex-collaboration-mode-item {
  text-align: left;
  cursor: pointer;
  font: inherit;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.35);
  transition: border-color 0.2s ease;
}

.codex-collaboration-mode-item[aria-pressed='true'],
.codex-collaboration-mode-item:focus-visible {
  border-color: var(--color-region-accent);
  outline: 1px solid var(--color-region-accent);
}

.codex-collaboration-mode-item:disabled {
  cursor: default;
  opacity: 0.5;
}

.codex-collaboration-mode-item:hover {
  border-color: var(--theme-border, rgba(148, 163, 184, 0.24));
}

.codex-collaboration-mode-header {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.codex-collaboration-mode-icon {
  flex-shrink: 0;
  color: var(--theme-accent-primary, #93c5fd);
}

.codex-collaboration-mode-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--theme-text-primary, #e2e8f0);
  word-break: break-word;
}

.codex-collaboration-mode-description {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--theme-text-secondary, #cbd5e1);
  word-break: break-word;
}

.codex-empty {
  color: var(--theme-text-muted, #94a3b8);
  font-size: 12px;
}

.codex-spin {
  animation: codex-spin-anim 1s linear infinite;
}

@keyframes codex-spin-anim {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .codex-spin { animation: none; }
  .codex-collaboration-mode-item { transition: none; }
}
</style>

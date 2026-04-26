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
          @click="api.refreshCollaborationModes()"
        >
          <Icon icon="mdi:refresh" width="16" :class="{ 'codex-spin': api.collaborationModesLoading.value }" />
        </button>
      </div>
    </div>

    <div v-if="api.collaborationModesLoading.value" class="codex-empty">
      {{ t('common.loading') }}
    </div>
    <div v-else-if="api.collaborationModes.value.length === 0" class="codex-empty">
      {{ api.connected.value ? t('codexPanel.collaborationModesNoModes') : t('codexPanel.connectToLoad') }}
    </div>
    <div v-else class="codex-collaboration-mode-list">
      <div
        v-for="mode in api.collaborationModes.value"
        :key="mode.id"
        class="codex-collaboration-mode-item"
      >
        <div class="codex-collaboration-mode-header">
          <Icon icon="mdi:account-group" width="16" class="codex-collaboration-mode-icon" />
          <span class="codex-collaboration-mode-name">{{ mode.name }}</span>
        </div>
        <p v-if="mode.description" class="codex-collaboration-mode-description">
          {{ mode.description }}
        </p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { useI18n } from 'vue-i18n';
import type { useCodexApi } from '../../composables/useCodexApi';

const { t } = useI18n();

defineProps<{
  api: ReturnType<typeof useCodexApi>;
}>();
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
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.35);
  transition: border-color 0.2s ease;
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
</style>

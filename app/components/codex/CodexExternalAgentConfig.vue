<template>
  <section class="codex-external-agent-config" :aria-label="t('codexPanel.externalAgentConfigTitle')">
    <div class="codex-section-title">
      <span>{{ t('codexPanel.externalAgentConfigTitle') }}</span>
      <div class="codex-external-agent-config-tools">
        <label class="codex-toggle-label">
          <input
            v-model="includeHome"
            type="checkbox"
            :disabled="!api.connected.value || api.externalAgentConfigLoading.value"
          />
          <span>{{ t('codexPanel.includeHome') }}</span>
        </label>
        <button
          type="button"
          class="codex-small-text-button"
          :disabled="!api.connected.value || api.externalAgentConfigLoading.value"
          @click="api.detectExternalAgentConfig(includeHome)"
        >
          <Icon icon="mdi:magnify" width="14" />
          {{ t('codexPanel.detect') }}
        </button>
      </div>
    </div>

    <div v-if="api.externalAgentConfigLoading.value" class="codex-empty">
      {{ t('common.loading') }}
    </div>
    <div v-else-if="api.externalAgentConfigItems.value.length === 0" class="codex-empty">
      {{ api.connected.value ? t('codexPanel.externalAgentConfigNoItems') : t('codexPanel.connectToLoad') }}
    </div>
    <div v-else class="codex-external-agent-config-list">
      <div
        v-for="item in api.externalAgentConfigItems.value"
        :key="`${item.itemType}-${item.description}-${item.cwd}`"
        class="codex-external-agent-config-item"
      >
        <div class="codex-external-agent-config-header">
          <div class="codex-external-agent-config-info">
            <span
              class="codex-external-agent-config-badge"
              :class="`is-type-${item.itemType}`"
            >
              {{ item.itemType }}
            </span>
            <span class="codex-external-agent-config-description">{{ item.description }}</span>
          </div>
          <button
            type="button"
            class="codex-small-text-button"
            :disabled="!api.connected.value || importingItem === item"
            @click="importItem(item)"
          >
            <Icon icon="mdi:import" width="14" />
            {{ importingItem === item ? t('common.processing') : t('codexPanel.import_') }}
          </button>
        </div>
        <div v-if="item.cwd" class="codex-external-agent-config-cwd">
          <Icon icon="mdi:folder-outline" width="12" />
          {{ item.cwd }}
        </div>
      </div>
    </div>

    <div v-if="api.externalAgentImportStatus.value" class="codex-external-agent-config-status">
      <p
        v-if="api.externalAgentImportStatus.value.success"
        class="codex-external-agent-config-status-success"
      >
        <Icon icon="mdi:check-circle" width="14" />
        {{ t('codexPanel.importSuccess') }}
      </p>
      <p
        v-else
        class="codex-external-agent-config-status-error"
      >
        <Icon icon="mdi:alert-circle" width="14" />
        {{ api.externalAgentImportStatus.value.error }}
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { Icon } from '@iconify/vue';
import { useI18n } from 'vue-i18n';
import type { useCodexApi } from '../../composables/useCodexApi';
import type { CodexExternalAgentConfigItem } from '../../backends/codex/codexAdapter';

const props = defineProps<{
  api: ReturnType<typeof useCodexApi>;
}>();

const { t } = useI18n();

const includeHome = ref(false);
const importingItem = ref<CodexExternalAgentConfigItem | null>(null);

async function importItem(item: CodexExternalAgentConfigItem) {
  if (importingItem.value) return;
  importingItem.value = item;
  try {
    await props.api.importExternalAgentConfig([item]);
  } catch {
    // errors handled by adapter
  } finally {
    importingItem.value = null;
  }
}
</script>

<style scoped>
.codex-external-agent-config {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  min-height: 0;
}

.codex-external-agent-config-tools {
  display: flex;
  align-items: center;
  gap: 10px;
}

.codex-toggle-label {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--theme-text-muted, #94a3b8);
  cursor: pointer;
}

.codex-toggle-label input[type='checkbox'] {
  width: 14px;
  height: 14px;
  accent-color: var(--theme-accent-primary, #2563eb);
  cursor: pointer;
}

.codex-external-agent-config-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: auto;
}

.codex-external-agent-config-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.35);
}

.codex-external-agent-config-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.codex-external-agent-config-info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex-wrap: wrap;
}

.codex-external-agent-config-badge {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  flex-shrink: 0;
}

.codex-external-agent-config-badge.is-type-AGENTS_MD {
  background: rgba(96, 165, 250, 0.2);
  color: var(--theme-accent-primary, #93c5fd);
}

.codex-external-agent-config-badge.is-type-CONFIG {
  background: rgba(74, 222, 128, 0.2);
  color: var(--theme-status-success, #4ade80);
}

.codex-external-agent-config-badge.is-type-SKILLS {
  background: rgba(167, 139, 250, 0.2);
  color: #c4b5fd;
}

.codex-external-agent-config-badge.is-type-PLUGINS {
  background: rgba(251, 191, 36, 0.2);
  color: var(--theme-status-warning, #fbbf24);
}

.codex-external-agent-config-badge.is-type-MCP_SERVER_CONFIG {
  background: rgba(244, 114, 182, 0.2);
  color: #f9a8d4;
}

.codex-external-agent-config-description {
  font-size: 13px;
  font-weight: 600;
  color: var(--theme-text-primary, #e2e8f0);
  word-break: break-word;
}

.codex-external-agent-config-cwd {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--theme-accent-primary, #60a5fa);
  font-family: var(--app-monospace-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
}

.codex-external-agent-config-status {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.codex-external-agent-config-status-success {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(74, 222, 128, 0.12);
  font-size: 12px;
  color: var(--theme-status-success, #4ade80);
}

.codex-external-agent-config-status-error {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(248, 113, 113, 0.12);
  font-size: 12px;
  color: var(--theme-status-error, #f87171);
}

.codex-empty {
  color: var(--theme-text-muted, #94a3b8);
  font-size: 12px;
}

.codex-small-text-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 0 10px;
  font-size: 12px;
  border: 1px solid var(--theme-border, rgba(148, 163, 184, 0.24));
  border-radius: 10px;
  background: var(--theme-button-bg, rgba(30, 41, 59, 0.82));
  color: var(--theme-text-primary, #e2e8f0);
  cursor: pointer;
}

.codex-small-text-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}
</style>

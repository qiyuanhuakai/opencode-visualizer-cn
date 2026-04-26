<template>
  <section class="codex-plugin-manager" :aria-label="t('codexPanel.pluginsTitle')">
    <div class="codex-section-title">
      <span>{{ t('codexPanel.pluginsTitle') }}</span>
      <div class="codex-plugin-tools">
        <button
          type="button"
          class="codex-small-text-button"
          :disabled="!api.connected.value || api.pluginsLoading.value"
          @click="showAddMarketplace = true"
        >
          <Icon icon="mdi:store-plus" width="14" />
          {{ t('codexPanel.marketplaceAddTitle') }}
        </button>
        <button
          type="button"
          class="codex-small-button"
          :disabled="!api.connected.value || api.pluginsLoading.value"
          :title="t('common.refresh')"
          @click="api.refreshPlugins()"
        >
          <Icon icon="mdi:refresh" width="16" />
        </button>
      </div>
    </div>

    <!-- Add Marketplace Modal -->
    <div v-if="showAddMarketplace" class="codex-plugin-modal">
      <div class="codex-plugin-modal-content">
        <div class="codex-plugin-modal-header">
          <span>{{ t('codexPanel.marketplaceAddTitle') }}</span>
          <button
            type="button"
            class="codex-icon-button"
            :title="t('common.close')"
            @click="closeAddMarketplace"
          >
            <Icon icon="mdi:close" width="14" />
          </button>
        </div>
        <label class="codex-plugin-field">
          <span>{{ t('codexPanel.marketplacePath') }}</span>
          <input
            v-model="marketplacePath"
            class="codex-input"
            type="text"
            :placeholder="t('codexPanel.marketplaceUrl')"
            @keydown.enter.prevent="submitAddMarketplace"
          />
        </label>
        <div class="codex-plugin-modal-actions">
          <button type="button" class="codex-small-text-button" @click="closeAddMarketplace">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="codex-primary-button"
            :disabled="!marketplacePath.trim() || submitting"
            @click="submitAddMarketplace"
          >
            {{ submitting ? t('common.processing') : t('common.add') }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="api.pluginsLoading.value" class="codex-empty">
      {{ t('common.loading') }}
    </div>
    <div v-else-if="api.plugins.value.length === 0" class="codex-empty">
      {{ api.connected.value ? t('codexPanel.pluginsNoPlugins') : t('codexPanel.connectToLoad') }}
    </div>
    <div v-else class="codex-plugin-list">
      <div
        v-for="plugin in api.plugins.value"
        :key="plugin.id"
        class="codex-plugin-card"
        :class="{ 'is-enabled': plugin.isEnabled, 'is-installed': plugin.state === 'installed' }"
      >
        <div class="codex-plugin-header">
          <div class="codex-plugin-title-wrap">
            <Icon
              :icon="plugin.isEnabled ? 'mdi:puzzle-check' : 'mdi:puzzle'"
              width="16"
              :class="plugin.isEnabled ? 'codex-plugin-icon-enabled' : 'codex-plugin-icon'"
            />
            <span class="codex-plugin-name">{{ plugin.name }}</span>
          </div>
          <div class="codex-plugin-status">
            <span v-if="plugin.isEnabled" class="codex-plugin-badge is-enabled">
              {{ t('codexPanel.pluginsInstalled') }}
            </span>
            <span v-else-if="plugin.state === 'installed'" class="codex-plugin-badge is-installed">
              {{ t('codexPanel.pluginsInstalled') }}
            </span>
            <span v-else class="codex-plugin-badge is-available">
              {{ t('codexPanel.pluginsFeatured') }}
            </span>
          </div>
        </div>
        <p v-if="plugin.description" class="codex-plugin-description">
          {{ plugin.description }}
        </p>
        <div class="codex-plugin-actions">
          <button
            v-if="!plugin.isEnabled && plugin.state !== 'installed'"
            type="button"
            class="codex-small-text-button"
            :disabled="!api.connected.value || actingPlugin === plugin.name"
            @click="installPlugin(plugin)"
          >
            <Icon icon="mdi:download" width="14" />
            {{ actingPlugin === plugin.name ? t('codexPanel.pluginsInstalling') : t('codexPanel.pluginsInstall') }}
          </button>
          <button
            v-else
            type="button"
            class="codex-small-text-button danger"
            :disabled="!api.connected.value || actingPlugin === plugin.name"
            @click="uninstallPlugin(plugin)"
          >
            <Icon icon="mdi:delete" width="14" />
            {{ actingPlugin === plugin.name ? t('codexPanel.pluginsUninstalling') : t('codexPanel.pluginsUninstall') }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { Icon } from '@iconify/vue';
import { useI18n } from 'vue-i18n';
import type { CodexPlugin } from '../../backends/codex/codexAdapter';
import { useCodexApi } from '../../composables/useCodexApi';

const props = defineProps<{
  api: ReturnType<typeof useCodexApi>;
}>();

const { t } = useI18n();

const showAddMarketplace = ref(false);
const marketplacePath = ref('');
const submitting = ref(false);
const actingPlugin = ref<string>('');

function closeAddMarketplace() {
  showAddMarketplace.value = false;
  marketplacePath.value = '';
}

async function submitAddMarketplace() {
  const path = marketplacePath.value.trim();
  if (!path || submitting.value) return;
  submitting.value = true;
  try {
    await props.api.addMarketplace({ path });
    closeAddMarketplace();
    await props.api.refreshPlugins();
  } catch {
    // errors handled by adapter / ui
  } finally {
    submitting.value = false;
  }
}

function getMarketplacePath(plugin: CodexPlugin): string {
  if (plugin.source?.type === 'local' && plugin.source.path) {
    return plugin.source.path;
  }
  if (plugin.source?.type === 'git' && plugin.source.path) {
    return plugin.source.path;
  }
  return '';
}

async function installPlugin(plugin: CodexPlugin) {
  if (actingPlugin.value) return;
  actingPlugin.value = plugin.name;
  try {
    await props.api.installPlugin(getMarketplacePath(plugin), plugin.name);
  } catch {
    // errors handled by adapter
  } finally {
    actingPlugin.value = '';
  }
}

async function uninstallPlugin(plugin: CodexPlugin) {
  if (actingPlugin.value) return;
  actingPlugin.value = plugin.name;
  try {
    await props.api.uninstallPlugin(getMarketplacePath(plugin), plugin.name);
  } catch {
    // errors handled by adapter
  } finally {
    actingPlugin.value = '';
  }
}
</script>

<style scoped>
.codex-plugin-manager {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  min-height: 0;
}

.codex-plugin-tools {
  display: flex;
  align-items: center;
  gap: 8px;
}

.codex-plugin-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
  overflow: auto;
}

.codex-plugin-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
  border-radius: 12px;
  background: rgba(15, 23, 42, 0.35);
}

.codex-plugin-card.is-enabled {
  border-color: rgba(74, 222, 128, 0.3);
  background: rgba(6, 78, 59, 0.15);
}

.codex-plugin-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.codex-plugin-title-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.codex-plugin-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--theme-text-primary, #e2e8f0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.codex-plugin-icon {
  flex-shrink: 0;
  color: var(--theme-text-muted, #94a3b8);
}

.codex-plugin-icon-enabled {
  flex-shrink: 0;
  color: var(--theme-status-success, #4ade80);
}

.codex-plugin-status {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
}

.codex-plugin-badge {
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.codex-plugin-badge.is-enabled {
  background: rgba(74, 222, 128, 0.2);
  color: var(--theme-status-success, #4ade80);
}

.codex-plugin-badge.is-installed {
  background: rgba(96, 165, 250, 0.2);
  color: var(--theme-accent-primary, #93c5fd);
}

.codex-plugin-badge.is-available {
  background: rgba(148, 163, 184, 0.15);
  color: var(--theme-text-muted, #94a3b8);
}

.codex-plugin-description {
  margin: 0;
  font-size: 11px;
  line-height: 1.45;
  color: var(--theme-text-muted, #94a3b8);
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.codex-plugin-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: auto;
  padding-top: 4px;
}

.codex-plugin-modal {
  position: fixed;
  inset: 0;
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
}

.codex-plugin-modal-content {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 100%;
  max-width: 420px;
  margin: 20px;
  padding: 16px;
  border: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
  border-radius: 14px;
  background: var(--theme-floating-surface-base, rgba(15, 23, 42, 0.98));
  color: var(--theme-floating-text, #e2e8f0);
}

.codex-plugin-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 14px;
  font-weight: 700;
  color: var(--theme-text-primary, #e2e8f0);
}

.codex-plugin-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 12px;
  color: var(--theme-text-muted, #94a3b8);
}

.codex-plugin-field .codex-input {
  width: 100%;
  min-width: 0;
  border: 1px solid var(--theme-border, rgba(148, 163, 184, 0.24));
  border-radius: 10px;
  appearance: none;
  outline: none;
  background: var(--theme-input-bg, rgba(2, 6, 23, 0.65));
  color: var(--theme-text-primary, #e2e8f0);
  padding: 0 10px;
  height: 34px;
}

.codex-plugin-field .codex-input:focus {
  border-color: var(--theme-accent-primary, #60a5fa);
}

.codex-plugin-modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 4px;
}

.codex-primary-button {
  height: 34px;
  padding: 0 14px;
  font-weight: 700;
  background: var(--theme-accent-primary, #2563eb);
  border: 1px solid transparent;
  border-radius: 10px;
  color: var(--theme-text-primary, #e2e8f0);
  cursor: pointer;
}

.codex-primary-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
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

.codex-small-text-button.danger {
  color: var(--theme-status-error, #f87171);
}

.codex-small-text-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.codex-small-button {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--theme-border, rgba(148, 163, 184, 0.24));
  border-radius: 10px;
  background: var(--theme-button-bg, rgba(30, 41, 59, 0.82));
  color: var(--theme-text-primary, #e2e8f0);
  cursor: pointer;
}

.codex-small-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.codex-icon-button {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--theme-border, rgba(148, 163, 184, 0.24));
  border-radius: 10px;
  background: transparent;
  color: var(--theme-text-primary, #e2e8f0);
  cursor: pointer;
}

.codex-empty {
  color: var(--theme-text-muted, #94a3b8);
  font-size: 12px;
}
</style>

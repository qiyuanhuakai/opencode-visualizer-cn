<template>
  <section class="codex-mcp-manager" :aria-label="t('codexPanel.mcpTitle')">
    <div class="codex-section-title">
      <span>{{ t('codexPanel.mcpTitle') }}</span>
      <div class="codex-mcp-tools">
        <button
          type="button"
          class="codex-small-text-button"
          :disabled="!api.connected.value || api.mcpServersLoading.value"
          :title="t('codexPanel.mcpReloadConfig')"
          @click="api.reloadMcpConfig()"
        >
          {{ t('codexPanel.mcpReloadConfig') }}
        </button>
        <button
          type="button"
          class="codex-small-button"
          :disabled="!api.connected.value || api.mcpServersLoading.value"
          :title="t('common.refresh')"
          @click="api.refreshMcpServers()"
        >
          <Icon icon="mdi:refresh" width="16" :class="{ 'codex-spin': api.mcpServersLoading.value }" />
        </button>
      </div>
    </div>

    <div v-if="api.mcpServersLoading.value" class="codex-empty">
      {{ t('common.loading') }}
    </div>
    <div v-else-if="api.mcpServers.value.length === 0" class="codex-empty">
      {{ api.connected.value ? t('codexPanel.mcpNoServers') : t('codexPanel.connectToLoad') }}
    </div>
    <div v-else class="codex-mcp-list">
      <div
        v-for="server in api.mcpServers.value"
        :key="server.name"
        class="codex-mcp-item"
      >
        <div class="codex-mcp-header">
          <div class="codex-mcp-info">
            <span class="codex-mcp-name">{{ server.name }}</span>
            <span
              class="codex-mcp-status-badge"
              :class="`is-${server.status}`"
            >
              {{ server.status }}
            </span>
          </div>
          <div class="codex-mcp-actions">
            <button
              v-if="server.auth?.type === 'oauth' && server.auth?.status === 'required'"
              type="button"
              class="codex-small-text-button"
              :disabled="!api.connected.value"
              @click="handleOauthLogin(server.name)"
            >
              <Icon icon="mdi:login" width="14" />
              {{ t('codexPanel.mcpOAuthLogin') }}
            </button>
            <button
              type="button"
              class="codex-small-button"
              :title="expanded.has(server.name) ? t('common.collapse') : t('common.expand')"
              @click="toggleExpand(server.name)"
            >
              <Icon
                :icon="expanded.has(server.name) ? 'mdi:chevron-up' : 'mdi:chevron-down'"
                width="16"
              />
            </button>
          </div>
        </div>

        <p v-if="server.error" class="codex-mcp-error">
          <Icon icon="mdi:alert-circle" width="14" />
          {{ server.error }}
        </p>

        <div v-if="expanded.has(server.name)" class="codex-mcp-details">
          <div v-if="server.tools && server.tools.length > 0" class="codex-mcp-tools-section">
            <span class="codex-mcp-detail-label">
              {{ t('codexPanel.mcpTools') }} ({{ server.tools.length }})
            </span>
            <ul class="codex-mcp-tools-list">
              <li v-for="tool in server.tools" :key="tool.name" class="codex-mcp-tool-item">
                <span class="codex-mcp-tool-name">{{ tool.name }}</span>
                <span v-if="tool.description" class="codex-mcp-tool-description">
                  {{ tool.description }}
                </span>
              </li>
            </ul>
          </div>

          <div v-if="server.resources && server.resources.length > 0" class="codex-mcp-resources-section">
            <span class="codex-mcp-detail-label">
              {{ t('codexPanel.mcpResources') }} ({{ server.resources.length }})
            </span>
            <ul class="codex-mcp-resources-list">
              <li v-for="resource in server.resources" :key="resource.name" class="codex-mcp-resource-item">
                <span class="codex-mcp-resource-name">{{ resource.name }}</span>
                <span v-if="resource.mimeType" class="codex-mcp-resource-mime">
                  {{ resource.mimeType }}
                </span>
              </li>
            </ul>
          </div>

          <div v-if="server.auth" class="codex-mcp-auth-section">
            <span class="codex-mcp-detail-label">{{ t('codexPanel.mcpAuth') }}</span>
            <div class="codex-mcp-auth-info">
              <span class="codex-mcp-auth-type">{{ server.auth.type }}</span>
              <span class="codex-mcp-auth-status" :class="`is-${server.auth.status}`">
                {{ server.auth.status }}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { Icon } from '@iconify/vue';
import { useI18n } from 'vue-i18n';
import type { useCodexApi } from '../../composables/useCodexApi';

const { t } = useI18n();

const props = defineProps<{
  api: ReturnType<typeof useCodexApi>;
}>();

const expanded = ref<Set<string>>(new Set());

function toggleExpand(serverName: string) {
  const next = new Set(expanded.value);
  if (next.has(serverName)) {
    next.delete(serverName);
  } else {
    next.add(serverName);
  }
  expanded.value = next;
}

async function handleOauthLogin(serverName: string) {
  try {
    const result = await props.api.mcpOauthLogin(serverName);
    if (result?.authUrl) {
      window.open(result.authUrl, '_blank');
    }
  } catch {
    // Error handling is implicitly managed by the adapter
  }
}
</script>

<style scoped>
.codex-mcp-manager {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  min-height: 0;
}

.codex-mcp-tools {
  display: flex;
  gap: 6px;
  align-items: center;
}

.codex-mcp-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: auto;
}

.codex-mcp-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.35);
}

.codex-mcp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.codex-mcp-info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.codex-mcp-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--theme-text-primary, #e2e8f0);
  word-break: break-word;
}

.codex-mcp-status-badge {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  flex-shrink: 0;
}

.codex-mcp-status-badge.is-starting {
  background: rgba(251, 191, 36, 0.2);
  color: var(--theme-status-warning, #fbbf24);
}

.codex-mcp-status-badge.is-started {
  background: rgba(74, 222, 128, 0.2);
  color: var(--theme-status-success, #4ade80);
}

.codex-mcp-status-badge.is-stopped {
  background: rgba(148, 163, 184, 0.2);
  color: var(--theme-text-muted, #94a3b8);
}

.codex-mcp-status-badge.is-error {
  background: rgba(248, 113, 113, 0.2);
  color: var(--theme-status-error, #f87171);
}

.codex-mcp-actions {
  display: flex;
  gap: 4px;
  align-items: center;
  flex-shrink: 0;
}

.codex-mcp-error {
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

.codex-mcp-details {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.12));
}

.codex-mcp-detail-label {
  font-size: 10px;
  color: var(--theme-text-muted, #94a3b8);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}

.codex-mcp-tools-section,
.codex-mcp-resources-section,
.codex-mcp-auth-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.codex-mcp-tools-list,
.codex-mcp-resources-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.codex-mcp-tool-item,
.codex-mcp-resource-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(2, 6, 23, 0.35);
}

.codex-mcp-tool-name,
.codex-mcp-resource-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--theme-text-primary, #e2e8f0);
}

.codex-mcp-tool-description {
  font-size: 11px;
  color: var(--theme-text-muted, #94a3b8);
  line-height: 1.4;
}

.codex-mcp-resource-mime {
  font-size: 10px;
  color: var(--theme-accent-primary, #93c5fd);
}

.codex-mcp-auth-info {
  display: flex;
  align-items: center;
  gap: 8px;
}

.codex-mcp-auth-type {
  padding: 2px 8px;
  border-radius: 6px;
  font-size: 11px;
  background: rgba(96, 165, 250, 0.15);
  color: var(--theme-accent-primary, #93c5fd);
  text-transform: uppercase;
}

.codex-mcp-auth-status {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
}

.codex-mcp-auth-status.is-required {
  background: rgba(248, 113, 113, 0.2);
  color: var(--theme-status-error, #f87171);
}

.codex-mcp-auth-status.is-pending {
  background: rgba(251, 191, 36, 0.2);
  color: var(--theme-status-warning, #fbbf24);
}

.codex-mcp-auth-status.is-completed {
  background: rgba(74, 222, 128, 0.2);
  color: var(--theme-status-success, #4ade80);
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

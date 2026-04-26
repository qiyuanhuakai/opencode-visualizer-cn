<template>
  <section class="codex-app-manager" :aria-label="t('codexPanel.appsTitle')">
    <div class="codex-section-title">
      <span>{{ t('codexPanel.appsTitle') }}</span>
      <div class="codex-app-tools">
        <button
          type="button"
          class="codex-small-button"
          :disabled="!api.connected.value || api.appsLoading.value"
          :title="t('common.refresh')"
          @click="api.refreshApps()"
        >
          <Icon icon="mdi:refresh" width="16" />
        </button>
      </div>
    </div>

    <div v-if="api.appsLoading.value" class="codex-empty">
      {{ t('common.loading') }}
    </div>
    <div v-else-if="api.apps.value.length === 0" class="codex-empty">
      {{ api.connected.value ? t('codexPanel.appsNoApps') : t('codexPanel.connectToLoad') }}
    </div>
    <div v-else class="codex-app-list">
      <div
        v-for="app in api.apps.value"
        :key="app.id"
        class="codex-app-item"
      >
        <div class="codex-app-header">
          <span class="codex-app-name">{{ app.name }}</span>
          <span
            class="codex-app-badge"
            :class="app.isAccessible ? 'is-accessible' : 'is-not-accessible'"
          >
            {{ app.isAccessible ? t('codexPanel.appAccessible') : t('codexPanel.appNotAccessible') }}
          </span>
          <span
            class="codex-app-badge"
            :class="app.isEnabled ? 'is-enabled' : 'is-disabled'"
          >
            {{ app.isEnabled ? t('codexPanel.appEnabled') : t('codexPanel.appDisabled') }}
          </span>
        </div>
        <div class="codex-app-meta">
          <span v-if="app.description" class="codex-app-description">
            {{ app.description }}
          </span>
          <a
            v-if="app.installUrl"
            class="codex-app-install-url"
            :href="app.installUrl"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Icon icon="mdi:open-in-new" width="12" />
            {{ t('codexPanel.appInstallUrl') }}
          </a>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { Icon } from '@iconify/vue';
import { useI18n } from 'vue-i18n';
import { useCodexApi } from '../../composables/useCodexApi';

const props = defineProps<{
  api: ReturnType<typeof useCodexApi>;
}>();

const { t } = useI18n();
</script>

<style scoped>
.codex-app-manager {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  min-height: 0;
}

.codex-app-tools {
  display: flex;
  align-items: center;
  gap: 10px;
}

.codex-app-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow: auto;
}

.codex-app-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.35);
}

.codex-app-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.codex-app-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--theme-text-primary, #e2e8f0);
}

.codex-app-badge {
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.codex-app-badge.is-accessible {
  background: rgba(74, 222, 128, 0.2);
  color: var(--theme-status-success, #4ade80);
}

.codex-app-badge.is-not-accessible {
  background: rgba(148, 163, 184, 0.15);
  color: var(--theme-text-muted, #94a3b8);
}

.codex-app-badge.is-enabled {
  background: rgba(37, 99, 235, 0.2);
  color: var(--theme-accent-primary, #93c5fd);
}

.codex-app-badge.is-disabled {
  background: rgba(148, 163, 184, 0.15);
  color: var(--theme-text-muted, #94a3b8);
}

.codex-app-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--theme-text-muted, #94a3b8);
}

.codex-app-description {
  line-height: 1.45;
}

.codex-app-install-url {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--theme-accent-primary, #93c5fd);
  text-decoration: none;
}

.codex-app-install-url:hover {
  text-decoration: underline;
}

.codex-empty {
  color: var(--theme-text-muted, #94a3b8);
  font-size: 12px;
}
</style>

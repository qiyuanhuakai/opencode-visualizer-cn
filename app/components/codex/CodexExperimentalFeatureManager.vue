<template>
  <section class="codex-experimental-feature-manager" :aria-label="t('codexPanel.experimentalFeaturesTitle')">
    <div class="codex-section-title">
      <span>{{ t('codexPanel.experimentalFeaturesTitle') }}</span>
      <div class="codex-experimental-feature-tools">
        <button
          type="button"
          class="codex-small-button"
          :disabled="!api.connected.value || api.experimentalFeaturesLoading.value"
          :title="t('common.refresh')"
          @click="api.refreshExperimentalFeatures()"
        >
          <Icon icon="mdi:refresh" width="16" :class="{ 'codex-spin': api.experimentalFeaturesLoading.value }" />
        </button>
      </div>
    </div>

    <div v-if="api.experimentalFeaturesLoading.value" class="codex-empty">
      {{ t('common.loading') }}
    </div>
    <div v-else-if="api.experimentalFeatures.value.length === 0" class="codex-empty">
      {{ api.connected.value ? t('codexPanel.experimentalFeaturesNoFeatures') : t('codexPanel.connectToLoad') }}
    </div>
    <div v-else class="codex-experimental-feature-list">
      <div
        v-for="feature in api.experimentalFeatures.value"
        :key="feature.name"
        class="codex-experimental-feature-item"
      >
        <div class="codex-experimental-feature-header">
          <div class="codex-experimental-feature-info">
            <div class="codex-experimental-feature-name-row">
              <span class="codex-experimental-feature-name">
                {{ feature.displayName || feature.name }}
              </span>
              <span
                class="codex-experimental-feature-stage"
                :class="`is-stage-${feature.stage}`"
              >
                {{ feature.stage }}
              </span>
            </div>
            <span v-if="feature.description" class="codex-experimental-feature-description">
              {{ feature.description }}
            </span>
          </div>
          <label class="codex-experimental-feature-toggle">
            <input
              type="checkbox"
              :checked="feature.enabled"
              :disabled="!api.connected.value"
              @change="api.setExperimentalFeatureEnablement(feature.name, ($event.target as HTMLInputElement).checked)"
            />
            <span class="codex-experimental-feature-toggle-slider" />
          </label>
        </div>
        <div class="codex-experimental-feature-meta">
          <span class="codex-experimental-feature-default">
            {{ t('codexPanel.featureDefaultEnabled') }}: {{ feature.defaultEnabled ? t('codexPanel.featureEnabled') : t('codexPanel.featureDisabled') }}
          </span>
        </div>
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
.codex-experimental-feature-manager {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  min-height: 0;
}

.codex-experimental-feature-tools {
  display: flex;
  gap: 6px;
}

.codex-experimental-feature-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  overflow: auto;
}

.codex-experimental-feature-item {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.35);
  transition: border-color 0.2s ease;
}

.codex-experimental-feature-item:hover {
  background: rgba(15, 23, 42, 0.55);
}

.codex-experimental-feature-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.codex-experimental-feature-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  flex: 1 1 auto;
}

.codex-experimental-feature-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.codex-experimental-feature-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--theme-text-primary, #e2e8f0);
  word-break: break-word;
}

.codex-experimental-feature-stage {
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  flex-shrink: 0;
}

.codex-experimental-feature-stage.is-stage-beta {
  background: rgba(37, 99, 235, 0.2);
  color: var(--theme-accent-primary, #93c5fd);
}

.codex-experimental-feature-stage.is-stage-underDevelopment {
  background: rgba(245, 158, 11, 0.2);
  color: #fbbf24;
}

.codex-experimental-feature-stage.is-stage-stable {
  background: rgba(34, 197, 94, 0.2);
  color: #4ade80;
}

.codex-experimental-feature-stage.is-stage-deprecated {
  background: rgba(234, 179, 8, 0.2);
  color: #facc15;
}

.codex-experimental-feature-stage.is-stage-removed {
  background: rgba(239, 68, 68, 0.2);
  color: #f87171;
}

.codex-experimental-feature-description {
  font-size: 12px;
  line-height: 1.45;
  color: var(--theme-text-secondary, #cbd5e1);
  word-break: break-word;
}

.codex-experimental-feature-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--theme-text-muted, #94a3b8);
}

.codex-experimental-feature-toggle {
  position: relative;
  display: inline-flex;
  align-items: center;
  width: 40px;
  height: 22px;
  flex-shrink: 0;
  cursor: pointer;
}

.codex-experimental-feature-toggle input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.codex-experimental-feature-toggle-slider {
  position: absolute;
  inset: 0;
  border-radius: 999px;
  background: var(--theme-border, rgba(148, 163, 184, 0.35));
  transition: background 0.2s ease;
}

.codex-experimental-feature-toggle-slider::before {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--theme-text-primary, #e2e8f0);
  transition: transform 0.2s ease;
}

.codex-experimental-feature-toggle input:checked + .codex-experimental-feature-toggle-slider {
  background: rgba(74, 222, 128, 0.45);
}

.codex-experimental-feature-toggle input:checked + .codex-experimental-feature-toggle-slider::before {
  transform: translateX(18px);
  background: #4ade80;
}

.codex-experimental-feature-toggle input:disabled + .codex-experimental-feature-toggle-slider {
  opacity: 0.5;
  cursor: not-allowed;
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

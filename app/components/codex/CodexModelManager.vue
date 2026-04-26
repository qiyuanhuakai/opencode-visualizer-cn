<template>
  <section class="codex-model-manager" :aria-label="t('codexPanel.modelsTitle')">
    <div class="codex-section-title">
      <span>{{ t('codexPanel.modelsTitle') }}</span>
      <div class="codex-model-tools">
        <label class="codex-toggle-label">
          <input
            v-model="includeHidden"
            type="checkbox"
            :disabled="!api.connected.value || api.modelsLoading.value"
            @change="onToggleHidden"
          />
          <span>{{ t('codexPanel.modelsIncludeHidden') }}</span>
        </label>
        <button
          type="button"
          class="codex-small-button"
          :disabled="!api.connected.value || api.modelsLoading.value"
          :title="t('common.refresh')"
          @click="api.refreshModels(includeHidden)"
        >
          <Icon icon="mdi:refresh" width="16" />
        </button>
      </div>
    </div>

    <div v-if="api.modelsLoading.value" class="codex-empty">
      {{ t('common.loading') }}
    </div>
    <div v-else-if="api.models.value.length === 0" class="codex-empty">
      {{ api.connected.value ? t('codexPanel.modelsNoModels') : t('codexPanel.connectToLoad') }}
    </div>
    <div v-else class="codex-model-list">
      <div
        v-for="model in api.models.value"
        :key="model.id"
        class="codex-model-item"
        :class="{ 'is-hidden': model.hidden, 'is-selected': api.selectedModel.value === model.id }"
        @click="api.selectModel(model.id)"
      >
        <div class="codex-model-header">
          <span class="codex-model-name">{{ model.displayName || model.model || model.id }}</span>
          <span v-if="model.isDefault" class="codex-model-badge is-default">
            {{ t('codexPanel.modelsDefault') }}
          </span>
          <span v-if="model.hidden" class="codex-model-badge is-hidden">
            {{ t('codexPanel.modelsHidden') }}
          </span>
        </div>
        <div class="codex-model-meta">
          <span class="codex-model-id" :title="model.id">{{ model.id }}</span>
          <span v-if="model.inputModalities?.length" class="codex-model-modalities">
            <Icon icon="mdi:chip" width="12" />
            {{ model.inputModalities.join(', ') }}
          </span>
          <span v-if="model.supportsPersonality" class="codex-model-personality">
            <Icon icon="mdi:account-voice" width="12" />
            {{ t('codexPanel.modelsPersonality') }}
          </span>
        </div>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { Icon } from '@iconify/vue';
import { useI18n } from 'vue-i18n';
import { useCodexApi } from '../../composables/useCodexApi';

const props = defineProps<{
  api: ReturnType<typeof useCodexApi>;
}>();

const { t } = useI18n();
const includeHidden = ref(false);

function onToggleHidden() {
  props.api.refreshModels(includeHidden.value);
}
</script>

<style scoped>
.codex-model-manager {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  min-height: 0;
}

.codex-model-tools {
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

.codex-model-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow: auto;
}

.codex-model-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
  border-radius: 10px;
  background: rgba(15, 23, 42, 0.35);
  cursor: pointer;
}

.codex-model-item:hover {
  background: rgba(15, 23, 42, 0.55);
}

.codex-model-item.is-selected {
  border-color: var(--theme-accent-primary, #60a5fa);
  background: rgba(37, 99, 235, 0.15);
}

.codex-model-item.is-hidden {
  opacity: 0.7;
  border-style: dashed;
}

.codex-model-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.codex-model-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--theme-text-primary, #e2e8f0);
}

.codex-model-badge {
  padding: 1px 6px;
  border-radius: 4px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.codex-model-badge.is-default {
  background: rgba(37, 99, 235, 0.2);
  color: var(--theme-accent-primary, #93c5fd);
}

.codex-model-badge.is-hidden {
  background: rgba(148, 163, 184, 0.15);
  color: var(--theme-text-muted, #94a3b8);
}

.codex-model-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  font-size: 11px;
  color: var(--theme-text-muted, #94a3b8);
}

.codex-model-id {
  font-family: var(--app-monospace-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
}

.codex-model-modalities,
.codex-model-personality {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.codex-empty {
  color: var(--theme-text-muted, #94a3b8);
  font-size: 12px;
}
</style>

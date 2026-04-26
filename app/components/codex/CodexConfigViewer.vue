<template>
  <section class="codex-config-viewer" :aria-label="t('codexPanel.configTitle')">
    <!-- Toolbar -->
    <div class="codex-config-toolbar">
      <button
        type="button"
        class="codex-small-button"
        :disabled="api.configLoading.value"
        :title="t('codexPanel.configRefresh')"
        @click="api.refreshConfig()"
      >
        <Icon
          icon="mdi:refresh"
          width="16"
          :class="{ 'codex-spin': api.configLoading.value }"
        />
      </button>
      <label class="codex-config-toggle">
        <input
          v-model="includeLayers"
          type="checkbox"
          :disabled="api.configLoading.value"
          @change="onIncludeLayersChange"
        />
        <span>{{ t('codexPanel.configIncludeLayers') }}</span>
      </label>
      <span v-if="api.configLoading.value" class="codex-config-loading">
        {{ t('common.loading') }}
      </span>
    </div>

    <!-- Empty state -->
    <div v-if="!api.config.value && !api.configLoading.value" class="codex-config-empty">
      {{ t('codexPanel.configNoConfig') }}
    </div>

    <!-- JSON Tree -->
    <div v-else-if="api.config.value" class="codex-config-tree">
      <!-- Merged config -->
      <div class="codex-config-section">
        <div class="codex-config-section-header" @click="toggleSection('config')">
          <Icon
            :icon="expandedSections.has('config') ? 'mdi:chevron-down' : 'mdi:chevron-right'"
            width="14"
          />
          <span class="codex-config-section-title">{{ t('codexPanel.configMerged') }}</span>
        </div>
        <div v-if="expandedSections.has('config')" class="codex-config-section-body">
          <CodexJsonTreeNode :data="api.config.value.config" name="config" :depth="0" />
        </div>
      </div>

      <!-- Layers -->
      <div v-if="includeLayers && api.config.value.layers" class="codex-config-section">
        <div class="codex-config-section-header" @click="toggleSection('layers')">
          <Icon
            :icon="expandedSections.has('layers') ? 'mdi:chevron-down' : 'mdi:chevron-right'"
            width="14"
          />
          <span class="codex-config-section-title">
            {{ t('codexPanel.configLayers') }} ({{ api.config.value.layers.length }})
          </span>
        </div>
        <div v-if="expandedSections.has('layers')" class="codex-config-section-body">
          <div
            v-for="(layer, index) in api.config.value.layers"
            :key="index"
            class="codex-config-layer"
          >
            <div class="codex-config-layer-header" @click="toggleLayer(index)">
              <Icon
                :icon="expandedLayers.has(index) ? 'mdi:chevron-down' : 'mdi:chevron-right'"
                width="12"
              />
              <span class="codex-config-layer-source">{{ layer.source }}</span>
            </div>
            <div v-if="expandedLayers.has(index)" class="codex-config-layer-body">
              <CodexJsonTreeNode :data="layer.config" :name="`layer[${index}]`" :depth="0" />
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
import CodexJsonTreeNode from './CodexJsonTreeNode.vue';
import type { useCodexApi } from '../../composables/useCodexApi';

const { t } = useI18n();

const props = defineProps<{
  api: ReturnType<typeof useCodexApi>;
}>();

const includeLayers = ref(false);
const expandedSections = ref(new Set(['config']));
const expandedLayers = ref(new Set<number>());

function toggleSection(section: string) {
  const next = new Set(expandedSections.value);
  if (next.has(section)) {
    next.delete(section);
  } else {
    next.add(section);
  }
  expandedSections.value = next;
}

function toggleLayer(index: number) {
  const next = new Set(expandedLayers.value);
  if (next.has(index)) {
    next.delete(index);
  } else {
    next.add(index);
  }
  expandedLayers.value = next;
}

function onIncludeLayersChange() {
  if (includeLayers.value) {
    expandedSections.value.add('layers');
  }
  props.api.refreshConfig();
}
</script>

<style scoped>
.codex-config-viewer {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  color: var(--theme-floating-text, #e2e8f0);
  background: var(--theme-floating-surface-base, rgba(15, 23, 42, 0.96));
  font-family: var(--app-monospace-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
}

.codex-config-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
  flex-shrink: 0;
}

.codex-small-button {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--theme-border, rgba(148, 163, 184, 0.24));
  border-radius: 10px;
  appearance: none;
  outline: none;
  color: var(--theme-text-primary, #e2e8f0);
  background: var(--theme-button-bg, rgba(30, 41, 59, 0.82));
  cursor: pointer;
}

.codex-small-button:disabled {
  cursor: not-allowed;
  opacity: 0.55;
}

.codex-spin {
  animation: codex-spin 1s linear infinite;
}

@keyframes codex-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.codex-config-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--theme-text-muted, #94a3b8);
  cursor: pointer;
  user-select: none;
}

.codex-config-toggle input {
  cursor: pointer;
}

.codex-config-loading {
  margin-left: auto;
  font-size: 11px;
  color: var(--theme-text-muted, #94a3b8);
}

.codex-config-empty {
  padding: 20px 12px;
  text-align: center;
  font-size: 12px;
  color: var(--theme-text-muted, #94a3b8);
}

.codex-config-tree {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px 0;
}

.codex-config-section {
  margin-bottom: 4px;
}

.codex-config-section-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  color: var(--theme-text-primary, #e2e8f0);
  user-select: none;
  transition: background 0.12s ease;
}

.codex-config-section-header:hover {
  background: rgba(148, 163, 184, 0.08);
}

.codex-config-section-title {
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.codex-config-section-body {
  padding: 4px 0;
}

.codex-config-layer {
  margin-bottom: 2px;
}

.codex-config-layer-header {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 12px 4px 24px;
  cursor: pointer;
  font-size: 11px;
  color: var(--theme-accent-primary, #93c5fd);
  user-select: none;
  transition: background 0.12s ease;
}

.codex-config-layer-header:hover {
  background: rgba(148, 163, 184, 0.06);
}

.codex-config-layer-source {
  font-weight: 500;
}

.codex-config-layer-body {
  padding: 2px 0;
}

/* Tree node styles */
.codex-tree-node {
  font-size: 12px;
  line-height: 1.6;
}

.codex-tree-header {
  display: flex;
  align-items: center;
  gap: 2px;
  cursor: pointer;
  user-select: none;
  padding: 1px 12px;
  transition: background 0.08s ease;
}

.codex-tree-header:hover {
  background: rgba(148, 163, 184, 0.06);
}

.codex-tree-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  flex-shrink: 0;
  color: var(--theme-text-muted, #94a3b8);
}

.codex-tree-leaf {
  padding: 1px 12px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.codex-tree-key {
  color: var(--theme-accent-primary, #93c5fd);
  font-weight: 500;
}

.codex-tree-bracket {
  color: var(--theme-text-muted, #94a3b8);
}

.codex-tree-ellipsis {
  color: var(--theme-text-muted, #94a3b8);
  font-style: italic;
}

.codex-tree-string {
  color: var(--theme-status-success, #86efac);
}

.codex-tree-number {
  color: var(--theme-status-warning, #fbbf24);
}

.codex-tree-boolean {
  color: var(--theme-accent-primary, #60a5fa);
}

.codex-tree-null {
  color: var(--theme-text-muted, #94a3b8);
  font-style: italic;
}

.codex-tree-closer {
  padding: 1px 12px;
  display: flex;
  align-items: center;
}
</style>

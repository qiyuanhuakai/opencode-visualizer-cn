<template>
  <section class="codex-workspace-tools" :aria-label="t('codexPanel.fileManagerTitle')">
    <div class="codex-workspace-tools-header">
      <span class="codex-workspace-tools-title">{{ t('codexPanel.fileManagerTitle') }}</span>
      <span class="codex-workspace-tools-cwd" :title="api.fsCwd.value || api.sandboxPath.value || ''">
        {{ api.fsCwd.value || api.sandboxPath.value || '/' }}
      </span>
    </div>

    <div class="codex-workspace-tools-toolbar">
      <input
        v-model="api.sandboxPath.value"
        class="codex-input codex-sandbox-input"
        type="text"
        :disabled="!api.connected.value"
        :placeholder="t('codexPanel.fsPathPlaceholder')"
        @keydown.enter.prevent="api.openAsSandbox(api.sandboxPath.value)"
        @keydown.tab.prevent="handleSuggestionKeydown"
        @keydown.down.prevent="handleSuggestionKeydown"
        @keydown.up.prevent="handleSuggestionKeydown"
        @keydown.escape.prevent="handleSuggestionKeydown"
        @input="selectedSuggestionIndex = -1; api.updatePathSuggestions(api.sandboxPath.value)"
        @blur="api.hidePathSuggestions()"
      />
      <ul
        v-if="api.fsShowSuggestions.value && api.fsSuggestions.value.length > 0"
        class="codex-fs-suggestions"
      >
        <li
          v-for="(suggestion, index) in api.fsSuggestions.value"
          :key="suggestion"
          :class="{ 'is-selected': index === selectedSuggestionIndex }"
          @mousedown.prevent="selectSuggestion(suggestion)"
        >
          <Icon icon="mdi:folder" width="12" />
          {{ suggestion }}
        </li>
      </ul>
      <button
        type="button"
        class="codex-small-button"
        :disabled="!api.connected.value || !api.sandboxPath.value"
        :title="t('codexPanel.sandboxBrowse')"
        @click="api.openAsSandbox(api.sandboxPath.value)"
      >
        <Icon icon="mdi:folder-open" width="14" />
      </button>
      <button
        type="button"
        class="codex-small-button"
        :disabled="!api.connected.value || !api.sandboxPath.value"
        :title="t('codexPanel.fsNewThreadHere')"
        @click="createThreadInSandbox()"
      >
        <Icon icon="mdi:plus" width="14" />
      </button>
    </div>

    <div v-if="api.fsBreadcrumbs.value.length > 0" class="codex-breadcrumbs">
      <button
        v-for="crumb in api.fsBreadcrumbs.value"
        :key="crumb.path"
        type="button"
        class="codex-breadcrumb-item"
        :disabled="!api.connected.value || api.fsLoading.value"
        @click="api.navigateToPath(crumb.path)"
      >
        {{ crumb.name === '/' ? t('codexPanel.fsBreadcrumbRoot') : crumb.name }}
      </button>
    </div>

    <CodexFsManager :api="api" />

    <button
      v-if="api.fsCwd.value && api.fsCwd.value !== '/'"
      type="button"
      class="codex-sandbox-item codex-parent-dir"
      :disabled="!api.connected.value || api.fsLoading.value"
      @click="api.navigateToParent()"
    >
      <Icon icon="mdi:arrow-up" width="14" />
      <span>{{ t('codexPanel.fsParentDirectory') }}</span>
    </button>

    <div v-if="api.fsLoading.value" class="codex-empty">{{ t('common.loading') }}</div>
    <div v-else-if="api.fsError.value" class="codex-error">{{ api.fsError.value }}</div>
    <div v-else-if="api.fsEntries.value.length === 0" class="codex-empty">{{ t('codexPanel.sandboxEmpty') }}</div>

    <div v-else class="codex-sandbox-list">
      <button
        v-for="entry in api.fsEntries.value"
        :key="entry.fileName"
        type="button"
        class="codex-sandbox-item"
        :class="{ 'is-directory': entry.isDirectory }"
        @click="handleFsEntryClick(entry)"
      >
        <Icon
          :icon="entry.isDirectory ? 'mdi:folder' : 'mdi:file-document-outline'"
          width="14"
          :class="entry.isDirectory ? 'codex-dir-icon' : 'codex-file-icon'"
        />
        <span>{{ entry.fileName }}</span>
      </button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { Icon } from '@iconify/vue';
import { useI18n } from 'vue-i18n';
import type { CodexFsDirectoryEntry } from '../../backends/codex/codexAdapter';
import { useCodexApi } from '../../composables/useCodexApi';
import CodexFsManager from './CodexFsManager.vue';

const props = defineProps<{
  api: ReturnType<typeof useCodexApi>;
  onOpenFilePreview?: (path: string) => void;
}>();

const { t } = useI18n();
const selectedSuggestionIndex = ref(-1);

async function createThreadInSandbox() {
  if (!props.api.sandboxPath.value) return;
  await props.api.createThreadInSandbox();
  props.api.sandboxPath.value = '';
}

async function selectSuggestion(suggestion: string) {
  props.api.sandboxPath.value = suggestion;
  selectedSuggestionIndex.value = -1;
  props.api.hidePathSuggestions();
  await props.api.openAsSandbox(suggestion);
}

function handleSuggestionKeydown(event: KeyboardEvent) {
  const suggestions = props.api.fsSuggestions.value;
  if (suggestions.length === 0) return;

  if (event.key === 'Tab') {
    event.preventDefault();
    if (selectedSuggestionIndex.value >= 0) {
      void selectSuggestion(suggestions[selectedSuggestionIndex.value]!);
    } else if (suggestions[0]) {
      void selectSuggestion(suggestions[0]);
    }
    return;
  }

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    selectedSuggestionIndex.value =
      selectedSuggestionIndex.value < suggestions.length - 1
        ? selectedSuggestionIndex.value + 1
        : 0;
    return;
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault();
    selectedSuggestionIndex.value =
      selectedSuggestionIndex.value > 0
        ? selectedSuggestionIndex.value - 1
        : suggestions.length - 1;
    return;
  }

  if (event.key === 'Escape') {
    selectedSuggestionIndex.value = -1;
    props.api.hidePathSuggestions();
  }
}

function joinFsPath(base: string, name: string): string {
  if (!base || base === '/') return `/${name}`;
  if (base.endsWith('/')) return `${base}${name}`;
  return `${base}/${name}`;
}

async function handleFsEntryClick(entry: CodexFsDirectoryEntry) {
  const path = joinFsPath(props.api.fsCwd.value, entry.fileName);
  if (entry.isDirectory) {
    await props.api.readDirectory(path);
  } else {
    props.onOpenFilePreview?.(path);
  }
}
</script>

<style scoped>
.codex-workspace-tools {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-height: 0;
  height: 100%;
  padding: 12px;
  border: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
  border-radius: 12px;
  background: rgba(15, 23, 42, 0.52);
}

.codex-workspace-tools-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.codex-workspace-tools-title {
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--theme-text-muted, #94a3b8);
}

.codex-workspace-tools-cwd {
  font-size: 12px;
  color: var(--theme-text-primary, #e2e8f0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.codex-workspace-tools-toolbar {
  display: flex;
  gap: 6px;
  align-items: center;
  position: relative;
}

.codex-input {
  width: 100%;
  min-width: 0;
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--theme-border, rgba(148, 163, 184, 0.24));
  border-radius: 10px;
  appearance: none;
  outline: none;
  background: var(--theme-input-bg, rgba(2, 6, 23, 0.65));
  color: var(--theme-text-primary, #e2e8f0);
}

.codex-sandbox-input {
  flex: 1 1 auto;
  position: relative;
  z-index: 10;
}

.codex-small-button,
.codex-breadcrumb-item,
.codex-sandbox-item,
.codex-parent-dir {
  border: 1px solid var(--theme-border, rgba(148, 163, 184, 0.18));
  border-radius: 8px;
  background: var(--theme-button-bg, rgba(30, 41, 59, 0.6));
  color: var(--theme-text-primary, #e2e8f0);
  cursor: pointer;
}

.codex-small-button {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.codex-empty {
  color: var(--theme-text-muted, #94a3b8);
  font-size: 12px;
}

.codex-error {
  margin: 0;
  padding: 8px 12px;
  color: var(--theme-status-error, #f87171);
  background: rgba(127, 29, 29, 0.22);
  border: 1px solid rgba(248, 113, 113, 0.25);
  border-radius: 10px;
}

.codex-fs-suggestions {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  z-index: 100;
  margin: 2px 0 0;
  padding: 4px 0;
  list-style: none;
  background: var(--theme-panel-bg, rgba(30, 41, 59, 0.95));
  border: 1px solid var(--theme-border, rgba(148, 163, 184, 0.18));
  border-radius: 8px;
  max-height: 200px;
  overflow-y: auto;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.codex-fs-suggestions li {
  padding: 6px 12px;
  font-size: 12px;
  color: var(--theme-text-primary, #e2e8f0);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.codex-fs-suggestions li:hover,
.codex-fs-suggestions li.is-selected {
  background: var(--theme-button-hover-bg, rgba(96, 165, 250, 0.15));
}

.codex-breadcrumbs {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  align-items: center;
  font-size: 11px;
}

.codex-breadcrumb-item {
  display: inline-flex;
  align-items: center;
  padding: 2px 6px;
  background: transparent;
  color: var(--theme-text-muted, #94a3b8);
  border: none;
}

.codex-breadcrumb-item:hover {
  background: rgba(148, 163, 184, 0.12);
  color: var(--theme-text-primary, #e2e8f0);
}

.codex-breadcrumb-item:not(:last-child)::after {
  content: '/';
  margin-left: 4px;
  color: var(--theme-text-muted, #94a3b8);
  opacity: 0.5;
}

.codex-sandbox-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 4px;
}

.codex-sandbox-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
}

.codex-sandbox-item:hover,
.codex-parent-dir:hover {
  border-color: var(--theme-accent-primary, #60a5fa);
}

.codex-parent-dir {
  width: 100%;
  justify-content: flex-start;
  border-style: dashed;
  opacity: 0.8;
  padding: 6px 8px;
}

.codex-dir-icon {
  color: var(--theme-accent-primary, #60a5fa);
}

.codex-file-icon {
  color: var(--theme-text-muted, #94a3b8);
}
</style>

<template>
  <aside class="forge-auxiliary-panel" :aria-label="$t('forgePanel.auxiliaryTitle')">
    <header class="forge-auxiliary-header">
      <div class="forge-auxiliary-title-group">
        <div class="forge-auxiliary-title">{{ $t('forgePanel.auxiliaryTitle') }}</div>
        <div v-if="statusText" class="forge-status-chip" data-forge-status-chip>
          <span class="forge-status-label">{{ $t('forgePanel.statusLabel') }}</span>
          <span class="forge-status-value">{{ statusText }}</span>
        </div>
      </div>
      <button
        type="button"
        class="forge-auxiliary-action"
        data-forge-action="refresh-auxiliary"
        :disabled="auxiliary.loading"
        @click="auxiliary.onRefresh"
      >
        {{ $t('forgePanel.refresh') }}
      </button>
    </header>

    <div v-if="auxiliary.error" class="forge-auxiliary-error" role="alert">
      <span class="forge-auxiliary-error-label">{{ $t('forgePanel.errorLabel') }}</span>
      <span>{{ auxiliary.error }}</span>
    </div>
    <div v-else-if="auxiliary.loading" class="forge-auxiliary-loading">
      {{ $t('forgePanel.loading') }}
    </div>

    <div class="forge-sidebar-command-grid" :aria-label="$t('forgePanel.commandGroups.conversation')">
      <button
        v-for="item in sidebarCommands"
        :key="item.action"
        type="button"
        class="forge-auxiliary-action forge-sidebar-command"
        :data-forge-action="item.action"
        @click="sendCommand(item.command)"
      >
        {{ $t(item.labelKey) }}
      </button>
    </div>

    <div class="forge-conversation-list" role="list">
      <button
        v-for="conversation in auxiliary.conversations"
        :key="conversation.id"
        type="button"
        class="forge-conversation-item"
        :class="{ 'is-selected': conversation.id === auxiliary.selectedConversationId }"
        :data-forge-conversation-id="conversation.id"
        :aria-pressed="conversation.id === auxiliary.selectedConversationId"
        @click="auxiliary.onSelectConversation(conversation.id)"
      >
        <span class="forge-conversation-title">{{ conversation.title }}</span>
        <span class="forge-conversation-meta">{{ conversation.updated }}</span>
      </button>
      <div v-if="auxiliary.conversations.length === 0 && !auxiliary.loading" class="forge-empty-state">
        {{ $t('forgePanel.emptyConversations') }}
      </div>
    </div>

    <section class="forge-preview-card">
      <div class="forge-preview-header">
        <span>{{ $t('forgePanel.previewTitle') }}</span>
        <button
          type="button"
          class="forge-auxiliary-action"
          data-forge-action="dump-conversation"
          :disabled="!auxiliary.selectedConversationId || auxiliary.loading"
          @click="auxiliary.onDumpConversation(auxiliary.selectedConversationId)"
        >
          {{ $t('forgePanel.dump') }}
        </button>
      </div>
      <pre class="forge-preview-body" data-forge-preview="markdown">{{ auxiliary.selectedMarkdown }}</pre>
    </section>

    <section v-if="auxiliary.selectedDump" class="forge-preview-card">
      <div class="forge-preview-header">
        <span>{{ $t('forgePanel.dumpTitle') }}</span>
      </div>
      <pre class="forge-preview-body" data-forge-preview="dump">{{ auxiliary.selectedDump }}</pre>
    </section>
  </aside>
</template>

<script setup lang="ts">
import { computed } from 'vue';

import type { ForgePanelAuxiliary } from '../types/forge';
import { FORGE_SIDEBAR_COMMANDS, toForgeCommandLine, type ForgeCommand } from '../utils/forgeCommands';

const props = defineProps<{
  auxiliary: ForgePanelAuxiliary;
  onSendLine: (line: string) => void;
}>();

const sidebarCommands = FORGE_SIDEBAR_COMMANDS;

function isPresentText(value: string) {
  return value.length > 0;
}

const statusText = computed(() => {
  const info = props.auxiliary.info;
  if (!info) return '';
  return [info.model, info.providerUrl, info.conversationId].filter(isPresentText).join(' · ');
});

function sendCommand(command: ForgeCommand) {
  props.onSendLine(toForgeCommandLine(command));
}
</script>

<style scoped>
.forge-auxiliary-panel {
  display: flex;
  width: 100%;
  flex-direction: column;
  min-height: 0;
  border-left: 1px solid var(--theme-border-muted, var(--color-region-border));
  background: var(--theme-surface-panel-muted, rgba(15, 23, 42, 0.72));
  container-type: inline-size;
}

.forge-auxiliary-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2, 8px);
  padding: var(--space-2, 8px);
  border-bottom: 1px solid var(--theme-border-muted, var(--color-region-border));
}

.forge-auxiliary-title-group {
  flex: 1 1 auto;
  min-width: 0;
}

.forge-auxiliary-title,
.forge-preview-header {
  color: var(--theme-text-primary, var(--color-text-100));
  font-size: 11px;
  font-weight: 700;
  line-height: 1.3;
}

.forge-status-chip {
  display: flex;
  align-items: center;
  min-width: 0;
  max-width: none;
  gap: var(--space-1, 4px);
  margin-top: var(--space-1, 4px);
  color: var(--theme-text-muted, var(--color-text-300));
  font-size: 10px;
  line-height: 1.3;
  white-space: nowrap;
}

.forge-status-label {
  flex: 0 0 auto;
  color: var(--theme-accent-primary, var(--color-region-accent));
  white-space: nowrap;
}

.forge-status-value {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.forge-auxiliary-action,
.forge-conversation-item {
  border: 1px solid var(--theme-border-default, var(--color-region-border));
  border-radius: 6px;
  background: var(--theme-surface-panel-muted, var(--color-region-control-bg));
  color: var(--theme-text-primary, var(--color-text-100));
  font: inherit;
  transition: background 140ms ease-out, border-color 140ms ease-out, color 140ms ease-out;
}

.forge-auxiliary-action {
  flex: 0 0 auto;
  padding: 5px 7px;
  font-size: 10px;
  line-height: 1;
}

.forge-auxiliary-action:hover:not(:disabled),
.forge-conversation-item:hover {
  border-color: var(--theme-border-strong, var(--color-accent-400));
  background: var(--theme-surface-panel-hover, var(--color-surface-800));
}

.forge-auxiliary-action:focus-visible,
.forge-conversation-item:focus-visible {
  outline: 2px solid var(--theme-accent-primary, var(--color-region-accent));
  outline-offset: 2px;
}

.forge-auxiliary-action:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.forge-sidebar-command-grid {
  display: grid;
  grid-template-columns: repeat(6, minmax(0, 1fr));
  gap: var(--space-1, 4px);
  padding: var(--space-2, 8px);
  border-bottom: 1px solid var(--theme-border-muted, var(--color-region-border));
}

.forge-sidebar-command {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@container (max-width: 400px) {
  .forge-sidebar-command-grid {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@container (max-width: 280px) {
  .forge-sidebar-command-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.forge-auxiliary-error,
.forge-auxiliary-loading,
.forge-empty-state {
  padding: var(--space-2, 8px);
  color: var(--theme-text-muted, var(--color-text-300));
  font-size: 10px;
  line-height: 1.35;
}

.forge-auxiliary-error {
  color: var(--color-warning-300, #fef08a);
}

.forge-auxiliary-error-label {
  display: block;
  color: var(--theme-text-primary, var(--color-text-100));
  font-weight: 700;
}

.forge-conversation-list {
  display: flex;
  flex: 0 1 auto;
  flex-direction: column;
  gap: var(--space-1, 4px);
  min-height: 72px;
  max-height: 180px;
  overflow: auto;
  padding: var(--space-2, 8px);
}

.forge-conversation-item {
  display: flex;
  width: 100%;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  text-align: left;
}

.forge-conversation-item.is-selected {
  border-color: var(--theme-accent-primary, var(--color-region-accent));
  background: var(--theme-surface-active, var(--color-region-active-bg));
}

.forge-conversation-title {
  overflow: hidden;
  font-size: 11px;
  font-weight: 700;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.forge-conversation-meta {
  color: var(--theme-text-muted, var(--color-text-300));
  font-size: 10px;
}

.forge-preview-card {
  display: flex;
  flex: 1 1 0;
  flex-direction: column;
  min-height: 0;
  border-top: 1px solid var(--theme-border-muted, var(--color-region-border));
}

.forge-preview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2, 8px);
  padding: var(--space-2, 8px);
}

.forge-preview-body {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  overflow: auto;
  padding: 0 var(--space-2, 8px) var(--space-2, 8px);
  color: var(--theme-text-secondary, var(--color-text-300));
  font: inherit;
  font-size: 10px;
  line-height: 1.45;
  white-space: pre-wrap;
}

@media (max-width: 860px) {
  .forge-auxiliary-panel {
    border-top: 1px solid var(--theme-border-muted, var(--color-region-border));
    border-left: 0;
  }
}
</style>

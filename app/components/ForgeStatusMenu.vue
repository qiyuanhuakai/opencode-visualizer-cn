<template>
  <Dropdown
    class="forge-status-dropdown is-right-aligned"
    :label="t('forgePanel.statusButton')"
    button-class="forge-status-trigger"
    popup-class="forge-status-popup"
    :auto-highlight="false"
  >
    <template #default="{ close }">
      <div class="forge-status-menu-title">{{ t('forgePanel.statusLabel') }}</div>
      <div class="forge-status-menu-model" data-forge-status-chip>
        {{ statusText || t('forgePanel.statusUnavailable') }}
      </div>
      <div class="forge-status-command-grid">
        <button
          v-for="item in statusCommands"
          :key="item.action"
          type="button"
          class="forge-status-command"
          :data-forge-action="item.action"
          @click="runCommand(item.command, close)"
        >
          <span>{{ t(item.labelKey) }}</span>
          <code>{{ item.command }}</code>
        </button>
      </div>
    </template>
  </Dropdown>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import Dropdown from './Dropdown.vue';
import { FORGE_STATUS_COMMANDS, toForgeCommandLine, type ForgeCommand } from '../utils/forgeCommands';

const props = defineProps<{
  statusText: string;
  onSendLine: (line: string) => void;
  onCommandSelected?: () => void;
}>();

const { t } = useI18n();
const statusCommands = FORGE_STATUS_COMMANDS;

function runCommand(command: ForgeCommand, close: () => void) {
  props.onSendLine(toForgeCommandLine(command));
  close();
  props.onCommandSelected?.();
}
</script>

<style scoped>
:deep(.forge-status-trigger) {
  height: 28px;
  padding: 0 8px;
  border-color: var(--theme-border-default, var(--color-region-border));
  border-radius: 6px;
  background: var(--theme-surface-panel-muted, var(--color-region-control-bg));
  color: var(--theme-text-primary, var(--color-text-100));
  font-family: inherit;
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

:deep(.forge-status-popup) {
  width: min(420px, calc(100vw - 16px));
  padding: 8px;
  border-color: var(--theme-border-default, var(--color-region-border));
  border-radius: 6px;
  background: var(--theme-top-dropdown-control-bg, var(--theme-dropdown-control-bg, var(--color-region-control-bg)));
}

.forge-status-dropdown.is-right-aligned :deep(.forge-status-popup) {
  left: auto;
  right: anchor(right);
}

.forge-status-menu-title {
  color: var(--theme-text-muted, var(--color-text-300));
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.forge-status-menu-model {
  overflow: hidden;
  margin-top: 4px;
  color: var(--theme-text-primary, var(--color-text-100));
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.forge-status-command-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 4px;
  margin-top: 8px;
}

.forge-status-command {
  display: flex;
  min-width: 0;
  justify-content: space-between;
  gap: 8px;
  padding: 6px;
  border: 1px solid var(--theme-border-default, var(--color-region-border));
  border-radius: 6px;
  background: var(--theme-surface-panel-muted, var(--color-region-control-bg));
  color: var(--theme-text-primary, var(--color-text-100));
  font: inherit;
  font-size: 10px;
  text-align: left;
}

.forge-status-command:hover {
  background: var(--theme-surface-panel-hover, var(--color-surface-800));
}

.forge-status-command code {
  color: var(--theme-accent-primary, var(--color-region-accent));
  font-size: 9px;
}
</style>

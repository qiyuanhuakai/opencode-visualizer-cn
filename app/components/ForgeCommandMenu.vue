<template>
  <Dropdown
    class="forge-command-dropdown"
    :class="{ 'is-right-aligned': group.id === 'conversation' || group.id === 'workspace' }"
    :label="t(group.labelKey)"
    button-class="forge-command-trigger"
    popup-class="forge-command-popup"
    :auto-highlight="false"
  >
    <template #default="{ close }">
      <button
        v-for="item in group.items"
        :key="item.action"
        type="button"
        class="forge-command-item"
        :data-forge-action="item.action"
        @click="runCommand(item.command, close)"
      >
        <span>{{ t(item.labelKey) }}</span>
        <code>{{ item.command }}</code>
      </button>
    </template>
  </Dropdown>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import Dropdown from './Dropdown.vue';
import { toForgeCommandLine, type ForgeCommand, type ForgeCommandGroup } from '../utils/forgeCommands';

const props = defineProps<{
  group: ForgeCommandGroup;
  onSendLine: (line: string) => void;
  onCommandSelected?: () => void;
}>();

const { t } = useI18n();

function runCommand(command: ForgeCommand, close: () => void) {
  props.onSendLine(toForgeCommandLine(command));
  close();
  props.onCommandSelected?.();
}
</script>

<style scoped>
.forge-command-dropdown {
  min-width: 0;
}

:deep(.forge-command-trigger) {
  height: 28px;
  min-width: 0;
  padding: 0 8px;
  border: 1px solid var(--theme-border-default, var(--color-region-border));
  border-radius: 6px;
  background: var(--theme-surface-panel-muted, var(--color-region-control-bg));
  color: var(--theme-text-primary, var(--color-text-100));
  font-family: inherit;
  font-size: 10px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

:deep(.forge-command-popup) {
  min-width: 220px;
  padding: 4px;
  border-radius: 6px;
  border-color: var(--theme-border-default, var(--color-region-border));
  background: var(
    --theme-top-dropdown-control-bg,
    var(--theme-dropdown-control-bg, var(--color-region-control-bg))
  );
}

.forge-command-dropdown.is-right-aligned :deep(.forge-command-popup) {
  left: auto;
  right: anchor(right);
}

.forge-command-item {
  display: flex;
  width: 100%;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 8px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: var(--theme-text-primary, var(--color-text-100));
  font-family: inherit;
  font-size: 11px;
  text-align: left;
}

.forge-command-item:hover {
  background: var(--theme-surface-panel-hover, var(--color-surface-800));
  color: var(--theme-text-primary, var(--color-text-100));
}

.forge-command-item code {
  color: var(--theme-accent-primary, var(--color-region-accent));
  font-size: 10px;
}
</style>

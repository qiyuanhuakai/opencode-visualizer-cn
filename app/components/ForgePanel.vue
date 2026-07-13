<template>
  <section class="forge-panel" :style="panelStyle">
    <header class="forge-toolbar">
      <div class="forge-title-group">
        <div class="forge-title">{{ $t('forgePanel.title') }}</div>
        <div class="forge-description">
          {{ cwd ? cwd : $t('forgePanel.description') }}
        </div>
      </div>
      <div class="forge-toolbar-actions" role="toolbar" :aria-label="$t('forgePanel.description')">
        <ForgeCommandMenu
          v-for="group in commandGroups"
          :key="group.id"
          :group="group"
          :on-send-line="onSendLine"
          :on-command-selected="focusTerminal"
        />
        <ForgeStatusMenu
          :status-text="statusText"
          :on-send-line="onSendLine"
          :on-command-selected="focusTerminal"
        />
      </div>
    </header>

    <div class="forge-body">
      <div class="forge-terminal-wrap">
        <div class="xterm-host" :data-shell-id="shellId"></div>
      </div>
      <template v-if="auxiliary">
        <div
          class="forge-sidebar-resizer"
          :class="{ 'is-collapsed': !sidebarVisible }"
          data-forge-sidebar-resizer
          role="separator"
          aria-orientation="vertical"
          tabindex="0"
          @pointerdown="startSidebarResize"
        ></div>
        <div v-if="sidebarVisible" class="forge-sidebar-shell">
          <ForgeAuxiliaryPanel :auxiliary="auxiliary" :on-send-line="onSendLine" />
        </div>
      </template>
    </div>

    <ForgePromptBar :on-send-line="onSendLine" />
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, type CSSProperties } from 'vue';

import ForgeAuxiliaryPanel from './ForgeAuxiliaryPanel.vue';
import ForgeCommandMenu from './ForgeCommandMenu.vue';
import ForgePromptBar from './ForgePromptBar.vue';
import ForgeStatusMenu from './ForgeStatusMenu.vue';
import type { ForgePanelAuxiliary } from '../types/forge';
import { FORGE_COMMAND_GROUPS } from '../utils/forgeCommands';

const props = defineProps<{
  shellId: string;
  cwd?: string;
  onSendLine: (line: string) => void;
  auxiliary?: ForgePanelAuxiliary;
}>();

const commandGroups = FORGE_COMMAND_GROUPS;
const sidebarVisible = ref(true);
const sidebarWidth = ref(300);
const SIDEBAR_DRAG_TOGGLE_DISTANCE = 96;
let resizeStartX = 0;
let resizeStartWidth = 0;
let resizeStartedVisible = true;

const panelStyle = computed<CSSProperties>(() => ({
  '--forge-sidebar-width': `${sidebarWidth.value}px`,
}));

const statusText = computed(() => {
  const info = props.auxiliary?.info;
  if (!info) return '';
  return [info.model, info.providerUrl, info.conversationId].filter((value) => value.length > 0).join(' · ');
});

function focusTerminal() {
  const terminalInput = document.querySelector<HTMLTextAreaElement>(
    `[data-shell-id="${props.shellId}"] .xterm-helper-textarea`,
  );
  terminalInput?.focus();
}

function clampSidebarWidth(width: number) {
  return Math.min(440, Math.max(220, width));
}

function startSidebarResize(event: PointerEvent) {
  event.preventDefault();
  resizeStartX = event.clientX;
  resizeStartWidth = sidebarWidth.value;
  resizeStartedVisible = sidebarVisible.value;
  window.addEventListener('pointermove', resizeSidebar);
  window.addEventListener('pointerup', stopSidebarResize, { once: true });
}

function resizeSidebar(event: PointerEvent) {
  const dragDistance = event.clientX - resizeStartX;
  if (resizeStartedVisible) {
    if (dragDistance >= SIDEBAR_DRAG_TOGGLE_DISTANCE) {
      sidebarVisible.value = false;
      return;
    }
    sidebarWidth.value = clampSidebarWidth(resizeStartWidth - dragDistance);
    return;
  }
  if (dragDistance <= -SIDEBAR_DRAG_TOGGLE_DISTANCE) {
    sidebarWidth.value = 220;
    sidebarVisible.value = true;
  }
}

function stopSidebarResize() {
  window.removeEventListener('pointermove', resizeSidebar);
}

onBeforeUnmount(stopSidebarResize);
</script>

<style scoped>
.forge-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--terminal-shell-background-color, transparent);
  color: var(--theme-text-primary, var(--color-text-100));
  font-family: var(--app-monospace-font-family, monospace);
}

.forge-toolbar {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2, 8px);
  padding: var(--space-2, 8px);
  border-bottom: 1px solid var(--theme-border-muted, var(--color-region-border));
  background: var(--theme-surface-panel-muted, rgba(15, 23, 42, 0.72));
}

.forge-title-group {
  min-width: 0;
}

.forge-title {
  font-size: 12px;
  font-weight: 700;
  line-height: 1.25;
}

.forge-description {
  max-width: 280px;
  overflow: hidden;
  color: var(--theme-text-muted, var(--color-text-300));
  font-size: 10px;
  line-height: 1.3;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.forge-toolbar-actions {
  display: flex;
  align-items: center;
  gap: var(--space-1, 4px);
}

.forge-toolbar-actions {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.forge-body {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.forge-terminal-wrap {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}

.forge-sidebar-resizer {
  flex: 0 0 6px;
  cursor: col-resize;
  touch-action: none;
  background: linear-gradient(
    to right,
    transparent,
    var(--theme-border-muted, var(--color-region-border)),
    transparent
  );
}

.forge-sidebar-resizer.is-collapsed {
  flex-basis: 10px;
  cursor: e-resize;
}

.forge-sidebar-shell {
  position: relative;
  display: flex;
  flex: 0 0 var(--forge-sidebar-width);
  width: var(--forge-sidebar-width);
  min-width: 220px;
  max-width: 440px;
  min-height: 0;
}

.xterm-host {
  flex: 1;
  min-height: 0;
  background: transparent;
}

.xterm-host :deep(.xterm) {
  height: 100%;
  background: transparent;
}

.xterm-host :deep(.xterm-viewport) {
  overflow: auto;
  background: transparent !important;
}

.xterm-host :deep(.xterm-screen) {
  background: transparent;
}

@media (max-width: 860px) {
  .forge-toolbar {
    align-items: stretch;
    flex-direction: column;
  }

  .forge-toolbar-actions,
  .forge-toolbar-actions {
    justify-content: flex-start;
  }

  .forge-body {
    flex-direction: column;
  }

  .forge-sidebar-resizer {
    display: none;
  }

  .forge-sidebar-shell {
    flex: 0 0 auto;
    width: 100%;
    max-width: none;
  }
}
</style>

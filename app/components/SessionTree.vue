<template>
  <div class="session-tree">
    <div v-if="projects.length === 0" class="session-tree-empty">
      {{ $t('sidePanel.session.noPinned') }}
    </div>
    <ul v-else class="session-tree-list">
      <li
        v-for="project in projects"
        :key="project.projectId"
        class="session-tree-project"
      >
        <div
          class="session-tree-row"
          :class="{ 'is-pinned': project.isPinned }"
          @click="toggleExpand(`project:${project.projectId}`)"
        >
          <span class="session-tree-toggle">
            <Icon
              :icon="isExpanded(`project:${project.projectId}`) ? 'lucide:chevron-down' : 'lucide:chevron-right'"
              width="14"
              height="14"
            />
          </span>
          <span class="session-tree-icon">
            <Icon icon="lucide:package" width="14" height="14" />
          </span>
          <span class="session-tree-label">{{ project.name }}</span>
          <button
            type="button"
            class="session-tree-pin"
            :class="{ 'is-pinned': project.isPinned }"
            :title="project.isPinned ? $t('sidePanel.session.sessionTree.unpinProject') : $t('sidePanel.session.sessionTree.pinProject')"
            @click.stop="project.isPinned ? emit('unpin-project', project.projectId) : emit('pin-project', project.projectId)"
          >
            <Icon
              :icon="project.isPinned ? 'lucide:pin-off' : 'lucide:pin'"
              width="14"
              height="14"
            />
          </button>
        </div>
        <ul
          v-if="isExpanded(`project:${project.projectId}`)"
          class="session-tree-children"
        >
          <li
            v-for="sandbox in project.sandboxes"
            :key="`${project.projectId}:${sandbox.directory}`"
            class="session-tree-sandbox"
          >
            <div
              class="session-tree-row"
              :class="{ 'is-pinned': sandbox.isPinned || sandbox.isImplicitlyPinned }"
              :style="{ paddingLeft: 'calc(4px + 14px)' }"
              @click="toggleExpand(`sandbox:${project.projectId}:${sandbox.directory}`)"
            >
              <span class="session-tree-toggle">
                <Icon
                  :icon="isExpanded(`sandbox:${project.projectId}:${sandbox.directory}`) ? 'lucide:chevron-down' : 'lucide:chevron-right'"
                  width="14"
                  height="14"
                />
              </span>
              <span class="session-tree-icon">
                <Icon icon="lucide:git-branch" width="14" height="14" />
              </span>
              <span class="session-tree-label">{{ sandbox.name }}</span>
              <button
                type="button"
                class="session-tree-pin"
                :class="{ 'is-pinned': sandbox.isPinned || sandbox.isImplicitlyPinned }"
                :title="sandbox.isPinned || sandbox.isImplicitlyPinned ? $t('sidePanel.session.sessionTree.unpinSandbox') : $t('sidePanel.session.sessionTree.pinSandbox')"
                @click.stop="sandbox.isPinned || sandbox.isImplicitlyPinned
                  ? emit('unpin-sandbox', { projectId: project.projectId, directory: sandbox.directory })
                  : emit('pin-sandbox', { projectId: project.projectId, directory: sandbox.directory })"
              >
                <Icon
                  :icon="sandbox.isPinned || sandbox.isImplicitlyPinned ? 'lucide:pin-off' : 'lucide:pin'"
                  width="14"
                  height="14"
                />
              </button>
            </div>
            <ul
              v-if="isExpanded(`sandbox:${project.projectId}:${sandbox.directory}`)"
              class="session-tree-children"
            >
              <li
                v-for="session in sandbox.sessions"
                :key="session.sessionId"
                class="session-tree-session"
              >
                <div
                  class="session-tree-row"
                  :class="{ 'is-active': selectedSessionId === session.sessionId, 'is-pinned': session.isPinned || session.isImplicitlyPinned }"
                  :style="{ paddingLeft: 'calc(4px + 28px)' }"
                  @click="emit('select-session', { projectId: project.projectId, sessionId: session.sessionId })"
                >
                  <span class="session-tree-status" :class="`is-${session.status}`">
                    <template v-if="session.status === 'unknown'">
                      <span class="status-circle-outline"></span>
                    </template>
                    <template v-else>{{ sessionStatusIcon(session.status) }}</template>
                  </span>
                  <span class="session-tree-label">{{ session.title }}</span>
                  <button
                    type="button"
                    class="session-tree-pin"
                    :class="{ 'is-pinned': session.isPinned || session.isImplicitlyPinned }"
                    :title="session.isPinned || session.isImplicitlyPinned ? $t('sidePanel.session.sessionTree.unpinSession') : $t('sidePanel.session.sessionTree.pinSession')"
                    @click.stop="session.isPinned || session.isImplicitlyPinned
                      ? emit('unpin-session', { projectId: project.projectId, sessionId: session.sessionId })
                      : emit('pin-session', { projectId: project.projectId, sessionId: session.sessionId })"
                  >
                    <Icon
                      :icon="session.isPinned || session.isImplicitlyPinned ? 'lucide:pin-off' : 'lucide:pin'"
                      width="14"
                      height="14"
                    />
                  </button>
                </div>
              </li>
            </ul>
          </li>
        </ul>
      </li>
    </ul>
    <div class="session-tree-footer">
      <div class="session-tree-footer-left"></div>
      <div class="session-tree-footer-right">
        <button
          type="button"
          class="session-tree-footer-btn"
          :aria-label="$t('treeView.reloadFileTree')"
          @click="emit('reload')"
        >
          <Icon icon="lucide:refresh-cw" :width="13" :height="13" />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { Icon } from '@iconify/vue';
import type { SessionTreeProject } from '../types/session-tree';

const props = defineProps<{
  projects: SessionTreeProject[];
  expandedPaths: string[];
  selectedSessionId: string;
}>();

const emit = defineEmits<{
  (event: 'toggle-expand', path: string): void;
  (event: 'select-session', payload: { projectId: string; sessionId: string }): void;
  (event: 'pin-project', projectId: string): void;
  (event: 'unpin-project', projectId: string): void;
  (event: 'pin-sandbox', payload: { projectId: string; directory: string }): void;
  (event: 'unpin-sandbox', payload: { projectId: string; directory: string }): void;
  (event: 'pin-session', payload: { projectId: string; sessionId: string }): void;
  (event: 'unpin-session', payload: { projectId: string; sessionId: string }): void;
  (event: 'reload'): void;
}>();

function isExpanded(path: string): boolean {
  return props.expandedPaths.includes(path);
}

function toggleExpand(path: string): void {
  emit('toggle-expand', path);
}

function sessionStatusIcon(status: 'busy' | 'idle' | 'retry' | 'unknown'): string {
  if (status === 'busy') return '🤔';
  if (status === 'retry') return '🔴';
  if (status === 'idle') return '🟢';
  return '⚪';
}
</script>

<style scoped>
.session-tree {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  padding: 4px 0 0;
}

.session-tree-empty {
  padding: 24px 12px;
  text-align: center;
  color: var(--theme-side-text-muted, #94a3b8);
  font-size: var(--ui-font-size, 12px);
}

.session-tree-list,
.session-tree-children {
  list-style: none;
  margin: 0;
  padding: 0;
}

.session-tree-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.session-tree-row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px 2px 4px;
  border-radius: 6px;
  cursor: pointer;
  min-height: 28px;
  transition: background 0.12s ease;
  user-select: none;
  -webkit-user-select: none;
}

.session-tree-row:hover {
  background: var(--theme-side-control-bg, rgba(30, 41, 59, 0.5));
}

.session-tree-row.is-active {
  background: var(--theme-side-active-bg, rgba(30, 64, 175, 0.25));
  border-left: 2px solid var(--theme-side-accent, rgba(96, 165, 250, 0.8));
}

.session-tree-toggle {
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--theme-side-text-muted, #94a3b8);
}

.session-tree-icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--theme-side-text-muted, #94a3b8);
}

.session-tree-label {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--theme-side-text, #e2e8f0);
}

.session-tree-status {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 14px;
}

.session-tree-status.is-idle {
  color: var(--theme-status-success, #4ade80);
}

.session-tree-status.is-retry {
  color: var(--theme-status-danger, #f87171);
}

.session-tree-status.is-busy {
  color: var(--theme-status-warning, #fbbf24);
}

.session-tree-status.is-unknown {
  color: var(--theme-side-text-muted, #94a3b8);
}

.status-circle-outline {
  display: inline-block;
  width: 8px;
  height: 8px;
  border: 1.5px solid currentColor;
  border-radius: 50%;
  box-sizing: border-box;
}

.session-tree-pin {
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--theme-side-text-muted, #94a3b8);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  border-radius: 4px;
  transition: all 0.12s ease;
  opacity: 0;
}

.session-tree-row:hover .session-tree-pin {
  opacity: 1;
}

.session-tree-pin.is-pinned {
  opacity: 1;
  color: #fbbf24;
}

.session-tree-pin:hover {
  background: var(--theme-side-active-bg, rgba(51, 65, 85, 0.6));
}

.session-tree-project > .session-tree-row {
  font-weight: 600;
}

.session-tree-sandbox > .session-tree-row {
  font-weight: 500;
}

.session-tree-session .session-tree-row {
  cursor: pointer;
}

.session-tree-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  border-top: 1px solid var(--theme-side-border, var(--theme-border-muted, rgba(100, 116, 139, 0.28)));
  flex-shrink: 0;
}

.session-tree-footer-left {
  display: flex;
  align-items: center;
  gap: 4px;
}

.session-tree-footer-right {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

.session-tree-footer-btn {
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--theme-side-text-muted, #94a3b8);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  transition: all 0.12s ease;
}

.session-tree-footer-btn:hover {
  background: var(--theme-side-active-bg, rgba(51, 65, 85, 0.6));
  color: var(--theme-side-text, #e2e8f0);
}
</style>

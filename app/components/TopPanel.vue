<template>
  <div class="top-panel">
    <div class="top-row">
      <div class="top-left">OpenCode Visualizer</div>
      <div class="top-center">
        <Dropdown
          class="tree-dropdown-root"
          :label="dropdownLabel"
          placeholder="Select session"
          auto-close
          :popup-style="{ minWidth: '420px', width: 'min(680px, 90vw)', maxWidth: '90vw' }"
          @select="onTreeSelect"
        >
          <template #label>
            <span v-if="selectedDisplay" class="selected-label">
              <span class="selected-status-icon">{{ sessionStatusIcon(selectedDisplay.status) }}</span>
              <span class="selected-title">{{ selectedDisplay.title }}</span>
              <span class="selected-branch-badge">
                <Icon icon="lucide:git-branch" :width="11" :height="11" />
                {{ selectedDisplay.branch }}
              </span>
            </span>
            <span v-else class="selected-title">Select session</span>
          </template>
          <template #default="{ close }">
            <div class="tree-menu">
              <div class="tree-search" @click.stop>
                <Icon icon="lucide:search" class="search-icon" />
                <input
                  v-auto-focus
                  v-model="searchQuery"
                  type="text"
                  placeholder="Search sessions, branches, directories..."
                  class="search-input"
                  @click.stop
                  @keydown.enter.prevent.stop="selectFirstSearchResult(close)"
                />
                <button v-if="searchQuery" type="button" class="clear-search" @click.stop="searchQuery = ''">
                  <Icon icon="lucide:x" />
                </button>
              </div>

              <div class="tree-content">
                <div v-if="displayedTree.length === 0" class="tree-empty">
                  {{ searchQuery ? 'No matching sessions' : 'No worktrees' }}
                </div>

                <div
                  v-for="worktree in displayedTree"
                  :key="worktree.directory"
                  class="tree-worktree"
                  :style="worktreeAccentStyle(worktree)"
                >
                  <div class="tree-worktree-header">
                    <div class="tree-header-main">
                      <Icon icon="lucide:package" class="tree-header-icon" />
                      <div class="tree-label">
                        <span class="tree-label-name" :title="worktree.directory">{{ worktree.name || worktree.label }}</span>
                        <small class="tree-label-type" :title="worktree.directory">{{ shortenPath(worktree.directory) }}</small>
                      </div>
                    </div>
                  </div>

                  <div v-for="sandbox in worktree.sandboxes" :key="sandbox.directory" class="tree-sandbox">
                    <div class="tree-sandbox-header">
                      <div class="tree-header-main">
                        <Icon icon="lucide:git-branch" class="tree-header-icon" />
                        <div class="tree-label">
                          <span class="tree-label-name" :title="sandbox.directory">{{ sandbox.branch || shortenPath(sandbox.directory) }}</span>
                          <small class="tree-label-type" :title="sandbox.directory">{{ shortenPath(sandbox.directory) }}</small>
                        </div>
                      </div>
                      <div class="tree-actions">
                        <button type="button" class="tree-action-button fork" @click.stop="handleCreateWorktree(sandbox.directory, close)">
                          <Icon icon="lucide:git-branch" :width="11" :height="11" />
                        </button>
                        <button
                          v-if="canDeleteSandbox(sandbox.directory, worktree.directory)"
                          type="button"
                          class="tree-action-button danger"
                          @click.stop="handleSandboxDelete(sandbox.directory, close)"
                        >
                          <Icon icon="lucide:trash-2" :width="11" :height="11" />
                        </button>
                      </div>
                    </div>

                    <div
                      v-for="session in sandbox.sessions"
                      :key="session.id"
                      class="tree-session-row"
                    >
                      <DropdownItem
                        :value="{ worktree: worktree.directory, directory: sandbox.directory, sessionId: session.id }"
                        :active="session.id === selectedSessionId"
                      >
                        <div class="tree-session-main">
                          <span class="session-status-icon" :title="session.status">{{ sessionStatusIcon(session.status) }}</span>
                          <span class="session-title">{{ session.title || session.slug || session.id }}</span>
                          <span v-if="session.archivedAt" class="session-badge-archived">archived</span>
                        </div>
                        <button
                          type="button"
                          class="tree-action-button session-del"
                          :class="isShiftPressed ? 'danger' : 'archive'"
                          :title="isShiftPressed ? 'Delete session (Shift)' : 'Archive session'"
                          @click.stop="handleSessionAction(session.id, close)"
                        >
                          <Icon :icon="isShiftPressed ? 'lucide:trash-2' : 'lucide:archive'" :width="11" :height="11" />
                        </button>
                      </DropdownItem>
                    </div>
                  </div>
                </div>
              </div>

              <div class="tree-footer">
                <button type="button" class="tree-footer-button" @click="handleOpenDirectory(close)">Open</button>
              </div>
            </div>
          </template>
        </Dropdown>

        <button type="button" class="control-button new-session-button" @click="$emit('new-session')" title="New session">
          <Icon icon="lucide:message-circle-plus" :width="16" :height="16" />
        </button>
      </div>
      <div class="top-right">
        <button type="button" class="control-button" disabled title="stub">Logout</button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, type Directive, nextTick, onBeforeUnmount, onMounted } from 'vue';
import { Icon } from '@iconify/vue';
import Dropdown from './Dropdown.vue';
import DropdownItem from './Dropdown/Item.vue';

export type TopPanelSession = {
  id: string;
  title?: string;
  slug?: string;
  status: 'busy' | 'idle' | 'retry' | 'unknown';
  timeUpdated?: number;
  archivedAt?: number;
};

export type TopPanelSandbox = {
  directory: string;
  branch?: string;
  sessions: TopPanelSession[];
};

export type TopPanelWorktree = {
  directory: string;
  label: string;
  name?: string;
  projectColor?: string;
  sandboxes: TopPanelSandbox[];
};

type SessionSelectPayload = {
  worktree: string;
  directory: string;
  sessionId: string;
};

const props = defineProps<{
  treeData: TopPanelWorktree[];
  projectDirectory: string;
  activeDirectory: string;
  selectedSessionId: string;
  homePath?: string;
}>();

const emit = defineEmits<{
  (event: 'select-session', payload: SessionSelectPayload): void;
  (event: 'create-worktree-from', worktree: string): void;
  (event: 'new-session'): void;
  (event: 'delete-active-directory', value: string): void;
  (event: 'delete-session', value: string): void;
  (event: 'archive-session', value: string): void;
  (event: 'open-directory'): void;
}>();

const MAX_WORKTREES = 5;
const MAX_SANDBOXES = 3;
const MAX_SESSIONS = 5;

const searchQuery = ref('');
const isShiftPressed = ref(false);

const vAutoFocus: Directive<HTMLElement> = {
  mounted(el) {
    searchQuery.value = '';
    nextTick(() => el.focus());
  },
};

const selectedDisplay = computed(() => {
  const sid = props.selectedSessionId;
  if (!sid) return null;
  for (const worktree of props.treeData) {
    for (const sandbox of worktree.sandboxes) {
      const session = sandbox.sessions.find((candidate) => candidate.id === sid);
      if (!session) continue;
      const branch = sandbox.branch || shortenPath(sandbox.directory);
      const title = session.title || session.slug || session.id;
      return { branch, title, status: session.status };
    }
  }
  return { branch: 'unknown', title: sid, status: 'unknown' as const };
});

const dropdownLabel = computed(() => {
  if (!selectedDisplay.value) return 'Select session';
  return `${selectedDisplay.value.branch} / ${selectedDisplay.value.title}`;
});

const displayedTree = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  let worktrees = props.treeData;

  if (query) {
    worktrees = worktrees
      .map((worktree) => {
        const worktreeMatches = matchesQuery(query, worktree.directory, worktree.label, worktree.name);
        const sandboxes = worktree.sandboxes
          .map((sandbox) => {
            const sandboxMatches = matchesQuery(query, sandbox.directory, sandbox.branch);
            const sessions = sandbox.sessions.filter((session) =>
              worktreeMatches ||
              sandboxMatches ||
              matchesQuery(
                query,
                session.title,
                session.slug,
                session.id,
                session.archivedAt ? 'archived' : undefined,
              ),
            );
            if (!worktreeMatches && !sandboxMatches && sessions.length === 0) return null;
            return {
              ...sandbox,
              sessions: worktreeMatches || sandboxMatches ? sandbox.sessions : sessions,
            };
          })
          .filter((sandbox): sandbox is TopPanelSandbox => sandbox !== null);

        if (!worktreeMatches && sandboxes.length === 0) return null;
        return { ...worktree, sandboxes };
      })
      .filter((worktree): worktree is TopPanelWorktree => worktree !== null);
  } else {
    worktrees = worktrees
      .map((worktree) => {
        const sandboxes = worktree.sandboxes
          .map((sandbox) => ({
            ...sandbox,
            sessions: sandbox.sessions.filter((session) => !session.archivedAt),
          }))
          .filter((sandbox) => sandbox.sessions.length > 0);

        if (sandboxes.length === 0) return null;
        return { ...worktree, sandboxes };
      })
      .filter((worktree): worktree is TopPanelWorktree => worktree !== null);
  }

  return worktrees.slice(0, MAX_WORKTREES).map((worktree) => ({
    ...worktree,
    sandboxes: worktree.sandboxes.slice(0, MAX_SANDBOXES).map((sandbox) => ({
      ...sandbox,
      sessions: sandbox.sessions.slice(0, MAX_SESSIONS),
    })),
  }));
});

function matchesQuery(query: string, ...fields: (string | undefined)[]) {
  return fields.some((field) => field?.toLowerCase().includes(query));
}

function shortenPath(path: string) {
  const homePath = props.homePath || '';
  if (homePath && path.startsWith(homePath)) {
    const replaced = path.replace(homePath, '~');
    return replaced || '~';
  }
  return path;
}

function sessionStatusIcon(status: TopPanelSession['status']) {
  if (status === 'busy') return '🤔';
  if (status === 'retry') return '🔴';
  if (status === 'idle') return '🟢';
  return '⚪';
}

function canDeleteSandbox(directory: string, worktreeDirectory: string) {
  const normalizedDirectory = directory.replace(/\/+$/, '');
  const normalizedWorktree = worktreeDirectory.replace(/\/+$/, '');
  return normalizedDirectory !== normalizedWorktree;
}

function worktreeAccentStyle(worktree: TopPanelWorktree) {
  if (!worktree.projectColor) return undefined;
  return {
    borderLeft: `3px solid ${worktree.projectColor}`,
  };
}

function onTreeSelect(payload: unknown) {
  if (!payload || typeof payload !== 'object') return;
  const value = payload as Partial<SessionSelectPayload>;
  if (!value.worktree || !value.directory || !value.sessionId) return;
  emit('select-session', {
    worktree: value.worktree,
    directory: value.directory,
    sessionId: value.sessionId,
  });
}

function selectFirstSearchResult(close: () => void) {
  for (const worktree of displayedTree.value) {
    for (const sandbox of worktree.sandboxes) {
      const session = sandbox.sessions[0];
      if (!session) continue;
      emit('select-session', {
        worktree: worktree.directory,
        directory: sandbox.directory,
        sessionId: session.id,
      });
      close();
      return;
    }
  }
}

function handleCreateWorktree(worktree: string, close: () => void) {
  emit('create-worktree-from', worktree);
  close();
}

function handleSandboxDelete(directory: string, close?: () => void) {
  if (typeof window !== 'undefined') {
    const confirmed = window.confirm(`Delete worktree "${directory}"?`);
    if (!confirmed) return;
  }
  emit('delete-active-directory', directory);
  close?.();
}

function handleSessionDelete(sessionId: string, close?: () => void) {
  if (typeof window !== 'undefined') {
    const confirmed = window.confirm('Delete session?');
    if (!confirmed) return;
  }
  emit('delete-session', sessionId);
  close?.();
}

function handleSessionAction(sessionId: string, close?: () => void) {
  if (isShiftPressed.value) {
    handleSessionDelete(sessionId, close);
    return;
  }
  emit('archive-session', sessionId);
}

function handleGlobalKeydown(event: KeyboardEvent) {
  isShiftPressed.value = event.shiftKey;
}

function handleGlobalKeyup(event: KeyboardEvent) {
  isShiftPressed.value = event.shiftKey;
}

function resetShiftState() {
  isShiftPressed.value = false;
}

onMounted(() => {
  window.addEventListener('keydown', handleGlobalKeydown);
  window.addEventListener('keyup', handleGlobalKeyup);
  window.addEventListener('blur', resetShiftState);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleGlobalKeydown);
  window.removeEventListener('keyup', handleGlobalKeyup);
  window.removeEventListener('blur', resetShiftState);
});

function handleOpenDirectory(close: () => void) {
  emit('open-directory');
  close();
}
</script>

<style scoped>
.top-panel {
  position: relative;
  width: 100%;
  min-width: 0;
  /* Full-width background band that breaks out of parent padding */
  margin: -12px -12px 0;
  padding: 8px 12px;
  width: calc(100% + 24px);
  background: rgba(15, 23, 42, 0.92);
  border-bottom: 1px solid #334155;
}

.top-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}

.top-left {
  flex: 0 0 auto;
  font-size: 12px;
  color: #e2e8f0;
}

.top-center {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 8px;
}

.top-right {
  flex: 0 0 auto;
  display: flex;
  justify-content: flex-end;
}

.tree-dropdown-root {
  flex: 0 1 680px;
  width: min(680px, 70vw);
  min-width: 260px;
}

.tree-menu {
  display: flex;
  flex-direction: column;
  background: transparent;
  flex: 1 1 auto;
  min-height: 0;
}

.tree-search {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid #334155;
  background: rgba(15, 23, 42, 0.9);
}

.search-icon {
  width: 14px;
  height: 14px;
  color: #64748b;
}

.search-input {
  flex: 1;
  min-width: 0;
  border: 1px solid #334155;
  border-radius: 8px;
  background: rgba(30, 41, 59, 0.55);
  color: #e2e8f0;
  font-size: 12px;
  padding: 6px 8px;
  outline: none;
}

.search-input:focus {
  border-color: #60a5fa;
  background: rgba(30, 64, 175, 0.15);
}

.search-input::placeholder {
  color: #64748b;
}

.clear-search {
  border: none;
  background: transparent;
  color: #64748b;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
}

.tree-content {
  flex: 1 1 auto;
  overflow-y: auto;
  min-height: 0;
  padding: 6px 0;
}

.tree-worktree + .tree-worktree {
  border-top: 1px solid #334155;
}

.tree-empty {
  padding: 14px;
  text-align: center;
  color: #94a3b8;
  font-size: 12px;
}

.tree-worktree-header,
.tree-sandbox-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
}

.tree-header-main {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  flex: 1 1 auto;
}

.tree-header-icon {
  flex: 0 0 auto;
  width: 14px;
  height: 14px;
  color: #64748b;
}

.tree-worktree-header {
  padding: 6px 8px;
}

.tree-sandbox-header {
  padding: 5px 8px 5px 24px;
  border-top: 1px solid rgba(51, 65, 85, 0.45);
}

.tree-label {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  align-items: flex-start;
}

.tree-label-name {
  font-size: 12px;
  color: #e2e8f0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree-label-type {
  font-size: 10px;
  color: #64748b;
}

.tree-actions {
  display: inline-flex;
  align-items: center;
  justify-content: flex-start;
  gap: 6px;
  /* Reserve space for fork + delete buttons so layout doesn't shift when delete is hidden */
  min-width: calc(26px + 6px + 26px);
}

.tree-action-button.fork {
  color: #93c5fd;
}

.tree-action-button {
  border: 1px solid #334155;
  border-radius: 6px;
  background: #111a2c;
  color: #cbd5e1;
  font-size: 10px;
  line-height: 1;
  width: 26px;
  height: 26px;
  padding: 0;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.tree-action-button:hover {
  background: #1d2a45;
}

.tree-action-button.danger {
  color: #fca5a5;
}

.tree-action-button.archive {
  color: #c4b5fd;
}

/* Session rows: wrapper provides indentation via :deep() since DropdownItem has inheritAttrs:false */
.tree-session-row :deep(.ui-dropdown-item) {
  padding-left: 40px;
  border-radius: 0;
  color: #e2e8f0;
}

.tree-session-row :deep(.ui-dropdown-item:hover),
.tree-session-row :deep(.ui-dropdown-item[aria-selected='true']) {
  background: rgba(30, 41, 59, 0.8);
}

.tree-session-row :deep(.ui-dropdown-item.is-active) {
  background: rgba(59, 130, 246, 0.2);
  border: 1px solid rgba(59, 130, 246, 0.45);
}

.tree-session-main {
  min-width: 0;
  display: flex;
  align-items: center;
  justify-content: flex-start;
  gap: 8px;
  flex: 1 1 auto;
}

.session-status-icon {
  flex: 0 0 auto;
  width: 14px;
  text-align: center;
}

.session-title {
  color: #e2e8f0;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.session-badge-archived {
  flex: 0 0 auto;
  margin-left: auto;
  font-size: 10px;
  line-height: 1;
  color: #c4b5fd;
  background: rgba(139, 92, 246, 0.15);
  border: 1px solid rgba(139, 92, 246, 0.3);
  border-radius: 999px;
  padding: 2px 6px;
}

.session-del {
  flex: 0 0 auto;
  margin-left: auto;
}

.tree-footer {
  flex: 0 0 auto;
  border-top: 1px solid #334155;
  padding: 8px;
  background: #0b1320;
}

.tree-footer-button {
  width: 100%;
  border: 1px solid #334155;
  border-radius: 8px;
  background: #111a2c;
  color: #e2e8f0;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
}

.tree-footer-button:hover {
  background: #1d2a45;
}

.control-button {
  border: 1px solid #334155;
  border-radius: 8px;
  background: #0b1320;
  color: #e2e8f0;
  padding: 6px 12px;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  cursor: pointer;
}

.new-session-button {
  width: 32px;
  height: 32px;
  padding: 0;
  justify-content: center;
}

.tree-dropdown-root :deep(.ui-dropdown-button) {
  background: #0b1320;
  border-color: #334155;
  color: #e2e8f0;
  box-shadow: none;
}

.tree-dropdown-root :deep(.ui-dropdown-menu) {
  background: #0b1320;
  border: 1px solid #334155;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.selected-label {
  min-width: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  width: 100%;
}

.selected-status-icon {
  flex: 0 0 auto;
  width: 14px;
  text-align: center;
  font-size: 12px;
  line-height: 1;
}

.selected-title {
  min-width: 0;
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.selected-branch-badge {
  flex: 0 0 auto;
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid #334155;
  border-radius: 999px;
  padding: 2px 6px;
  color: #cbd5e1;
  background: #111a2c;
  font-size: 11px;
  line-height: 1;
}

.control-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>

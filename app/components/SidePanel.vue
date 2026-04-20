<template>
  <aside class="side-panel" :class="{ 'is-collapsed': collapsed }">
    <button
      v-if="collapsed"
      type="button"
      class="side-toggle side-toggle-collapsed"
      :aria-expanded="!collapsed"
      :aria-label="$t('sidePanel.expandPanel')"
      @click="emit('toggle-collapse')"
    >
      <Icon icon="lucide:chevron-right" width="14" height="14" />
    </button>
    <div v-else class="side-body">
      <div class="side-tabs">
        <button
          v-for="tab in tabs"
          :key="tab.id"
          type="button"
          class="side-tab"
          :class="{ 'is-active': activeTab === tab.id }"
          @click="emit('change-tab', tab.id)"
        >
          {{ tab.label }}
        </button>
        <button
          type="button"
          class="side-toggle side-toggle-inline"
          :aria-expanded="!collapsed"
          :aria-label="$t('sidePanel.collapsePanel')"
          @click="emit('toggle-collapse')"
        >
          <Icon icon="lucide:chevron-left" width="14" height="14" />
        </button>
      </div>
      <TodoList v-show="activeTab === 'todo'" :sessions="todoSessions" />
      <div v-show="activeTab === 'session'" class="session-body">
        <div class="session-header">
          <div class="session-title">{{ $t('sidePanel.session.title') }}</div>
          <div class="session-count">{{ sessionTreeSessionCount }}</div>
        </div>
        <SessionTree
          :projects="sessionTreeData"
          :expanded-paths="sessionTreeExpandedPaths"
          :selected-session-id="selectedSessionId"
        @toggle-expand="(path) => emit('toggle-expand', path)"
        @select-session="(payload) => emit('select-session', payload)"
        @pin-project="(projectId) => emit('pin-project', projectId)"
        @unpin-project="(projectId) => emit('unpin-project', projectId)"
        @pin-sandbox="(payload) => emit('pin-sandbox', payload)"
        @unpin-sandbox="(payload) => emit('unpin-sandbox', payload)"
        @pin-session="(payload) => emit('pin-session', payload)"
        @unpin-session="(payload) => emit('unpin-session', payload)"
        @reload="emit('reload')"
      />
      </div>
      <TreeView
        v-show="activeTab === 'tree'"
        :root-nodes="treeNodes"
        :expanded-paths="expandedTreePaths"
        :selected-path="selectedTreePath"
        :is-loading="treeLoading"
        :error="treeError"
        :git-status-by-path="treeStatusByPath"
        :branch-info="treeBranchInfo"
        :diff-stats="treeDiffStats"
        :directory-name="treeDirectoryName"
        :branch-entries="treeBranchEntries"
        :branch-list-loading="treeBranchListLoading"
        :run-shell-command="runShellCommand"
        :ensure-branch-entries-loaded="ensureBranchEntriesLoaded"
        @toggle-dir="(path) => emit('toggle-dir', path)"
        @select-file="(path) => emit('select-file', path)"
        @open-diff="(payload) => emit('open-diff', payload)"
        @open-diff-all="(payload) => emit('open-diff-all', payload)"
        @open-file="(path) => emit('open-file', path)"
        @reload="emit('reload')"
      />
    </div>
  </aside>
</template>

<script setup lang="ts">
import { computed, toRefs } from 'vue';
import { Icon } from '@iconify/vue';
import TodoList from './TodoList.vue';
import SessionTree from './SessionTree.vue';
import type { BranchEntry } from '../types/git';
import type { SessionTreeData } from '../types/session-tree';
import TreeView, {
  type GitBranchInfo,
  type GitDiffStats,
  type GitFileStatus,
  type TreeNode,
} from './TreeView.vue';

type TodoItem = {
  content: string;
  status: string;
  priority: string;
};

type TodoPanelSession = {
  sessionId: string;
  title: string;
  isSubagent: boolean;
  todos: TodoItem[];
  loading: boolean;
  error: string | undefined;
};

const props = defineProps<{
  collapsed: boolean;
  activeTab: 'todo' | 'session' | 'tree';
  selectedSessionId: string;
  todoSessions: TodoPanelSession[];
  sessionTreeData: SessionTreeData;
  sessionTreeExpandedPaths: string[];
  treeNodes: TreeNode[];
  expandedTreePaths: string[];
  selectedTreePath?: string;
  treeLoading: boolean;
  treeError?: string;
  treeStatusByPath: Record<string, GitFileStatus>;
  treeBranchInfo?: GitBranchInfo | null;
  treeDiffStats?: GitDiffStats | null;
  treeDirectoryName?: string;
  treeBranchEntries?: BranchEntry[];
  treeBranchListLoading?: boolean;
  runShellCommand?: (command: string) => Promise<void>;
  ensureBranchEntriesLoaded?: () => Promise<void>;
}>();

const emit = defineEmits<{
  (event: 'toggle-collapse'): void;
  (event: 'change-tab', value: 'todo' | 'session' | 'tree'): void;
  (event: 'select-session', payload: { projectId: string; sessionId: string }): void;
  (event: 'toggle-expand', path: string): void;
  (event: 'pin-project', projectId: string): void;
  (event: 'unpin-project', projectId: string): void;
  (event: 'pin-sandbox', payload: { projectId: string; directory: string }): void;
  (event: 'unpin-sandbox', payload: { projectId: string; directory: string }): void;
  (event: 'pin-session', payload: { projectId: string; sessionId: string }): void;
  (event: 'unpin-session', payload: { projectId: string; sessionId: string }): void;
  (event: 'reload'): void;
  (event: 'toggle-dir', path: string): void;
  (event: 'select-file', path: string): void;
  (event: 'open-diff', payload: { path: string; staged: boolean }): void;
  (event: 'open-diff-all', payload: { mode: 'staged' | 'changes' | 'all' }): void;
  (event: 'open-file', path: string): void;
  (event: 'reload'): void;
}>();

import { useI18n } from 'vue-i18n';

const { t } = useI18n();

const tabs = computed(() => [
  { id: 'todo' as const, label: t('sidePanel.tabs.todo') },
  { id: 'session' as const, label: t('sidePanel.tabs.session') },
  { id: 'tree' as const, label: t('sidePanel.tabs.tree') },
]);

const sessionTreeSessionCount = computed(() => {
  return props.sessionTreeData.reduce(
    (count, project) =>
      count +
      project.sandboxes.reduce(
        (sCount, sandbox) => sCount + sandbox.sessions.length,
        0,
      ),
    0,
  );
});

const {
  collapsed,
  activeTab,
  selectedSessionId,
  todoSessions,
  sessionTreeData,
  sessionTreeExpandedPaths,
  treeNodes,
  expandedTreePaths,
  selectedTreePath,
  treeLoading,
  treeError,
  treeStatusByPath,
  treeBranchInfo,
  treeDiffStats,
  treeDirectoryName,
  treeBranchEntries,
  treeBranchListLoading,
  runShellCommand,
  ensureBranchEntriesLoaded,
} = toRefs(props);
</script>

<style scoped>
.side-panel {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: row;
  border: 1px solid var(--theme-side-border, #334155);
  border-radius: 12px;
  background-clip: padding-box;
  background: var(--theme-side-bg, rgba(12, 18, 30, 0.95));
  box-shadow: 0 10px 24px rgba(2, 6, 23, 0.35);
  overflow: hidden;
}

.side-toggle {
  width: 26px;
  height: 26px;
  border: 1px solid var(--theme-side-border, rgba(100, 116, 139, 0.45));
  border-radius: 6px;
  background: var(--theme-side-control-bg, rgba(30, 41, 59, 0.92));
  color: var(--theme-side-text, #cbd5e1);
  cursor: pointer;
  font-size: var(--ui-font-size, 12px);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}

.side-toggle:hover {
  background: var(--theme-side-active-bg, rgba(51, 65, 85, 0.95));
}

.side-body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.side-tabs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 8px;
  border-bottom: 1px solid var(--theme-side-border, rgba(71, 85, 105, 0.42));
}

.side-tab {
  flex: 1;
  border: 1px solid var(--theme-tab-border, var(--theme-side-border, rgba(100, 116, 139, 0.35)));
  border-radius: 6px;
  background: var(--theme-tab-bg, var(--theme-side-bg, rgba(15, 23, 42, 0.7)));
  color: var(--theme-tab-text, var(--theme-side-text, #94a3b8));
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  padding: 5px 0;
  cursor: pointer;
}

.side-tab.is-active {
  background: var(--theme-tab-active-bg, var(--theme-side-active-bg, rgba(30, 64, 175, 0.45)));
  color: var(--theme-tab-active-text, var(--theme-side-active-text, #e2e8f0));
  border-color: var(--theme-tab-active-border, var(--theme-side-accent, rgba(96, 165, 250, 0.6)));
}

.side-panel.is-collapsed {
  border-color: var(--theme-side-border, rgba(100, 116, 139, 0.45));
}

.session-body {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.session-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 10px 8px;
  border-bottom: 1px solid var(--theme-side-border, rgba(100, 116, 139, 0.28));
}

.session-title {
  font-size: var(--ui-font-size, 12px);
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--theme-side-text, #e2e8f0);
}

.session-count {
  font-size: 11px;
  color: var(--theme-side-text-muted, #94a3b8);
}

.side-toggle-inline {
  margin-left: auto;
}

.side-toggle-collapsed {
  width: 100%;
  height: 100%;
  border: 0;
  border-radius: 0;
}
</style>

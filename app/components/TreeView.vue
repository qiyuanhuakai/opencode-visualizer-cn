<template>
  <div class="tree-view">
    <div class="tree-header">
      <div class="tree-branch">
        <span class="tree-branch-label" :title="branchTitle">
          <Icon :icon="branchIcon" :width="13" :height="13" class="tree-branch-icon" />
          <span class="tree-branch-name">{{ branchName }}</span>
        </span>
        <span
          v-if="branchInfo && branchInfo.ahead > 0"
          class="tree-branch-ahead"
          :title="`${branchInfo.ahead} commit(s) ahead of ${branchInfo.upstream ?? 'remote'}`"
        >
          <Icon icon="lucide:arrow-up" :width="11" :height="11" title="" />{{ branchInfo.ahead }}
        </span>
        <span
          v-if="branchInfo && branchInfo.behind > 0"
          class="tree-branch-behind"
          :title="`${branchInfo.behind} commit(s) behind ${branchInfo.upstream ?? 'remote'}`"
        >
          <Icon icon="lucide:arrow-down" :width="11" :height="11" title="" />{{ branchInfo.behind }}
        </span>
        <span
          v-if="activeDiffStats && (activeDiffStats.additions > 0 || activeDiffStats.deletions > 0)"
          class="tree-branch-stats"
          role="button"
          tabindex="0"
          :title="diffStatsTitle"
          @click="onDiffStatsClick"
          @keydown.enter.prevent="onDiffStatsClick"
          @keydown.space.prevent="onDiffStatsClick"
        >
          <span v-if="activeDiffStats.additions > 0" class="tree-stat-add"
            >+{{ activeDiffStats.additions }}</span
          >
          <span v-if="activeDiffStats.deletions > 0" class="tree-stat-del"
            >−{{ activeDiffStats.deletions }}</span
          >
        </span>
      </div>
      <div class="tree-tabs" role="tablist" aria-label="Tree mode">
        <button
          type="button"
          class="tree-tab"
          :class="{ 'is-active': viewMode === 'staged' }"
          role="tab"
          :aria-selected="viewMode === 'staged'"
          @click="setViewMode('staged')"
        >
          Staged
        </button>
        <button
          type="button"
          class="tree-tab"
          :class="{ 'is-active': viewMode === 'changes' }"
          role="tab"
          :aria-selected="viewMode === 'changes'"
          @click="setViewMode('changes')"
        >
          Changes
        </button>
        <button
          type="button"
          class="tree-tab"
          :class="{ 'is-active': viewMode === 'all' }"
          role="tab"
          :aria-selected="viewMode === 'all'"
          @click="setViewMode('all')"
        >
          All files
        </button>
      </div>
    </div>
    <div
      v-if="!visibleRows.length && !isLoading"
      class="tree-empty"
      @click="emit('select-file', '')"
    >
      No files.
    </div>
    <div v-else class="tree-scroll" @click="onTreeScrollClick">
      <div
        v-for="row in visibleRows"
        :key="row.node.path"
        class="tree-row"
        :class="[
          {
            'is-directory': row.node.type === 'directory',
            'is-file': row.node.type !== 'directory',
            'is-selected': selectedPath === row.node.path,
            'is-ignored': row.node.ignored,
            'is-deleted':
              row.node.type !== 'directory' && displayStatus(row.node.path)?.code === 'D',
            'has-status': hasAnyStatus(row.node.path),
          },
          rowStatusClass(row.node.path),
        ]"
        :style="{ '--indent': String(row.depth) }"
        @click="onRowClick(row, $event)"
        @dblclick="onRowDoubleClick(row)"
      >
        <button
          v-if="row.node.type === 'directory'"
          type="button"
          class="tree-toggle"
          :aria-label="isExpanded(row.node.path) ? 'Collapse directory' : 'Expand directory'"
          @click.stop="emit('toggle-dir', row.node.path)"
        >
          <Icon
            :icon="isExpanded(row.node.path) ? 'lucide:chevron-down' : 'lucide:chevron-right'"
            :width="14"
            :height="14"
          />
        </button>
        <span v-else class="tree-toggle tree-toggle-spacer"></span>
        <span class="tree-icon">{{ row.node.type === 'directory' ? '📁' : '📄' }}</span>
        <span class="tree-name">{{ row.node.name }}</span>
        <button
          v-if="displayStatus(row.node.path) && row.node.type !== 'directory'"
          type="button"
          class="tree-status tree-status-button"
          :class="statusClass(displayStatus(row.node.path))"
          @click.stop="onStatusClick(row.node.path)"
          @dblclick.stop
        >
          {{ statusLabel(displayStatus(row.node.path)?.code) }}
        </button>
      </div>
      <div v-if="isLoading" class="tree-loading">Loading...</div>
      <div v-if="error" class="tree-error">{{ error }}</div>
    </div>
    <div class="tree-statusbar">
      <div class="tree-statusbar-left"></div>
      <div class="tree-statusbar-right">
        <button
          type="button"
          class="tree-statusbar-btn"
          aria-label="Reload file tree"
          @click="emit('reload')"
        >
          <Icon icon="lucide:refresh-cw" :width="13" :height="13" />
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { Icon } from '@iconify/vue';
import Dropdown from './Dropdown.vue';
import DropdownItem from './Dropdown/Item.vue';

export type TreeNode = {
  name: string;
  path: string;
  type: 'directory' | 'file';
  children?: TreeNode[];
  ignored?: boolean;
  synthetic?: boolean;
};

export type GitStatusCode = '' | 'M' | 'A' | 'D' | 'R' | 'C' | '?';

export type GitFileStatus = {
  path: string;
  index: GitStatusCode;
  worktree: GitStatusCode;
  origPath?: string;
};

export type GitBranchInfo = {
  branch: string;
  upstream?: string;
  ahead: number;
  behind: number;
  headShort?: string;
};

export type GitDiffStatsEntry = {
  additions: number;
  deletions: number;
};

export type GitDiffStats = {
  staged: GitDiffStatsEntry;
  unstaged: GitDiffStatsEntry;
};

type TreeViewMode = 'staged' | 'changes' | 'all';

type DisplayStatus = {
  code: GitStatusCode;
  staged: boolean;
};

const props = defineProps<{
  rootNodes: TreeNode[];
  expandedPaths: string[];
  selectedPath?: string;
  isLoading: boolean;
  error?: string;
  gitStatusByPath?: Record<string, GitFileStatus>;
  branchInfo?: GitBranchInfo | null;
  diffStats?: GitDiffStats | null;
  directoryName?: string;
}>();

const emit = defineEmits<{
  (event: 'toggle-dir', path: string): void;
  (event: 'select-file', path: string): void;
  (event: 'open-diff', payload: { path: string; staged: boolean }): void;
  (event: 'open-diff-all', payload: { mode: 'staged' | 'changes' | 'all' }): void;
  (event: 'open-file', path: string): void;
  (event: 'reload'): void;
}>();

const viewMode = ref<TreeViewMode>('all');
const expanded = computed(() => new Set(props.expandedPaths));
const branchIcon = computed(() => (props.branchInfo ? 'lucide:git-branch' : 'lucide:folder'));
const branchName = computed(() => props.branchInfo?.branch ?? props.directoryName ?? 'no git');

const branchTitle = computed(() => {
  const info = props.branchInfo;
  if (!info) {
    if (props.directoryName) return `Directory: ${props.directoryName}`;
    return 'Git status unavailable';
  }
  const head = info.headShort ? ` (${info.headShort})` : '';
  const tracking = info.upstream ? ` tracking ${info.upstream}` : '';
  return `${info.branch}${head}${tracking}`;
});

const activeDiffStats = computed((): GitDiffStatsEntry | null => {
  const stats = props.diffStats;
  if (!stats) return null;
  if (viewMode.value === 'staged') return stats.staged;
  if (viewMode.value === 'changes') return stats.unstaged;
  return {
    additions: stats.staged.additions + stats.unstaged.additions,
    deletions: stats.staged.deletions + stats.unstaged.deletions,
  };
});

const diffStatsTitle = computed(() => {
  const stats = activeDiffStats.value;
  if (!stats) return '';
  const parts: string[] = [];
  if (stats.additions > 0) parts.push(`+${stats.additions} insertions`);
  if (stats.deletions > 0) parts.push(`−${stats.deletions} deletions`);
  return `${parts.join(', ')} (click to open diff)`;
});

function setViewMode(mode: TreeViewMode) {
  viewMode.value = mode;
}

function sortNodes(nodes: TreeNode[]) {
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function cloneNodes(nodes: TreeNode[]): TreeNode[] {
  return nodes.map((node) => ({
    ...node,
    children: node.children ? cloneNodes(node.children) : undefined,
  }));
}

function normalizePath(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '.') return '';
  return trimmed
    .replace(/^\.\//, '')
    .replace(/^(\.\.\/)+/, '')
    .replace(/^\//, '')
    .replace(/\/$/, '');
}

function hasStaged(status: GitFileStatus) {
  return status.index !== '' && status.index !== '?';
}

function hasChanges(status: GitFileStatus) {
  return status.index === '?' || status.worktree === '?' || status.worktree !== '';
}

function needsPseudoNode(status: GitFileStatus) {
  if (status.index === '?' || status.worktree === '?') return true;
  if (status.index === 'A' || status.index === 'D') return true;
  if (status.worktree === 'A' || status.worktree === 'D') return true;
  return false;
}

function withPseudoNodes(
  nodes: TreeNode[],
  statusByPath: Record<string, GitFileStatus>,
): TreeNode[] {
  const result = cloneNodes(nodes);
  const missingPaths = Object.values(statusByPath)
    .filter((status) => needsPseudoNode(status))
    .map((status) => normalizePath(status.path))
    .filter((path) => path.length > 0)
    .sort((a, b) => a.split('/').length - b.split('/').length);

  missingPaths.forEach((targetPath) => {
    const segments = targetPath.split('/').filter(Boolean);
    if (!segments.length) return;
    let cursor = result;
    let currentPath = '';
    segments.forEach((segment, index) => {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const isLeaf = index === segments.length - 1;
      let node = cursor.find((item) => item.path === currentPath);
      if (!node) {
        node = {
          name: segment,
          path: currentPath,
          type: isLeaf ? 'file' : 'directory',
          children: isLeaf ? undefined : [],
          ignored: false,
          synthetic: true,
        };
        cursor.push(node);
        sortNodes(cursor);
      }
      if (isLeaf) {
        node.synthetic = true;
      } else {
        if (node.type !== 'directory') {
          node.type = 'directory';
        }
        if (!node.children) node.children = [];
        cursor = node.children;
      }
    });
  });

  return result;
}

function filterByPredicate(nodes: TreeNode[], predicate: (path: string) => boolean): TreeNode[] {
  const result: TreeNode[] = [];
  nodes.forEach((node) => {
    const children = node.children ? filterByPredicate(node.children, predicate) : undefined;
    const matched = predicate(node.path);
    if (!matched && (!children || children.length === 0)) return;
    result.push({
      ...node,
      children,
    });
  });
  return result;
}

const normalizedNodes = computed(() =>
  withPseudoNodes(props.rootNodes, props.gitStatusByPath ?? {}),
);

const displayNodes = computed(() => {
  if (viewMode.value === 'all') return normalizedNodes.value;
  if (viewMode.value === 'staged') {
    return filterByPredicate(normalizedNodes.value, (path) => {
      const status = props.gitStatusByPath?.[path];
      return Boolean(status && hasStaged(status));
    });
  }
  return filterByPredicate(normalizedNodes.value, (path) => {
    const status = props.gitStatusByPath?.[path];
    return Boolean(status && hasChanges(status));
  });
});

const visibleRows = computed(() => {
  const rows: Array<{ node: TreeNode; depth: number }> = [];
  const pushRows = (nodes: TreeNode[], depth: number) => {
    nodes.forEach((node) => {
      rows.push({ node, depth });
      if (node.type === 'directory' && expanded.value.has(node.path) && node.children?.length) {
        pushRows(node.children, depth + 1);
      }
    });
  };
  pushRows(displayNodes.value, 0);
  return rows;
});

function isExpanded(path: string) {
  return expanded.value.has(path);
}

function displayStatus(path: string): DisplayStatus | null {
  const status = props.gitStatusByPath?.[path];
  if (!status) return null;

  if (viewMode.value === 'staged') {
    if (!hasStaged(status)) return null;
    return {
      code: status.index,
      staged: true,
    };
  }

  if (viewMode.value === 'changes') {
    if (!hasChanges(status)) return null;
    if (status.index === '?' || status.worktree === '?') {
      return {
        code: '?',
        staged: false,
      };
    }
    return {
      code: status.worktree,
      staged: false,
    };
  }

  if (status.index === '?' || status.worktree === '?') {
    return {
      code: '?',
      staged: false,
    };
  }
  if (status.worktree !== '') {
    return {
      code: status.worktree,
      staged: false,
    };
  }
  if (status.index !== '') {
    return {
      code: status.index,
      staged: true,
    };
  }
  return null;
}

function hasAnyStatus(path: string) {
  return Boolean(props.gitStatusByPath?.[path]);
}

function statusLabel(code?: GitStatusCode) {
  if (code === '?') return 'U';
  if (code === 'A') return 'A';
  if (code === 'D') return 'D';
  if (code === 'M') return 'M';
  if (code === 'R') return 'R';
  if (code === 'C') return 'C';
  return '';
}

function statusClass(status: DisplayStatus | null) {
  if (!status) return '';
  const classes: string[] = [status.staged ? 'is-staged' : 'is-unstaged'];
  if (status.code === 'M') classes.push('is-modified');
  else if (status.code === 'A') classes.push('is-added');
  else if (status.code === 'D') classes.push('is-deleted-status');
  else if (status.code === 'R') classes.push('is-renamed');
  else if (status.code === '?') classes.push('is-untracked');
  else if (status.code === 'C') classes.push('is-copied');
  return classes.join(' ');
}

function rowStatusClass(path: string) {
  const status = displayStatus(path);
  if (!status) return '';
  if (status.code === 'M') return 'row-modified';
  if (status.code === 'A') return 'row-added';
  if (status.code === 'D') return 'row-deleted';
  if (status.code === 'R') return 'row-renamed';
  if (status.code === '?') return 'row-untracked';
  if (status.code === 'C') return 'row-copied';
  return '';
}

function onStatusClick(path: string) {
  const status = displayStatus(path);
  if (!status) return;
  emit('open-diff', { path, staged: status.staged });
}

function onDiffStatsClick() {
  emit('open-diff-all', { mode: viewMode.value });
}

function onTreeScrollClick(event: MouseEvent) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest('.tree-row')) return;
  emit('select-file', '');
}

function onRowClick(row: { node: TreeNode }, event: MouseEvent) {
  if (row.node.type === 'directory') {
    emit('toggle-dir', row.node.path);
    return;
  }
  if (event.detail > 1) return;
  if (props.selectedPath === row.node.path) {
    emit('select-file', '');
    return;
  }
  emit('select-file', row.node.path);
}

function onRowDoubleClick(row: { node: TreeNode }) {
  if (row.node.type === 'directory') return;
  if (row.node.synthetic) {
    const status = displayStatus(row.node.path);
    if (!status || status.code === 'D') return;
  }
  emit('open-file', row.node.path);
}
</script>

<style scoped>
.tree-view {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

.tree-header {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px;
  border-bottom: 1px solid rgba(100, 116, 139, 0.28);
}

.tree-branch {
  display: flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: #94a3b8;
  white-space: nowrap;
  overflow: hidden;
  min-height: 20px;
}

.tree-branch-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow: hidden;
}

.tree-branch-icon {
  color: #60a5fa;
  flex-shrink: 0;
}

.tree-branch-name {
  font-weight: 600;
  color: #cbd5e1;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tree-branch-ahead,
.tree-branch-behind {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  font-size: 10px;
  font-weight: 600;
  padding: 0 4px;
  border-radius: 999px;
  line-height: 16px;
  height: 16px;
}

.tree-branch-ahead {
  color: #86efac;
  background: rgba(74, 222, 128, 0.12);
}

.tree-branch-behind {
  color: #fca5a5;
  background: rgba(248, 113, 113, 0.12);
}

.tree-branch-stats {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  border-radius: 999px;
  padding: 1px 6px;
  transition: background 0.12s ease;
}

.tree-branch-stats:hover {
  background: rgba(51, 65, 85, 0.55);
}

.tree-branch-stats:focus-visible {
  outline: 1px solid rgba(96, 165, 250, 0.7);
  outline-offset: 1px;
}

.tree-stat-add {
  color: #73c991;
}

.tree-stat-del {
  color: #c74e39;
}

.tree-tabs {
  display: inline-flex;
  width: 100%;
  border: 1px solid rgba(100, 116, 139, 0.35);
  border-radius: 8px;
  overflow: hidden;
}

.tree-tab {
  flex: 1;
  border: 0;
  background: rgba(15, 23, 42, 0.7);
  color: #94a3b8;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 6px 0;
  cursor: pointer;
}

.tree-tab + .tree-tab {
  border-left: 1px solid rgba(100, 116, 139, 0.35);
}

.tree-tab.is-active {
  background: rgba(30, 64, 175, 0.45);
  color: #e2e8f0;
}

.tree-empty {
  margin: auto;
  color: rgba(148, 163, 184, 0.9);
  font-size: 12px;
}

.tree-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px;
  user-select: none;
}

.tree-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-height: 24px;
  padding: 2px 6px 2px calc(4px + var(--indent) * 14px);
  border-radius: 6px;
  color: #dbeafe;
  cursor: pointer;
}

.tree-row.is-ignored {
  opacity: 0.45;
}

.tree-row:hover {
  background: rgba(51, 65, 85, 0.55);
}

.tree-row.is-ignored:hover {
  opacity: 0.68;
}

.tree-row.is-selected {
  background: rgba(30, 64, 175, 0.4);
}

.tree-row.is-selected.is-ignored {
  opacity: 0.8;
}

.tree-row.is-deleted .tree-name {
  text-decoration: line-through;
}

.tree-toggle {
  border: 0;
  background: transparent;
  color: #94a3b8;
  width: 16px;
  padding: 0;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.tree-toggle-spacer {
  display: inline-block;
}

.tree-icon {
  width: 16px;
  text-align: center;
}

.tree-name {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* --- Git status badge (base) --- */
.tree-status {
  min-width: 16px;
  text-align: center;
  font-size: 10px;
  font-weight: 700;
  border-radius: 999px;
  border: 1px solid rgba(148, 163, 184, 0.45);
  line-height: 16px;
  height: 16px;
  transition:
    background 0.12s ease,
    color 0.12s ease,
    border-color 0.12s ease;
}

.tree-status-button {
  padding: 0;
  background: transparent;
  cursor: pointer;
}

/* --- VSCode-style per-status-code colors --- */

/* Modified (yellow/amber) */
.tree-status.is-modified {
  color: #e2c08d;
  border-color: rgba(226, 192, 141, 0.55);
}

/* Added (green) */
.tree-status.is-added {
  color: #73c991;
  border-color: rgba(115, 201, 145, 0.55);
}

/* Deleted (red) */
.tree-status.is-deleted-status {
  color: #c74e39;
  border-color: rgba(199, 78, 57, 0.55);
}

/* Renamed (cyan) */
.tree-status.is-renamed {
  color: #4ec9b0;
  border-color: rgba(78, 201, 176, 0.55);
}

/* Untracked (green, same as added) */
.tree-status.is-untracked {
  color: #73c991;
  border-color: rgba(115, 201, 145, 0.55);
}

/* Copied (cyan, same as renamed) */
.tree-status.is-copied {
  color: #4ec9b0;
  border-color: rgba(78, 201, 176, 0.55);
}

/* Staged: slightly brighter/higher saturation */
.tree-status.is-staged.is-modified {
  color: #f0d6a0;
  border-color: rgba(240, 214, 160, 0.65);
}

.tree-status.is-staged.is-added {
  color: #86efac;
  border-color: rgba(134, 239, 172, 0.65);
}

.tree-status.is-staged.is-deleted-status {
  color: #e06050;
  border-color: rgba(224, 96, 80, 0.65);
}

.tree-status.is-staged.is-renamed {
  color: #5ee0c8;
  border-color: rgba(94, 224, 200, 0.65);
}

.tree-status.is-staged.is-copied {
  color: #5ee0c8;
  border-color: rgba(94, 224, 200, 0.65);
}

/* --- Hover: fill background, invert text (knockout effect) --- */
.tree-status-button.is-modified:hover {
  background: #e2c08d;
  color: #1e1e1e;
  border-color: #e2c08d;
}

.tree-status-button.is-added:hover,
.tree-status-button.is-untracked:hover {
  background: #73c991;
  color: #1e1e1e;
  border-color: #73c991;
}

.tree-status-button.is-deleted-status:hover {
  background: #c74e39;
  color: #fff;
  border-color: #c74e39;
}

.tree-status-button.is-renamed:hover,
.tree-status-button.is-copied:hover {
  background: #4ec9b0;
  color: #1e1e1e;
  border-color: #4ec9b0;
}

.tree-status-button.is-staged.is-modified:hover {
  background: #f0d6a0;
  color: #1e1e1e;
  border-color: #f0d6a0;
}

.tree-status-button.is-staged.is-added:hover {
  background: #86efac;
  color: #1e1e1e;
  border-color: #86efac;
}

.tree-status-button.is-staged.is-deleted-status:hover {
  background: #e06050;
  color: #fff;
  border-color: #e06050;
}

.tree-status-button.is-staged.is-renamed:hover,
.tree-status-button.is-staged.is-copied:hover {
  background: #5ee0c8;
  color: #1e1e1e;
  border-color: #5ee0c8;
}

/* --- File name color by status (row-level classes) --- */
.tree-row.row-modified .tree-name {
  color: #e2c08d;
}

.tree-row.row-added .tree-name,
.tree-row.row-untracked .tree-name {
  color: #73c991;
}

.tree-row.row-deleted .tree-name {
  color: #c74e39;
}

.tree-row.row-renamed .tree-name {
  color: #4ec9b0;
}

.tree-row.row-copied .tree-name {
  color: #4ec9b0;
}

.tree-loading,
.tree-error {
  margin-top: 8px;
  font-size: 11px;
  color: #94a3b8;
}

.tree-error {
  color: #fca5a5;
}
.tree-statusbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 8px;
  border-top: 1px solid rgba(100, 116, 139, 0.28);
  flex-shrink: 0;
}

.tree-statusbar-left {
  display: flex;
  align-items: center;
  gap: 4px;
}

.tree-statusbar-right {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-left: auto;
}

.tree-statusbar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 0;
  border-radius: 4px;
  background: transparent;
  color: #94a3b8;
  cursor: pointer;
  padding: 0;
}

.tree-statusbar-btn:hover {
  background: rgba(51, 65, 85, 0.55);
  color: #cbd5e1;
}
</style>

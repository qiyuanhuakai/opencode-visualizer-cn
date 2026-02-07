<template>
  <div class="tree-view">
    <div class="tree-header">
      <div class="tree-tabs" role="tablist" aria-label="Tree mode">
        <button
          type="button"
          class="tree-tab"
          :class="{ 'is-active': viewMode === 'changes' }"
          role="tab"
          :aria-selected="String(viewMode === 'changes')"
          @click="setViewMode('changes')"
        >
          Changes
        </button>
        <button
          type="button"
          class="tree-tab"
          :class="{ 'is-active': viewMode === 'all' }"
          role="tab"
          :aria-selected="String(viewMode === 'all')"
          @click="setViewMode('all')"
        >
          All files
        </button>
      </div>
    </div>
    <div v-if="!visibleRows.length && !isLoading" class="tree-empty">No files.</div>
    <div v-else class="tree-scroll">
      <div
        v-for="row in visibleRows"
        :key="row.node.path"
        class="tree-row"
        :class="{
          'is-directory': row.node.type === 'directory',
          'is-file': row.node.type !== 'directory',
          'is-selected': selectedPath === row.node.path,
          'is-ignored': row.node.ignored,
          'is-synthetic': row.node.synthetic,
        }"
        :style="{ '--indent': String(row.depth) }"
        @click="onRowClick(row)"
        @dblclick="onRowDoubleClick(row)"
      >
        <button
          v-if="row.node.type === 'directory'"
          type="button"
          class="tree-toggle"
          :aria-label="isExpanded(row.node.path) ? 'Collapse directory' : 'Expand directory'"
          @click.stop="emit('toggle-dir', row.node.path)"
        >
          {{ isExpanded(row.node.path) ? '▾' : '▸' }}
        </button>
        <span v-else class="tree-toggle tree-toggle-spacer"></span>
        <span class="tree-icon">{{ row.node.type === 'directory' ? '📁' : '📄' }}</span>
        <span class="tree-name">{{ row.node.name }}</span>
        <button
          v-if="statusFor(row.node.path)"
          type="button"
          class="tree-status tree-status-button"
          :class="`is-${statusFor(row.node.path)}`"
          @click.stop="emit('open-diff', row.node.path)"
          @dblclick.stop
        >
          {{ statusLabel(statusFor(row.node.path)) }}
        </button>
      </div>
      <div v-if="isLoading" class="tree-loading">Loading...</div>
      <div v-if="error" class="tree-error">{{ error }}</div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';

export type TreeNode = {
  name: string;
  path: string;
  type: 'directory' | 'file';
  children?: TreeNode[];
  ignored?: boolean;
  synthetic?: boolean;
};

type TreeStatus = 'added' | 'modified' | 'deleted';
type TreeViewMode = 'changes' | 'all';

const props = defineProps<{
  rootNodes: TreeNode[];
  expandedPaths: string[];
  selectedPath?: string;
  isLoading: boolean;
  error?: string;
  statusByPath?: Record<string, TreeStatus>;
}>();

const emit = defineEmits<{
  (event: 'toggle-dir', path: string): void;
  (event: 'select-file', path: string): void;
  (event: 'open-diff', path: string): void;
  (event: 'open-file', path: string): void;
}>();

const viewMode = ref<TreeViewMode>('all');
const expanded = computed(() => new Set(props.expandedPaths));

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
  return trimmed.replace(/^\.\//, '').replace(/^(\.\.\/)+/, '').replace(/^\//, '').replace(/\/$/, '');
}

function withDeletedPseudoNodes(nodes: TreeNode[], statusByPath: Record<string, TreeStatus>): TreeNode[] {
  const result = cloneNodes(nodes);
  const deletedPaths = Object.entries(statusByPath)
    .filter(([, status]) => status === 'deleted')
    .map(([path]) => normalizePath(path))
    .filter((path) => path.length > 0)
    .sort((a, b) => a.split('/').length - b.split('/').length);

  deletedPaths.forEach((deletedPath) => {
    const segments = deletedPath.split('/').filter(Boolean);
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

function filterChanges(nodes: TreeNode[], statusByPath: Record<string, TreeStatus>): TreeNode[] {
  return nodes
    .map((node) => {
      const children = node.children ? filterChanges(node.children, statusByPath) : undefined;
      const changed = Boolean(statusByPath[node.path]);
      if (!changed && (!children || children.length === 0)) return null;
      return {
        ...node,
        children,
      };
    })
    .filter((node): node is TreeNode => Boolean(node));
}

const normalizedNodes = computed(() => withDeletedPseudoNodes(props.rootNodes, props.statusByPath ?? {}));

const displayNodes = computed(() => {
  if (viewMode.value === 'all') return normalizedNodes.value;
  return filterChanges(normalizedNodes.value, props.statusByPath ?? {});
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

function statusFor(path: string) {
  return props.statusByPath?.[path];
}

function statusLabel(status?: TreeStatus) {
  if (status === 'added') return 'A';
  if (status === 'deleted') return 'D';
  if (status === 'modified') return 'M';
  return '';
}

function onRowClick(row: { node: TreeNode }) {
  if (row.node.type === 'directory') {
    emit('toggle-dir', row.node.path);
    return;
  }
  emit('select-file', row.node.path);
}

function onRowDoubleClick(row: { node: TreeNode }) {
  if (row.node.type !== 'directory' && !row.node.synthetic) emit('open-file', row.node.path);
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
  align-items: center;
  justify-content: space-between;
  padding: 8px;
  border-bottom: 1px solid rgba(100, 116, 139, 0.28);
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

.tree-row.is-synthetic .tree-name {
  font-style: italic;
}

.tree-toggle {
  border: 0;
  background: transparent;
  color: #94a3b8;
  width: 16px;
  padding: 0;
  cursor: pointer;
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

.tree-status {
  min-width: 16px;
  text-align: center;
  font-size: 10px;
  border-radius: 999px;
  border: 1px solid rgba(148, 163, 184, 0.45);
  line-height: 16px;
  height: 16px;
}

.tree-status-button {
  padding: 0;
  background: transparent;
  cursor: pointer;
}

.tree-status.is-added {
  color: #86efac;
  border-color: rgba(74, 222, 128, 0.6);
}

.tree-status.is-modified {
  color: #fde68a;
  border-color: rgba(250, 204, 21, 0.6);
}

.tree-status.is-deleted {
  color: #fecaca;
  border-color: rgba(248, 113, 113, 0.6);
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
</style>

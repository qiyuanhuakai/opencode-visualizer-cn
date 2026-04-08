<template>
  <div class="tree-view">
    <div class="tree-header">
      <div class="tree-branch">
        <Dropdown
          v-model:open="branchMenuOpen"
          class="tree-branch-picker-dropdown"
          auto-close
          :popup-style="{ width: '360px' }"
          @update:open="onBranchMenuOpenChange"
          @select="onBranchSelect"
        >
          <template #trigger>
            <button
              type="button"
              class="tree-branch-label tree-branch-picker-trigger"
              :title="branchTitle"
              @click.stop="onBranchPickerToggle"
            >
              <Icon :icon="branchIcon" :width="13" :height="13" class="tree-branch-icon" />
              <span class="tree-branch-name">{{ branchName }}</span>
              <Icon
                icon="lucide:chevron-down"
                :width="11"
                :height="11"
                class="tree-branch-chevron"
              />
            </button>
          </template>
          <DropdownSearch v-model="branchSearchQuery" :placeholder="$t('treeView.searchBranches')" />
          <div v-if="branchListLoading" class="tree-branch-menu-empty">{{ $t('treeView.loadingBranches') }}</div>
          <template v-else>
            <DropdownLabel v-if="filteredLocalBranches.length > 0">{{ $t('treeView.local') }}</DropdownLabel>
            <DropdownItem
              v-for="entry in filteredLocalBranches"
              :key="entry.refname"
              :value="branchSwitchCommand(entry)"
              :disabled="isBranchSwitchDisabled(entry)"
              :title="branchDisabledReason(entry)"
            >
              <div class="tree-branch-menu-content" :class="{ 'is-muted': entry.isCurrent }">
                <div class="tree-branch-menu-line1">
                  <Icon
                    v-if="entry.isCurrent"
                    icon="lucide:check"
                    :width="12"
                    :height="12"
                    class="tree-branch-current-icon"
                  />
                  <span v-else class="tree-branch-current-spacer"></span>
                  <span class="tree-branch-menu-name">{{ entry.displayName }}</span>
                </div>
                <div class="tree-branch-menu-line2">
                  <span class="tree-branch-current-spacer"></span>
                  <span class="tree-branch-menu-meta" :title="branchSummary(entry)">
                    {{ branchSummary(entry) }}
                  </span>
                </div>
              </div>
              <template #action>
                <div class="tree-branch-menu-actions">
                  <button
                    v-if="canMergeBranch(entry)"
                    type="button"
                    class="tree-branch-action-btn tree-branch-merge-btn"
                    :title="$t('treeView.mergeRefTitle')"
                    @click.stop="onBranchMerge(entry)"
                  >
                    <Icon icon="lucide:git-merge" :width="14" :height="14" />
                  </button>
                  <span v-else class="tree-branch-action-spacer"></span>
                  <button
                    type="button"
                    class="tree-branch-action-btn tree-branch-fork-btn"
                    :title="$t('treeView.createBranchTitle')"
                    @click.stop="onBranchFork(entry)"
                  >
                    <Icon icon="lucide:git-branch-plus" :width="14" :height="14" />
                  </button>
                  <button
                    v-if="canDeleteLocalBranch(entry)"
                    type="button"
                    class="tree-branch-action-btn tree-branch-delete-btn"
                    :title="$t('treeView.deleteBranchTooltip')"
                    @click.stop="onBranchDelete(entry)"
                  >
                    <Icon icon="lucide:trash-2" :width="14" :height="14" />
                  </button>
                  <span v-else class="tree-branch-action-spacer"></span>
                </div>
              </template>
            </DropdownItem>
            <template v-for="group in filteredRemoteBranchGroups" :key="group.key">
              <DropdownLabel>
                {{ group.label }}
                <template #action>
                  <button
                    type="button"
                    class="tree-branch-action-btn tree-branch-fetch-btn"
                    :title="$t('treeView.fetch', { remote: group.key })"
                    @click.stop="onRemoteFetch(group.key)"
                  >
                    <Icon icon="lucide:refresh-cw" :width="12" :height="12" />
                  </button>
                </template>
              </DropdownLabel>
              <DropdownItem
                v-for="entry in group.entries"
                :key="entry.refname"
                :value="branchSwitchCommand(entry)"
                :disabled="isBranchSwitchDisabled(entry)"
                :title="branchDisabledReason(entry)"
              >
                <div class="tree-branch-menu-content" :class="{ 'is-muted': entry.isCurrent }">
                  <div class="tree-branch-menu-line1">
                    <span class="tree-branch-current-spacer"></span>
                    <span class="tree-branch-menu-name">{{ entry.displayName }}</span>
                  </div>
                  <div class="tree-branch-menu-line2">
                    <span class="tree-branch-current-spacer"></span>
                    <span class="tree-branch-menu-meta" :title="branchSummary(entry)">
                      {{ branchSummary(entry) }}
                    </span>
                  </div>
                </div>
                <template #action>
                  <div class="tree-branch-menu-actions">
                    <button
                      v-if="canMergeBranch(entry)"
                      type="button"
                      class="tree-branch-action-btn tree-branch-merge-btn"
                    :title="$t('treeView.mergeTooltip')"
                      @click.stop="onBranchMerge(entry)"
                    >
                      <Icon icon="lucide:git-merge" :width="14" :height="14" />
                    </button>
                    <span v-else class="tree-branch-action-spacer"></span>
                    <button
                      type="button"
                      class="tree-branch-action-btn tree-branch-fork-btn"
                    :title="$t('treeView.createBranchTooltip')"
                      @click.stop="onBranchFork(entry)"
                    >
                      <Icon icon="lucide:git-branch-plus" :width="14" :height="14" />
                    </button>
                    <span class="tree-branch-action-spacer"></span>
                  </div>
                </template>
              </DropdownItem>
            </template>
            <div v-if="!hasFilteredBranches" class="tree-branch-menu-empty">{{ $t('treeView.noBranches') }}</div>
          </template>
        </Dropdown>
        <Dropdown
          v-if="branchInfo && branchInfo.ahead > 0"
          v-model:open="pushMenuOpen"
          class="tree-branch-command-dropdown"
          auto-close
          :popup-style="{ width: '120px' }"
          @select="onBranchCommandSelect"
        >
          <template #trigger>
            <button
              type="button"
              class="tree-branch-command-trigger"
              :title="$t('treeView.aheadOfRemote', { count: branchInfo.ahead, remote: branchInfo.upstream || $t('treeView.remoteFallback') })"
              @click.stop="pushMenuOpen = !pushMenuOpen"
            >
              <span class="tree-branch-ahead">
                <Icon icon="lucide:arrow-up" :width="11" :height="11" title="" />{{
                  branchInfo.ahead
                }}
              </span>
            </button>
          </template>
          <DropdownItem value="git push" class="tree-branch-cmd-danger">git push</DropdownItem>
        </Dropdown>
        <Dropdown
          v-if="branchInfo && branchInfo.behind > 0"
          v-model:open="pullMenuOpen"
          class="tree-branch-command-dropdown"
          auto-close
          :popup-style="{ minWidth: '220px' }"
          @select="onBranchCommandSelect"
        >
          <template #trigger>
            <button
              type="button"
              class="tree-branch-command-trigger"
              :title="$t('treeView.behindRemote', { count: branchInfo.behind, remote: branchInfo.upstream || $t('treeView.remoteFallback') })"
              @click.stop="pullMenuOpen = !pullMenuOpen"
            >
              <span class="tree-branch-behind">
                <Icon icon="lucide:arrow-down" :width="11" :height="11" title="" />{{
                  branchInfo.behind
                }}
              </span>
            </button>
          </template>
          <DropdownItem
            v-if="branchInfo?.upstream"
            :value="`git merge --ff-only ${shellQuote(branchInfo.upstream)}`"
          >
            git merge --ff-only &lt;upstream&gt;
          </DropdownItem>
          <DropdownItem
            v-if="branchInfo?.upstream"
            :value="`git merge ${shellQuote(branchInfo.upstream)}`"
            class="tree-branch-cmd-merge"
          >
            <Icon icon="lucide:git-merge" :width="12" :height="12" />
            git merge &lt;upstream&gt;
          </DropdownItem>
          <DropdownItem
            v-if="branchInfo?.upstream"
            :value="`git rebase ${shellQuote(branchInfo.upstream)}`"
            class="tree-branch-cmd-rebase"
          >
            git rebase &lt;upstream&gt;
          </DropdownItem>
          <DropdownItem value="git pull" class="tree-branch-cmd-danger">git pull</DropdownItem>
        </Dropdown>
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
      <div class="tree-tabs" role="tablist" :aria-label="$t('treeView.treeMode')">
        <button
          type="button"
          class="tree-tab"
          :class="{ 'is-active': viewMode === 'staged' }"
          role="tab"
          :aria-selected="viewMode === 'staged'"
          @click="setViewMode('staged')"
        >
          {{ $t('treeView.staged') }}
        </button>
        <button
          type="button"
          class="tree-tab"
          :class="{ 'is-active': viewMode === 'changes' }"
          role="tab"
          :aria-selected="viewMode === 'changes'"
          @click="setViewMode('changes')"
        >
          {{ $t('treeView.changes') }}
        </button>
        <button
          type="button"
          class="tree-tab"
          :class="{ 'is-active': viewMode === 'all' }"
          role="tab"
          :aria-selected="viewMode === 'all'"
          @click="setViewMode('all')"
        >
          {{ $t('treeView.allFiles') }}
        </button>
      </div>
    </div>
    <div
      v-if="!flattenedRows.length && !isLoading"
      class="tree-empty"
      @click="emit('select-file', '')"
    >
      {{ $t('treeView.noFiles') }}
    </div>
    <div
      v-else
      ref="scrollContainerRef"
      class="tree-scroll"
      @scroll="onScroll"
      @click="onTreeScrollClick"
    >
      <!-- Virtual scroll spacer -->
      <div
        class="tree-virtual-spacer"
        :style="{ height: `${totalHeight}px` }"
      >
        <!-- Visible rows -->
        <div
          v-for="row in visibleRows"
          :key="row.node.path"
          class="tree-row"
          :class="row.classList"
          :style="{ transform: `translateY(${row.offsetY}px)`, '--indent': String(row.depth) }"
          @click="onRowClick(row, $event)"
          @dblclick="onRowDoubleClick(row)"
        >
          <button
            v-if="row.node.type === 'directory'"
            type="button"
            class="tree-toggle"
            :aria-label="row.isExpanded ? $t('treeView.collapseDirectory') : $t('treeView.expandDirectory')"
            @click.stop="emit('toggle-dir', row.node.path)"
          >
            <Icon
              :icon="row.isExpanded ? 'lucide:chevron-down' : 'lucide:chevron-right'"
              :width="14"
              :height="14"
            />
          </button>
          <span v-else class="tree-toggle tree-toggle-spacer"></span>
          <span class="tree-icon">{{ row.node.type === 'directory' ? '📁' : '📄' }}</span>
          <span class="tree-name">{{ row.node.name }}</span>
          <button
            v-if="row.displayStatus && row.node.type !== 'directory'"
            type="button"
            class="tree-status tree-status-button"
            :class="row.statusClass"
            @click.stop="onStatusClick(row.node.path, row.displayStatus)"
            @dblclick.stop
          >
            {{ statusLabel(row.displayStatus.code) }}
          </button>
        </div>
      </div>
      <div v-if="isLoading" class="tree-loading">{{ $t('common.loading') }}</div>
      <div v-if="error" class="tree-error">{{ error }}</div>
    </div>
    <div class="tree-statusbar">
      <div class="tree-statusbar-left"></div>
      <div class="tree-statusbar-right">
        <button
          type="button"
          class="tree-statusbar-btn"
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
import { computed, ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import { useI18n } from 'vue-i18n';
import { Icon } from '@iconify/vue';

import type { BranchEntry } from '../types/git';
import Dropdown from './Dropdown.vue';
import DropdownItem from './Dropdown/Item.vue';
import DropdownLabel from './Dropdown/Label.vue';
import DropdownSearch from './Dropdown/Search.vue';

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

type BranchGroup = {
  key: string;
  label: string;
  entries: BranchEntry[];
};

// Virtual scroll row type with pre-computed properties
type VirtualRow = {
  node: TreeNode;
  depth: number;
  index: number;
  offsetY: number;
  isExpanded: boolean;
  classList: string[];
  displayStatus: DisplayStatus | null;
  statusClass: string;
};

const { t } = useI18n();

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
  branchEntries?: BranchEntry[];
  branchListLoading?: boolean;
  runShellCommand?: (command: string) => Promise<void>;
  ensureBranchEntriesLoaded?: () => Promise<void>;
}>();

const emit = defineEmits<{
  (event: 'toggle-dir', path: string): void;
  (event: 'select-file', path: string): void;
  (event: 'open-diff', payload: { path: string; staged: boolean }): void;
  (event: 'open-diff-all', payload: { mode: 'staged' | 'changes' | 'all' }): void;
  (event: 'open-file', path: string): void;
  (event: 'reload'): void;
}>();

// Virtual scroll configuration
const ROW_HEIGHT = 24;
const OVERSCAN = 5; // Number of extra rows to render above/below viewport
const BRANCH_SEARCH_DEBOUNCE_MS = 120;

const viewMode = ref<TreeViewMode>('all');
const branchMenuOpen = ref(false);
const branchSearchQuery = ref('');
const debouncedBranchSearchQuery = ref('');
const pushMenuOpen = ref(false);
const pullMenuOpen = ref(false);
const scrollContainerRef = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const containerHeight = ref(0);
let pendingScrollTop = 0;
let scrollFrameId: number | null = null;
let containerHeightFrameId: number | null = null;
let branchSearchDebounceTimer: ReturnType<typeof setTimeout> | null = null;

const expanded = computed(() => new Set(props.expandedPaths));
const branchIcon = computed(() => (props.branchInfo ? 'lucide:git-branch' : 'lucide:folder'));
const branchName = computed(() => props.branchInfo?.branch ?? props.directoryName ?? t('treeView.noGit'));

// Scroll handling
function onScroll() {
  if (!scrollContainerRef.value) return;
  pendingScrollTop = scrollContainerRef.value.scrollTop;
  if (scrollFrameId !== null) return;
  scrollFrameId = requestAnimationFrame(() => {
    scrollFrameId = null;
    scrollTop.value = pendingScrollTop;
  });
}

function updateContainerHeight() {
  if (!scrollContainerRef.value) return;
  const nextHeight = scrollContainerRef.value.clientHeight;
  if (containerHeight.value === nextHeight) return;
  containerHeight.value = nextHeight;
}

function scheduleContainerHeightUpdate() {
  if (containerHeightFrameId !== null) return;
  containerHeightFrameId = requestAnimationFrame(() => {
    containerHeightFrameId = null;
    updateContainerHeight();
  });
}

let containerResizeObserver: ResizeObserver | undefined;

function setupContainerResizeObserver() {
  containerResizeObserver?.disconnect();
  containerResizeObserver = undefined;
  if (typeof ResizeObserver === 'undefined') return;
  const target = scrollContainerRef.value;
  if (!target) return;
  containerResizeObserver = new ResizeObserver(() => {
    scheduleContainerHeightUpdate();
  });
  containerResizeObserver.observe(target);
}

onMounted(() => {
  updateContainerHeight();
  setupContainerResizeObserver();
  window.addEventListener('resize', scheduleContainerHeightUpdate);
});

onBeforeUnmount(() => {
  containerResizeObserver?.disconnect();
  containerResizeObserver = undefined;
  window.removeEventListener('resize', scheduleContainerHeightUpdate);
  if (scrollFrameId !== null) {
    cancelAnimationFrame(scrollFrameId);
    scrollFrameId = null;
  }
  if (containerHeightFrameId !== null) {
    cancelAnimationFrame(containerHeightFrameId);
    containerHeightFrameId = null;
  }
  if (branchSearchDebounceTimer !== null) {
    clearTimeout(branchSearchDebounceTimer);
    branchSearchDebounceTimer = null;
  }
});

watch(
  branchSearchQuery,
  (value) => {
    if (branchSearchDebounceTimer !== null) {
      clearTimeout(branchSearchDebounceTimer);
    }
    branchSearchDebounceTimer = setTimeout(() => {
      debouncedBranchSearchQuery.value = value;
      branchSearchDebounceTimer = null;
    }, BRANCH_SEARCH_DEBOUNCE_MS);
  },
  { immediate: true },
);

// Watch for data changes and scroll selected into view
watch(() => props.selectedPath, (newPath) => {
  if (!newPath || !scrollContainerRef.value) return;
  nextTick(() => {
    scrollSelectedIntoView(newPath);
  });
});

function scrollSelectedIntoView(path: string) {
  const rowIndex = flattenedRows.value.findIndex(r => r.node.path === path);
  if (rowIndex === -1 || !scrollContainerRef.value) return;
  
  const rowOffset = rowIndex * ROW_HEIGHT;
  const containerScrollTop = scrollContainerRef.value.scrollTop;
  const containerHeight = scrollContainerRef.value.clientHeight;
  
  if (rowOffset < containerScrollTop) {
    scrollContainerRef.value.scrollTop = rowOffset;
  } else if (rowOffset + ROW_HEIGHT > containerScrollTop + containerHeight) {
    scrollContainerRef.value.scrollTop = rowOffset + ROW_HEIGHT - containerHeight;
  }
}

const branchTitle = computed(() => {
  const info = props.branchInfo;
  if (!info) {
    if (props.directoryName) return t('treeView.branch.directory', { name: props.directoryName });
    return t('treeView.branch.gitUnavailable');
  }
  const head = info.headShort ? t('treeView.branch.headPrefix', { short: info.headShort }) : '';
  if (info.upstream) {
    return t('treeView.branch.tracking', { branch: info.branch, head, upstream: info.upstream });
  }
  return t('treeView.branch.currentOnly', { branch: info.branch, head });
});

const filteredLocalBranches = computed(() => {
  const query = debouncedBranchSearchQuery.value.trim().toLowerCase();
  const locals = (props.branchEntries ?? []).filter((entry) => entry.isLocal);
  if (!query) return locals.slice(0, 5);
  return locals.filter((entry) => branchSearchText(entry).includes(query)).slice(0, 5);
});

const filteredRemoteBranchGroups = computed<BranchGroup[]>(() => {
  const query = debouncedBranchSearchQuery.value.trim().toLowerCase();
  const groups = new Map<string, BranchEntry[]>();
  (props.branchEntries ?? []).forEach((entry) => {
    if (entry.isLocal) return;
    if (query && !branchSearchText(entry).includes(query)) return;
    const group = groups.get(entry.remote) ?? [];
    group.push(entry);
    groups.set(entry.remote, group);
  });
  return Array.from(groups, ([key, entries]) => ({
    key,
    label: t('treeView.remote', { name: key }),
    entries: entries.slice(0, 5),
  }));
});

const hasFilteredBranches = computed(
  () =>
    filteredLocalBranches.value.length > 0 ||
    filteredRemoteBranchGroups.value.some((group) => group.entries.length > 0),
);

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
  if (stats.additions > 0) parts.push(t('treeView.diffStats.insertions', { count: stats.additions }));
  if (stats.deletions > 0) parts.push(t('treeView.diffStats.deletions', { count: stats.deletions }));
  return `${parts.join(', ')} (${t('treeView.diffStats.clickToOpen')})`;
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

// Optimized flattened rows with pre-computed properties
const flattenedRows = computed<VirtualRow[]>(() => {
  const rows: VirtualRow[] = [];
  let index = 0;
  
  const pushRows = (nodes: TreeNode[], depth: number) => {
    nodes.forEach((node) => {
      const displayStatus = getDisplayStatus(node.path);
      const isExpanded = expanded.value.has(node.path);
      const isSelected = props.selectedPath === node.path;
      const hasStatus = Boolean(props.gitStatusByPath?.[node.path]);
      
      // Pre-compute class list
      const classList: string[] = [];
      if (node.type === 'directory') classList.push('is-directory');
      else classList.push('is-file');
      if (isSelected) classList.push('is-selected');
      if (node.ignored) classList.push('is-ignored');
      if (node.type !== 'directory' && displayStatus?.code === 'D') {
        classList.push('is-deleted');
      }
      if (hasStatus) classList.push('has-status');
      
      const rowStatusClassName = getRowStatusClass(displayStatus);
      if (rowStatusClassName) classList.push(rowStatusClassName);
      
      rows.push({
        node,
        depth,
        index: index++,
        offsetY: (index - 1) * ROW_HEIGHT,
        isExpanded,
        classList,
        displayStatus,
        statusClass: getStatusClass(displayStatus),
      });
      
      if (node.type === 'directory' && isExpanded && node.children?.length) {
        pushRows(node.children, depth + 1);
      }
    });
  };
  
  pushRows(displayNodes.value, 0);
  return rows;
});

const totalHeight = computed(() => flattenedRows.value.length * ROW_HEIGHT);

// Virtual scroll visible rows
const visibleRows = computed(() => {
  const startIdx = Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN);
  const endIdx = Math.min(
    flattenedRows.value.length,
    Math.ceil((scrollTop.value + containerHeight.value) / ROW_HEIGHT) + OVERSCAN
  );
  return flattenedRows.value.slice(startIdx, endIdx);
});

function getDisplayStatus(path: string): DisplayStatus | null {
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

function getStatusClass(status: DisplayStatus | null): string {
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

function getRowStatusClass(status: DisplayStatus | null): string {
  if (!status) return '';
  if (status.code === 'M') return 'row-modified';
  if (status.code === 'A') return 'row-added';
  if (status.code === 'D') return 'row-deleted';
  if (status.code === 'R') return 'row-renamed';
  if (status.code === '?') return 'row-untracked';
  if (status.code === 'C') return 'row-copied';
  return '';
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

function onStatusClick(path: string, status: DisplayStatus | null) {
  if (!status) return;
  emit('open-diff', { path, staged: status.staged });
}

function onDiffStatsClick() {
  emit('open-diff-all', { mode: viewMode.value });
}

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function branchSearchText(entry: BranchEntry) {
  return `${entry.displayName} ${entry.refnameShort} ${entry.hash} ${entry.subject}`.toLowerCase();
}

function branchSummary(entry: BranchEntry) {
  return entry.subject ? `${entry.hash} ${entry.subject}` : entry.hash;
}

function branchSwitchCommand(entry: BranchEntry) {
  if (entry.isCurrent) return '';
  if (!entry.isLocal) {
    return `git switch --track ${shellQuote(entry.refnameShort)}`;
  }
  return `git switch ${shellQuote(entry.displayName)}`;
}

function isBranchSwitchDisabled(entry: BranchEntry) {
  if (entry.isWorktree && !entry.isCurrent) return true;
  if (!entry.isLocal && entry.hasLocalCounterpart) return true;
  return false;
}

function branchDisabledReason(entry: BranchEntry) {
  if (entry.isCurrent) return t('treeView.disabledReason.alreadyOnBranch');
  if (entry.isWorktree) return t('treeView.disabledReason.worktreeInUse');
  if (!entry.isLocal && entry.hasLocalCounterpart) {
    return t('treeView.disabledReason.localExists');
  }
  return '';
}

function canDeleteLocalBranch(entry: BranchEntry) {
  return entry.isLocal && !entry.isCurrent && !entry.isWorktree;
}

function canMergeBranch(entry: BranchEntry) {
  return !entry.isCurrent;
}

function branchMergeTarget(entry: BranchEntry) {
  return entry.isLocal ? entry.displayName : entry.refnameShort;
}

function onBranchPickerToggle() {
  branchMenuOpen.value = !branchMenuOpen.value;
  if (!branchMenuOpen.value) return;
  branchSearchQuery.value = '';
  void props.ensureBranchEntriesLoaded?.();
}

function onBranchMenuOpenChange(open: boolean) {
  branchMenuOpen.value = open;
  if (!open) return;
  branchSearchQuery.value = '';
  void props.ensureBranchEntriesLoaded?.();
}

function onBranchSelect(value: unknown) {
  if (typeof value !== 'string') return;
  if (!value.trim()) return;
  void props.runShellCommand?.(value);
}

function onBranchFork(entry: BranchEntry) {
  if (typeof window === 'undefined') return;
  const promptValue = window.prompt(t('treeView.confirm.createBranchFrom', { ref: entry.refnameShort }));
  const nextName = promptValue?.trim() ?? '';
  if (!nextName) return;
  branchMenuOpen.value = false;
  void props.runShellCommand?.(
    `git switch -c ${shellQuote(nextName)} ${shellQuote(entry.refnameShort)}`,
  );
}

function onBranchMerge(entry: BranchEntry) {
  if (!canMergeBranch(entry)) return;
  const target = branchMergeTarget(entry);
  if (typeof window !== 'undefined') {
    const confirmed = window.confirm(t('treeView.confirm.mergeIntoCurrent', { branch: target }));
    if (!confirmed) return;
  }
  branchMenuOpen.value = false;
  void props.runShellCommand?.(`git merge ${shellQuote(target)}`);
}

function onBranchDelete(entry: BranchEntry) {
  if (!canDeleteLocalBranch(entry)) return;
  if (typeof window !== 'undefined') {
    const confirmed = window.confirm(t('treeView.confirm.deleteBranch', { name: entry.displayName }));
    if (!confirmed) return;
  }
  branchMenuOpen.value = false;
  void props.runShellCommand?.(`git branch -d ${shellQuote(entry.displayName)}`);
}

function onRemoteFetch(remote: string) {
  branchMenuOpen.value = false;
  void props.runShellCommand?.(`git fetch ${shellQuote(remote)}`);
}

function onBranchCommandSelect(value: unknown) {
  if (typeof value !== 'string') return;
  if (typeof window !== 'undefined') {
    const confirmed = window.confirm(t('treeView.confirm.runCommand', { command: value }));
    if (!confirmed) return;
  }
  void props.runShellCommand?.(value);
}

function onTreeScrollClick(event: MouseEvent) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.closest('.tree-row')) return;
  emit('select-file', '');
}

function onRowClick(row: VirtualRow, event: MouseEvent) {
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

function onRowDoubleClick(row: VirtualRow) {
  if (row.node.type === 'directory') return;
  if (row.node.synthetic) {
    const status = row.displayStatus;
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

.tree-branch-picker-dropdown {
  flex: 0 1 auto;
  min-width: 0;
}

.tree-branch-picker-trigger {
  border: 0;
  background: transparent;
  color: inherit;
  padding: 0;
  border-radius: 6px;
  cursor: pointer;
}

.tree-branch-picker-trigger:hover {
  color: #cbd5e1;
}

.tree-branch-picker-trigger:focus-visible {
  outline: 1px solid rgba(96, 165, 250, 0.7);
  outline-offset: 1px;
}

.tree-branch-chevron {
  color: #64748b;
  flex-shrink: 0;
}

.tree-branch-menu-content {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
}

.tree-branch-menu-content.is-muted {
  opacity: 0.6;
}

.tree-branch-menu-line1,
.tree-branch-menu-line2 {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.tree-branch-current-icon {
  color: #86efac;
  flex-shrink: 0;
}

.tree-branch-current-spacer {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
}

.tree-branch-menu-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tree-branch-menu-meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #64748b;
  font-size: 10px;
}

.tree-branch-menu-actions {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: 0 0 auto;
  align-self: center;
}

.tree-branch-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border: 1px solid var(--color-slate-700);
  border-radius: 6px;
  padding: 0;
  background: var(--color-slate-950);
  color: var(--color-slate-400);
  cursor: pointer;
}

.tree-branch-action-btn:hover {
  background: var(--color-slate-800);
}

.tree-branch-merge-btn {
  color: var(--color-purple-300);
}

.tree-branch-fork-btn {
  color: var(--color-blue-300);
}

.tree-branch-delete-btn {
  color: var(--color-red-300);
}

.tree-branch-fetch-btn {
  width: 18px;
  height: 18px;
  border: 0;
  background: transparent;
  color: var(--color-slate-500);
}

.tree-branch-fetch-btn:hover {
  color: var(--color-slate-300);
  background: var(--color-slate-800);
}

.tree-branch-action-spacer {
  width: 22px;
  height: 22px;
  flex-shrink: 0;
}

:deep(.tree-branch-cmd-danger .ui-dropdown-item-content) {
  color: var(--color-red-300);
}

:deep(.tree-branch-cmd-merge .ui-dropdown-item-content) {
  color: var(--color-purple-300);
  display: flex;
  align-items: center;
  gap: 6px;
}

:deep(.tree-branch-cmd-rebase .ui-dropdown-item-content) {
  color: var(--color-amber-300);
}

.tree-branch-menu-empty,
.tree-branch-menu-error {
  padding: 8px;
  font-size: 11px;
  color: #94a3b8;
}

.tree-branch-menu-error {
  color: #fca5a5;
}

.tree-branch-command-dropdown {
  flex: 0 0 auto;
  min-width: auto;
}

.tree-branch-command-trigger {
  border: 0;
  background: transparent;
  color: inherit;
  padding: 0;
  border-radius: 999px;
  cursor: pointer;
}

.tree-branch-command-trigger:focus-visible {
  outline: 1px solid rgba(96, 165, 250, 0.7);
  outline-offset: 1px;
}

.tree-branch-command-trigger:hover .tree-branch-ahead {
  background: rgba(74, 222, 128, 0.2);
}

.tree-branch-command-trigger:hover .tree-branch-behind {
  background: rgba(248, 113, 113, 0.2);
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
  position: relative;
}

/* Virtual scroll spacer */
.tree-virtual-spacer {
  position: relative;
}

.tree-row {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 2px 6px 2px calc(4px + var(--indent) * 14px);
  border-radius: 6px;
  color: #dbeafe;
  cursor: pointer;
  position: absolute;
  left: 8px;
  right: 8px;
  box-sizing: border-box;
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

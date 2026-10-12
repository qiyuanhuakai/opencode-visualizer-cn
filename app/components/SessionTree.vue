<template>
  <div v-if="unified" class="session-tree session-tree-unified" data-testid="unified-session-tree">
    <div class="unified-header">
      <div class="unified-toolbar">
        <div class="unified-search">
          <Icon class="unified-search-icon" icon="lucide:search" :width="12" :height="12" />
          <input
            class="unified-search-input"
            data-testid="unified-search-input"
            type="search"
            :value="searchQuery"
            :placeholder="$t('runtime.sessionTree.searchAll', 'Search all sessions')"
            :aria-label="$t('runtime.sessionTree.searchAll', 'Search all sessions')"
            @input="onSearchInput"
            @keydown.enter.prevent="emit('search', searchQuery)"
          />
        </div>
        <Dropdown class="unified-filter" :auto-close="false" :aria-label="$t('runtime.sessionTree.filterSources', 'Filter sources')">
          <template #trigger>
            <button type="button" class="unified-filter-trigger" data-testid="source-filter">
              <Icon icon="lucide:filter" :width="12" :height="12" />
              <span class="unified-filter-label">{{ filterLabel }}</span>
              <Icon icon="lucide:chevron-down" :width="12" :height="12" />
            </button>
          </template>
          <label
            v-for="kind in HARNESS_KINDS"
            :key="kind"
            class="ui-input-candidate-item unified-filter-item"
            :data-value="JSON.stringify([kind])"
            :data-kind="kind"
          >
            <input type="checkbox" :checked="activeKinds.has(kind)" @change="toggleKind(kind)" />
            <Icon v-if="activeKinds.has(kind)" icon="lucide:check" :width="12" :height="12" />
            <span>{{ HARNESS_LABELS[kind] }}</span>
          </label>
        </Dropdown>
      </div>
      <DiscoveryStatus
        :sources="props.sources ?? []"
        :retrying="props.retrying ?? EMPTY_SET"
        :view-error="props.viewError ?? null"
        @retry="(harnessInstanceId) => emit('retry-source', harnessInstanceId)"
      />
      <div class="unified-meta" data-testid="unified-meta">
        <span v-if="props.viewStatus === 'loading'" class="unified-meta-loading">
          <Icon class="unified-spin" icon="lucide:loader-2" :width="12" :height="12" />
          {{ $t('runtime.sessionTree.loading', 'Loading sessions…') }}
        </span>
        <span v-else-if="props.viewStatus === 'error'" class="unified-meta-error">
          {{ $t('runtime.sessionTree.indexError', 'Session index unavailable') }}
        </span>
        <span v-else class="unified-meta-count">
          {{ $t('runtime.sessionTree.rowsLoaded', 'Loaded') }} {{ props.viewLoaded ?? 0 }} · {{ $t('runtime.sessionTree.rowsShown', 'rows') }} {{ (props.treeRows ?? []).length }}
        </span>
        <span
          v-if="searchState && searchState.status === 'complete'"
          class="unified-meta-search"
          data-testid="search-summary"
        >
          {{ searchState.matches.length }} {{ $t('runtime.sessionTree.matches', 'matches') }} · {{ searchState.scanned }} {{ $t('runtime.sessionTree.scanned', 'scanned') }} · {{ searchState.pages }} {{ $t('runtime.sessionTree.pages', 'pages') }}
        </span>
      </div>
      <ul v-if="searchState && searchState.status === 'complete' && searchState.matches.length" class="unified-search-results" data-testid="search-results">
        <li v-for="match in searchState.matches.slice(0, 50)" :key="match.key">
          <button type="button" class="unified-search-result" data-testid="search-result" @click="emit('select-key', match.key)">
            <HarnessBadge class="unified-search-result-badge" :harness="match.harness" compact />
            <span class="unified-search-result-title">{{ match.title }}</span>
          </button>
        </li>
      </ul>
    </div>
    <div
      ref="scrollRef"
      class="unified-scroll"
      data-testid="unified-scroll"
      tabindex="0"
      role="tree"
      :aria-label="$t('runtime.sessionTree.treeLabel', 'Sessions')"
      @scroll.passive="onScroll"
      @keydown="onKeyDown"
    >
      <div class="unified-spacer" :style="{ height: `${totalHeight}px` }">
        <div
          v-for="entry in windowRows"
          :key="entry.row.key"
          class="unified-row"
          data-tree-row
          :data-row-key="entry.row.key"
          :data-row-kind="entry.row.node.kind"
          :data-harness="entry.row.node.kind === 'session' || entry.row.node.kind === 'native' ? entry.row.node.session.harness : undefined"
          :data-depth="entry.row.depth"
          :data-focused="focusIndex === entry.index ? 'true' : undefined"
          :data-selected="selectedKeys.has(selectionKey(entry.row)) ? 'true' : undefined"
          :class="{
            'is-group': entry.row.node.kind === 'repo' || entry.row.node.kind === 'worktree' || entry.row.node.kind === 'section',
            'is-session': entry.row.node.kind === 'session',
            'is-native': entry.row.node.kind === 'native',
          }"
          :style="{ transform: `translateY(${entry.top}px)` }"
          @click="onRowClick(entry.row)"
        >
          <span class="unified-row-indent" :style="{ width: `${4 + entry.row.depth * 12}px` }"></span>
          <span v-if="entry.row.expandable" class="unified-row-toggle" data-testid="row-toggle">
            <Icon :icon="isExpanded(entry.row.key) ? 'lucide:chevron-down' : 'lucide:chevron-right'" width="12" height="12" />
          </span>
          <span v-else class="unified-row-toggle is-leaf"></span>
          <span class="unified-row-icon">
            <Icon :icon="rowIcon(entry.row)" width="13" height="13" />
          </span>
          <span
            v-if="entry.row.node.kind === 'session' || entry.row.node.kind === 'native'"
            class="unified-row-status"
            :class="`is-${entry.row.node.session.status ?? 'unknown'}`"
            :title="entry.row.node.session.status ?? 'unknown'"
          ></span>
          <span class="unified-row-label" :title="rowTitle(entry.row)">{{ rowLabel(entry.row) }}</span>
          <span v-if="entry.row.node.kind === 'session' && childCount(entry.row.key)" class="unified-row-children" data-testid="native-count">
            {{ childCount(entry.row.key) }}
          </span>
          <HarnessBadge
            v-if="entry.row.node.kind === 'session' || entry.row.node.kind === 'native'"
            class="unified-row-badge"
            :harness="entry.row.node.session.harness"
            compact
          />
        </div>
      </div>
    </div>
    <div v-if="(props.treeRows ?? []).length === 0 && props.viewStatus !== 'loading'" class="unified-empty" data-testid="unified-empty">
      {{ props.viewStatus === 'error' ? $t('runtime.sessionTree.indexError', 'Session index unavailable') : $t('sidePanel.session.noPinned') }}
    </div>
    <div class="session-tree-footer">
      <div class="session-tree-footer-left">
        <span class="unified-footer-count" data-testid="unified-footer-count">{{ (props.treeRows ?? []).length }}</span>
      </div>
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
  <div v-else class="session-tree">
    <div v-if="projects.length === 0" class="session-tree-empty">
      {{ $t('sidePanel.session.noPinned') }}
    </div>
    <ul v-else class="session-tree-list">
      <li
        v-for="project in projects"
        :key="projectKey(project)"
        class="session-tree-project"
      >
        <div
          class="session-tree-row"
          :class="{ 'is-pinned': project.isPinned }"
          @click="toggleExpand(`project:${projectKey(project)}`)"
        >
          <span class="session-tree-toggle">
            <Icon
              :icon="isExpanded(`project:${projectKey(project)}`) ? 'lucide:chevron-down' : 'lucide:chevron-right'"
              width="14"
              height="14"
            />
          </span>
          <span class="session-tree-icon">
            <Icon :icon="projectIcon(project)" width="14" height="14" />
          </span>
          <span class="session-tree-label">{{ project.name }}</span>
          <button
            v-if="canPinProject(project)"
            type="button"
            class="session-tree-pin"
            :class="{ 'is-pinned': project.isPinned }"
            :title="project.isPinned ? $t('sidePanel.session.sessionTree.unpinProject') : $t('sidePanel.session.sessionTree.pinProject')"
            :aria-label="`${
              project.isPinned
                ? $t('sidePanel.session.sessionTree.unpinProject')
                : $t('sidePanel.session.sessionTree.pinProject')
            } ${project.name}`"
            @click.stop="project.isPinned ? unpinProject(project) : pinProject(project)"
          >
            <Icon
              :icon="project.isPinned ? 'lucide:pin-off' : 'lucide:pin'"
              width="14"
              height="14"
            />
          </button>
        </div>
        <ul
          v-if="isExpanded(`project:${projectKey(project)}`)"
          class="session-tree-children"
        >
          <li
            v-for="sandbox in project.sandboxes"
            :key="sandboxKey(project, sandbox)"
            class="session-tree-sandbox"
          >
            <div
              class="session-tree-row"
              :class="{ 'is-pinned': sandbox.isPinned || sandbox.isImplicitlyPinned }"
              :style="{ paddingLeft: 'calc(4px + 14px)' }"
              @click="toggleExpand(`sandbox:${sandboxKey(project, sandbox)}`)"
            >
              <span class="session-tree-toggle">
                <Icon
                  :icon="isExpanded(`sandbox:${sandboxKey(project, sandbox)}`) ? 'lucide:chevron-down' : 'lucide:chevron-right'"
                  width="14"
                  height="14"
                />
              </span>
              <span class="session-tree-icon">
                <Icon :icon="sandboxIcon(sandbox)" width="14" height="14" />
              </span>
              <span class="session-tree-label">{{ sandbox.name }}</span>
              <button
                v-if="canPinSandbox(sandbox)"
                type="button"
                class="session-tree-pin"
                :class="{ 'is-pinned': sandbox.isPinned || sandbox.isImplicitlyPinned }"
                :title="sandbox.isPinned || sandbox.isImplicitlyPinned ? $t('sidePanel.session.sessionTree.unpinSandbox') : $t('sidePanel.session.sessionTree.pinSandbox')"
                :aria-label="`${
                  sandbox.isPinned || sandbox.isImplicitlyPinned
                    ? $t('sidePanel.session.sessionTree.unpinSandbox')
                    : $t('sidePanel.session.sessionTree.pinSandbox')
                } ${sandbox.name}`"
                @click.stop="sandbox.isPinned || sandbox.isImplicitlyPinned
                  ? unpinSandbox(sandbox)
                  : pinSandbox(sandbox)"
              >
                <Icon
                  :icon="sandbox.isPinned || sandbox.isImplicitlyPinned ? 'lucide:pin-off' : 'lucide:pin'"
                  width="14"
                  height="14"
                />
              </button>
            </div>
            <ul
              v-if="isExpanded(`sandbox:${sandboxKey(project, sandbox)}`)"
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
                    :aria-label="`${
                      session.isPinned || session.isImplicitlyPinned
                        ? $t('sidePanel.session.sessionTree.unpinSession')
                        : $t('sidePanel.session.sessionTree.pinSession')
                    } ${session.title}`"
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
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ContainerPinPayload } from '../types/pin';
import type { SessionTreeProject, SessionTreeSandbox } from '../types/session-tree';
import {
  HARNESS_KINDS,
  HARNESS_LABELS,
  type SessionHarness,
  type UnifiedFlatRow,
  type UnifiedSearchState,
} from '../composables/useRuntimeSessionTree';
import type { HarnessEntry } from '../composables/useRuntimeSessionTree';
import Dropdown from './Dropdown.vue';
import DiscoveryStatus from './runtime/DiscoveryStatus.vue';
import HarnessBadge from './runtime/HarnessBadge.vue';

const ROW_HEIGHT = 28;
const OVERSCAN = 8;
const EMPTY_SET: ReadonlySet<string> = new Set<string>();

const props = withDefaults(
  defineProps<{
    projects: SessionTreeProject[];
    expandedPaths: string[];
    selectedSessionId: string;
    selectedKey?: string;
    treeRows?: readonly UnifiedFlatRow[];
    sources?: readonly HarnessEntry[];
    retrying?: ReadonlySet<string>;
    childScans?: ReadonlySet<string>;
    viewStatus?: 'loading' | 'partial' | 'complete' | 'error';
    viewLoaded?: number;
    viewError?: string | null;
    filterKinds?: ReadonlySet<SessionHarness>;
    searchState?: UnifiedSearchState | null;
  }>(),
  {
    treeRows: undefined,
    selectedKey: '',
    sources: () => [],
    retrying: () => new Set<string>(),
    childScans: () => new Set<string>(),
    viewStatus: 'loading',
    viewLoaded: 0,
    viewError: null,
    filterKinds: () => new Set<SessionHarness>([...HARNESS_KINDS, 'unknown']),
    searchState: null,
  },
);

const emit = defineEmits<{
  (event: 'toggle-expand', path: string): void;
  (event: 'select-session', payload: { projectId: string; sessionId: string }): void;
  (event: 'pin-project', projectId: string): void;
  (event: 'unpin-project', projectId: string): void;
  (event: 'pin-sandbox', payload: ContainerPinPayload): void;
  (event: 'unpin-sandbox', payload: ContainerPinPayload): void;
  (event: 'pin-session', payload: { projectId: string; sessionId: string }): void;
  (event: 'unpin-session', payload: { projectId: string; sessionId: string }): void;
  (event: 'reload'): void;
  (event: 'toggle-key', key: string): void;
  (event: 'select-key', key: string): void;
  (event: 'retry-source', harnessInstanceId: string): void;
  (event: 'filter-change', kinds: SessionHarness[]): void;
  (event: 'search', query: string): void;
  (event: 'load-more-children', key: string): void;
}>();

const unified = computed(() => props.treeRows !== undefined);
const searchQuery = ref('');
const scrollRef = ref<HTMLElement | null>(null);
const scrollTop = ref(0);
const viewportHeight = ref(640);
const focusIndex = ref(0);
const activeKinds = computed(() => props.filterKinds);
const selectedKeys = computed(() => (props.selectedKey ? new Set<string>([props.selectedKey]) : new Set<string>()));

const filterLabel = computed(() => {
  const active = HARNESS_KINDS.filter((kind) => activeKinds.value.has(kind)).length;
  if (active === HARNESS_KINDS.length) return 'All sources';
  return `${active}/${HARNESS_KINDS.length} sources`;
});

const startIndex = computed(() => Math.max(0, Math.floor(scrollTop.value / ROW_HEIGHT) - OVERSCAN));
const visibleCount = computed(() => Math.ceil(viewportHeight.value / ROW_HEIGHT) + OVERSCAN * 2);
const windowRows = computed(() => {
  const rows = props.treeRows ?? [];
  const start = Math.min(startIndex.value, Math.max(0, rows.length - 1));
  return rows.slice(start, start + visibleCount.value).map((row, offset) => ({ row, index: start + offset, top: (start + offset) * ROW_HEIGHT }));
});
const totalHeight = computed(() => (props.treeRows ?? []).length * ROW_HEIGHT);

function onScroll(): void {
  scrollTop.value = scrollRef.value?.scrollTop ?? 0;
}
function onSearchInput(event: Event): void {
  searchQuery.value = (event.target as HTMLInputElement).value;
}
function toggleKind(kind: SessionHarness): void {
  const next = new Set(activeKinds.value);
  if (next.has(kind)) next.delete(kind);
  else next.add(kind);
  emit('filter-change', [...next]);
}
function isExpanded(key: string): boolean {
  return props.expandedPaths.includes(key);
}
function selectionKey(row: UnifiedFlatRow): string {
  return row.node.kind === 'session' || row.node.kind === 'native' ? row.node.session.key : row.key;
}
function onRowClick(row: UnifiedFlatRow): void {
  if (row.node.kind === 'session' || row.node.kind === 'native') {
    emit('select-key', row.node.session.key);
    return;
  }
  emit('toggle-key', row.key);
}
const childCounts = computed(() => {
  const counts = new Map<string, number>();
  for (const row of props.treeRows ?? []) {
    if (row.node.kind === 'session' || row.node.kind === 'native') counts.set(row.key, row.node.children.length);
  }
  return counts;
});
function childCount(key: string): number {
  return childCounts.value.get(key) ?? 0;
}
function rowIcon(row: UnifiedFlatRow): string {
  if (row.node.kind === 'repo') return 'lucide:package';
  if (row.node.kind === 'worktree') return 'lucide:git-branch';
  if (row.node.kind === 'section') {
    if (row.node.section === 'archived') return 'lucide:archive';
    if (row.node.section === 'orphan') return 'lucide:unplug';
    if (row.node.section === 'global') return 'lucide:globe';
    return 'lucide:git-fork';
  }
  if (row.node.kind === 'native') return 'lucide:corner-down-right';
  return row.node.session.status === 'busy' ? 'lucide:message-square-dot' : 'lucide:message-square';
}
function rowTitle(row: UnifiedFlatRow): string {
  if (row.node.kind === 'session' || row.node.kind === 'native') {
    const session = row.node.session;
    return `${session.title} — ${HARNESS_LABELS[session.harness]}${session.directory ? ` — ${session.directory}` : ''}`;
  }
  return rowLabel(row);
}
function rowLabel(row: UnifiedFlatRow): string {
  if (row.node.kind === 'repo') return row.node.name;
  if (row.node.kind === 'worktree') return row.node.name;
  if (row.node.kind === 'section') {
    if (row.node.section === 'archived') return 'Archived';
    if (row.node.section === 'orphan') return 'Orphan workspaces';
    if (row.node.section === 'global') return 'Global';
    return 'Native (host not loaded)';
  }
  if (row.node.kind === 'native') return row.node.session.title;
  return row.node.session.title;
}
function onKeyDown(event: KeyboardEvent): void {
  const rows = props.treeRows ?? [];
  if (!rows.length) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    const next = event.key === 'ArrowDown' ? Math.min(rows.length - 1, focusIndex.value + 1) : Math.max(0, focusIndex.value - 1);
    focusIndex.value = next;
    const top = next * ROW_HEIGHT;
    const element = scrollRef.value;
    if (element) {
      if (top < element.scrollTop) element.scrollTop = top;
      else if (top + ROW_HEIGHT > element.scrollTop + element.clientHeight) element.scrollTop = top + ROW_HEIGHT - element.clientHeight;
    }
    return;
  }
  const row = rows[Math.min(focusIndex.value, rows.length - 1)];
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    onRowClick(row);
    return;
  }
  if (event.key === 'ArrowRight' && row.expandable && !isExpanded(row.key)) {
    event.preventDefault();
    emit('toggle-key', row.key);
    if (row.node.kind === 'session' && !props.childScans.has(row.key)) emit('load-more-children', row.key);
    return;
  }
  if (event.key === 'ArrowLeft') {
    event.preventDefault();
    if (row.expandable && isExpanded(row.key)) emit('toggle-key', row.key);
    return;
  }
}
watch(
  () => (props.treeRows ?? []).length,
  () => { focusIndex.value = Math.min(focusIndex.value, Math.max(0, (props.treeRows ?? []).length - 1)); },
);
let observer: ResizeObserver | null = null;
onMounted(() => {
  const element = scrollRef.value;
  if (element) {
    viewportHeight.value = element.clientHeight || 640;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver(() => { viewportHeight.value = element.clientHeight || 640; });
      observer.observe(element);
    }
  }
  nextTick(() => { scrollTop.value = scrollRef.value?.scrollTop ?? 0; });
});
onBeforeUnmount(() => { observer?.disconnect(); observer = null; });

function projectKey(project: SessionTreeProject): string {
  return project.key || project.projectId;
}

function sandboxKey(project: SessionTreeProject, sandbox: SessionTreeSandbox): string {
  return sandbox.key || `${projectKey(project)}:${sandbox.directory}`;
}

function projectIcon(project: SessionTreeProject): string {
  if (project.kind === 'global') return 'lucide:globe';
  return 'lucide:package';
}

function sandboxIcon(sandbox: SessionTreeSandbox): string {
  if (sandbox.kind === 'folder') return 'lucide:folder';
  if (sandbox.kind === 'global') return 'lucide:globe';
  if (sandbox.kind === 'branch') return 'lucide:git-branch';
  return 'lucide:git-branch';
}

function canPinProject(project: SessionTreeProject): boolean {
  return project.kind !== 'global';
}

function canPinSandbox(sandbox: SessionTreeSandbox): boolean {
  return sandbox.kind !== 'global' && sandbox.kind !== 'folder';
}

function pinProject(project: SessionTreeProject): void {
  if (project.pinScope) {
    emit('pin-sandbox', { projectId: project.projectId, scope: project.pinScope });
    return;
  }
  emit('pin-project', project.projectId);
}

function unpinProject(project: SessionTreeProject): void {
  if (project.pinScope) {
    emit('unpin-sandbox', { projectId: project.projectId, scope: project.pinScope });
    return;
  }
  emit('unpin-project', project.projectId);
}

function pinSandbox(sandbox: SessionTreeSandbox): void {
  emit('pin-sandbox', {
    projectId: sandbox.projectId,
    scope: sandbox.pinScope ?? { level: 'branch', directory: sandbox.directory },
  });
}

function unpinSandbox(sandbox: SessionTreeSandbox): void {
  emit('unpin-sandbox', {
    projectId: sandbox.projectId,
    scope: sandbox.pinScope ?? { level: 'branch', directory: sandbox.directory },
  });
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
  box-shadow: inset 2px 0 var(--theme-side-accent, rgba(96, 165, 250, 0.8));
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
  font-size: var(--sidebar-font-size, 12px);
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

.session-tree-unified {
  overflow: hidden;
}

.unified-header {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--theme-side-border, var(--theme-border-muted, rgba(100, 116, 139, 0.28)));
}

.unified-toolbar {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
}

.unified-search {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 0 6px;
  height: 24px;
  border-radius: 6px;
  border: 1px solid var(--theme-side-border, var(--theme-border-muted, rgba(100, 116, 139, 0.28)));
  background: var(--theme-side-control-bg, rgba(30, 41, 59, 0.5));
}

.unified-search-icon {
  flex-shrink: 0;
  color: var(--theme-side-text-muted, #94a3b8);
}

.unified-search-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: var(--theme-side-text, #e2e8f0);
  font-size: var(--sidebar-font-size, 12px);
}

.unified-filter {
  flex: 0 0 auto;
}

.unified-filter-trigger {
  display: flex;
  align-items: center;
  gap: 4px;
  height: 24px;
  padding: 0 6px;
  border-radius: 6px;
  border: 1px solid var(--theme-side-border, var(--theme-border-muted, rgba(100, 116, 139, 0.28)));
  background: var(--theme-side-control-bg, rgba(30, 41, 59, 0.5));
  color: var(--theme-side-text, #e2e8f0);
  cursor: pointer;
  font-size: var(--sidebar-font-size, 12px);
  white-space: nowrap;
}

.unified-filter-trigger:hover {
  background: var(--theme-side-active-bg, rgba(51, 65, 85, 0.6));
}

.unified-filter-item {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px;
  border-radius: 6px;
  cursor: pointer;
  color: var(--theme-dropdown-text, var(--theme-text-primary, #e2e8f0));
  font-size: var(--ui-font-size, 12px);
}

.unified-filter-item:hover {
  background: var(--theme-dropdown-hover-bg, var(--theme-side-active-bg, rgba(51, 65, 85, 0.6)));
}

.unified-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 8px 4px;
  font-size: calc(var(--sidebar-font-size, 12px) - 1px);
  color: var(--theme-side-text-muted, #94a3b8);
}

.unified-meta-loading,
.unified-meta-error {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.unified-meta-error {
  color: var(--theme-status-danger, #f87171);
}

.unified-meta-count,
.unified-meta-search {
  font-variant-numeric: tabular-nums;
}

.unified-spin {
  animation: unified-spin 0.9s linear infinite;
}

@keyframes unified-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .unified-spin { animation: none; }
}

.unified-search-results {
  list-style: none;
  margin: 0;
  padding: 0 6px 4px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 132px;
  overflow: auto;
}

.unified-search-result {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 4px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--theme-side-text, #e2e8f0);
  cursor: pointer;
  text-align: left;
  font-size: calc(var(--sidebar-font-size, 12px) - 1px);
}

.unified-search-result:hover {
  background: var(--theme-side-active-bg, rgba(51, 65, 85, 0.6));
}

.unified-search-result-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.unified-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  position: relative;
  outline: none;
  contain: strict;
}

.unified-scroll:focus-visible {
  box-shadow: inset 0 0 0 2px var(--theme-side-accent, rgba(96, 165, 250, 0.8));
}

.unified-spacer {
  position: relative;
  width: 100%;
}

.unified-row {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: 4px;
  height: 28px;
  padding-right: 6px;
  border-radius: 6px;
  cursor: pointer;
  will-change: transform;
  user-select: none;
  -webkit-user-select: none;
}

.unified-row:hover {
  background: var(--theme-side-control-bg, rgba(30, 41, 59, 0.5));
}

.unified-row.is-group {
  font-weight: 600;
}

.unified-row.is-native .unified-row-label {
  color: var(--theme-side-text-muted, #94a3b8);
}

.unified-row[data-selected='true'] {
  background: var(--theme-side-active-bg, rgba(30, 64, 175, 0.25));
}

.unified-row[data-focused='true'] {
  box-shadow: inset 0 0 0 1px var(--theme-side-accent, rgba(96, 165, 250, 0.8));
}

.unified-row-indent {
  flex-shrink: 0;
}

.unified-row-toggle {
  width: 16px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--theme-side-text-muted, #94a3b8);
}

.unified-row-toggle.is-leaf {
  cursor: default;
}

.unified-row-icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--theme-side-text-muted, #94a3b8);
}

.unified-row-label {
  flex: 1;
  min-width: 0;
  font-size: var(--sidebar-font-size, 12px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--theme-side-text, #e2e8f0);
}

.unified-row-children {
  flex-shrink: 0;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--theme-chip-bg-neutral, var(--theme-side-control-bg, rgba(30, 41, 59, 0.5)));
  color: var(--theme-chip-fg-neutral, var(--theme-side-text-muted, #94a3b8));
  font-size: calc(var(--sidebar-font-size, 12px) - 2px);
  font-variant-numeric: tabular-nums;
}

.unified-row-badge {
  flex-shrink: 0;
}

.unified-row-status {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--theme-status-neutral, #94a3b8);
}

.unified-row-status.is-busy {
  background: var(--theme-status-warning, #fbbf24);
}

.unified-row-status.is-idle {
  background: var(--theme-status-success, #4ade80);
}

.unified-row-status.is-retry {
  background: var(--theme-status-danger, #f87171);
}

.unified-empty {
  padding: 16px 12px;
  text-align: center;
  color: var(--theme-side-text-muted, #94a3b8);
  font-size: var(--ui-font-size, 12px);
}

.unified-footer-count {
  padding: 0 6px;
  font-size: calc(var(--sidebar-font-size, 12px) - 1px);
  color: var(--theme-side-text-muted, #94a3b8);
  font-variant-numeric: tabular-nums;
}
</style>

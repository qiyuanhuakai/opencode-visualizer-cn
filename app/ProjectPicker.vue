<template>
  <div v-if="open" class="modal-backdrop" @keydown.esc="$emit('close')">
    <div class="modal" role="dialog" aria-modal="true" tabindex="0" @keydown="handleKeydown">
      <header class="modal-header">
        <div class="modal-title">Select folder</div>
        <button type="button" class="control-button" @click="$emit('close')">Close</button>
      </header>
      <div class="modal-body">
        <div class="field-row">
          <input
            v-model="searchQuery"
            ref="searchInputRef"
            class="control-input"
            type="text"
            placeholder="Search directories"
            @keydown="handleKeydown"
          />
        </div>
        <div v-if="error" class="error-text">{{ error }}</div>
        <div class="list-block">
          <div class="list-title">Results</div>
          <div class="list" :class="{ loading: searching }">
            <button
              v-for="(result, index) in searchResults"
              :key="result.path"
              type="button"
              class="list-item"
              :class="{ 'is-active': index === activeSearchIndex }"
              @click="activateSearchResult(index)"
            >
              {{ result.label }}
            </button>
            <div v-if="!searching && searchResults.length === 0" class="empty-text">
              No results.
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, customRef, nextTick, ref, watch } from 'vue';

type BasePath = { id: string; label: string; path: string };
type FileNode = {
  name: string;
  path: string;
  absolute: string;
  type: 'file' | 'directory';
  ignored: boolean;
};

const props = defineProps<{
  open: boolean;
  baseUrl: string;
  initialDirectory?: string;
}>();

const emit = defineEmits<{
  (event: 'select', directory: string): void;
  (event: 'close'): void;
}>();

const basePaths = ref<BasePath[]>([]);
const baseId = ref('');
const searching = ref(false);
const error = ref('');
const searchInputRef = ref<HTMLInputElement | null>(null);
const activeSearchIndex = ref(-1);
let searchTimeout: ReturnType<typeof setTimeout> | null = null;
let searchRequestId = 0;
let searchController: AbortController | null = null;
const searchQuery = customRef<string>((track, trigger) => {
  let value = '';
  return {
    get() {
      track();
      return value;
    },
    set(nextValue) {
      if (nextValue === value) return;
      value = nextValue;
      trigger();
      queueSearch(nextValue);
    },
  };
});
const searchResults = ref<Array<{ path: string; label: string }>>([]);

const activeBasePath = computed(() => basePaths.value.find((base) => base.id === baseId.value));

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    void initPicker();
  },
);

watch(baseId, () => {
  if (!props.open) return;
  searchQuery.value = '';
  searchResults.value = [];
  activeSearchIndex.value = -1;
  void loadDefaultResults();
});

async function initPicker() {
  error.value = '';
  searchResults.value = [];
  searchQuery.value = '';
  await loadBasePaths();
  if (!baseId.value && props.initialDirectory) applyInitialDirectory(props.initialDirectory);
  await nextTick();
  searchInputRef.value?.focus();
  void loadDefaultResults();
}

async function loadBasePaths() {
  try {
    const response = await fetch(`${props.baseUrl}/path`);
    if (!response.ok) throw new Error(`Path request failed (${response.status})`);
    const data = (await response.json()) as Record<string, string>;
    const candidates: BasePath[] = [];
    const order: Array<[string, string]> = [
      ['worktree', 'worktree'],
      ['directory', 'directory'],
      ['home', 'home'],
      ['config', 'config'],
      ['state', 'state'],
    ];
    order.forEach(([key, label]) => {
      const value = data?.[key];
      if (typeof value === 'string' && value.length > 0) {
        candidates.push({ id: key, label, path: value });
      }
    });
    basePaths.value = candidates;
    if (!baseId.value && candidates.length > 0) {
      const home = candidates.find((base) => base.id === 'home');
      baseId.value = home?.id ?? candidates[0]!.id;
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  }
}

function applyInitialDirectory(initialDirectory: string) {
  if (!initialDirectory) return;
  const match = basePaths.value.find(
    (base) => initialDirectory === base.path || initialDirectory.startsWith(`${base.path}/`),
  );
  if (match) {
    baseId.value = match.id;
  } else if (basePaths.value.length === 0) {
    basePaths.value = [{ id: 'current', label: 'current', path: initialDirectory }];
    baseId.value = 'current';
  }
}

async function loadDefaultResults() {
  const base = activeBasePath.value?.path;
  if (!base) {
    searchResults.value = [];
    activeSearchIndex.value = -1;
    return;
  }
  if (searchTimeout) clearTimeout(searchTimeout);
  if (searchController) {
    searchController.abort();
    searchController = null;
  }
  const requestId = ++searchRequestId;
  searching.value = true;
  error.value = '';
  try {
    const params = new URLSearchParams();
    params.set('directory', base);
    const response = await fetch(`${props.baseUrl}/file?${params.toString()}`);
    if (!response.ok) throw new Error(`File request failed (${response.status})`);
    const data = (await response.json()) as FileNode[];
    const list = Array.isArray(data) ? data : [];
    if (requestId !== searchRequestId) return;
    const results = list
      .filter((node) => node.type === 'directory' && !node.ignored)
      .map((node) => {
        const absolute = node.absolute || node.path || `${base.replace(/\/+$/, '')}/${node.name}`;
        return { path: absolute, label: node.name };
      });
    searchResults.value = sortResults(results);
    activeSearchIndex.value = searchResults.value.length > 0 ? 0 : -1;
  } catch (err) {
    if (requestId !== searchRequestId) return;
    error.value = err instanceof Error ? err.message : String(err);
    searchResults.value = [];
    activeSearchIndex.value = -1;
  } finally {
    if (requestId === searchRequestId) searching.value = false;
  }
}

async function runSearch(query: string) {
  const base = activeBasePath.value?.path;
  const trimmed = query.trim();
  if (!trimmed) {
    searchResults.value = [];
    activeSearchIndex.value = -1;
    return;
  }
  const requestId = ++searchRequestId;
  const controller = new AbortController();
  searchController = controller;
  searching.value = true;
  error.value = '';
  let usedBase = false;
  try {
    const params = new URLSearchParams({
      query: trimmed,
      type: 'directory',
      limit: '50',
    });
    let response = await fetch(`${props.baseUrl}/find/file?${params.toString()}`, {
      signal: controller.signal,
    });
    if (!response.ok && base) {
      params.set('directory', base);
      usedBase = true;
      response = await fetch(`${props.baseUrl}/find/file?${params.toString()}`, {
        signal: controller.signal,
      });
    }
    if (!response.ok) throw new Error(`Search request failed (${response.status})`);
    const data = (await response.json()) as string[];
    const results = Array.isArray(data) ? data : [];
    if (requestId !== searchRequestId) return;
    searchResults.value = sortResults(
      results.map((item) => {
        const label = usedBase && base ? toRelativeFromBase(item, base) || item : item;
        return { path: item, label };
      }),
    );
    activeSearchIndex.value = searchResults.value.length > 0 ? 0 : -1;
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    if (requestId !== searchRequestId) return;
    error.value = err instanceof Error ? err.message : String(err);
    searchResults.value = [];
    activeSearchIndex.value = -1;
  } finally {
    if (requestId === searchRequestId) searching.value = false;
  }
}

function queueSearch(nextValue: string) {
  if (searchTimeout) clearTimeout(searchTimeout);
  if (searchController) {
    searchController.abort();
    searchController = null;
  }
  const trimmed = nextValue.trim();
  if (!trimmed) {
    void loadDefaultResults();
    return;
  }
  searchTimeout = setTimeout(() => {
    runSearch(nextValue);
  }, 250);
}

function selectSearchResult(resultPath: string) {
  if (!resultPath) return;
  emit('select', resultPath);
  emit('close');
}

function activateSearchResult(index: number) {
  if (index < 0 || index >= searchResults.value.length) return;
  activeSearchIndex.value = index;
  selectSearchResult(searchResults.value[index]!.path);
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return;
  const items = searchResults.value;
  if (items.length === 0) return;
  event.preventDefault();
  if (event.key === 'ArrowDown') {
    if (activeSearchIndex.value < 0) activeSearchIndex.value = 0;
    else activeSearchIndex.value = (activeSearchIndex.value + 1) % items.length;
    return;
  }
  if (event.key === 'ArrowUp') {
    if (activeSearchIndex.value < 0) activeSearchIndex.value = items.length - 1;
    else activeSearchIndex.value = (activeSearchIndex.value - 1 + items.length) % items.length;
    return;
  }
  const selectedIndex = activeSearchIndex.value < 0 ? 0 : activeSearchIndex.value;
  activateSearchResult(selectedIndex);
}

function toRelativeFromBase(resultPath: string, base: string) {
  if (resultPath.startsWith(base)) {
    return resultPath.slice(base.length).replace(/^\/+/, '').replace(/\/+$/, '');
  }
  if (resultPath.startsWith('/')) return resultPath.replace(/^\/+/, '').replace(/\/+$/, '');
  return resultPath.replace(/^\/+/, '').replace(/\/+$/, '');
}

function sortResults(items: Array<{ path: string; label: string }>) {
  return [...items].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }),
  );
}
</script>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(2, 6, 23, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}

.modal {
  width: min(960px, 95vw);
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px;
  background: rgba(15, 23, 42, 0.98);
  border: 1px solid #334155;
  border-radius: 12px;
  box-shadow: 0 12px 32px rgba(2, 6, 23, 0.45);
  color: #e2e8f0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.modal-title {
  font-size: 14px;
  font-weight: 600;
}

.modal-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
}

.field-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.list-block {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 0;
}

.list-title {
  font-size: 12px;
  color: #94a3b8;
}

.list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 6px;
  border: 1px solid #1e293b;
  border-radius: 10px;
  min-height: 160px;
  max-height: 40vh;
  overflow: auto;
  background: rgba(2, 6, 23, 0.45);
}

.list.loading {
  opacity: 0.6;
}

.list-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 8px;
  border: 1px solid #1e293b;
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.75);
  color: inherit;
  cursor: pointer;
  text-align: left;
}

.list-item:hover {
  border-color: #334155;
}

.list-item.is-active {
  border-color: #60a5fa;
  background: rgba(37, 99, 235, 0.2);
}

.empty-text {
  font-size: 12px;
  color: #94a3b8;
}

.error-text {
  font-size: 12px;
  color: #fecaca;
}

.control-input {
  width: 100%;
  background: #0b1320;
  color: #e2e8f0;
  border: 1px solid #334155;
  border-radius: 8px;
  padding: 6px 8px;
  font-size: 12px;
  font-family: inherit;
  outline: none;
  box-sizing: border-box;
}

.control-button {
  background: #1e293b;
  color: #e2e8f0;
  border: 1px solid #334155;
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
}
</style>

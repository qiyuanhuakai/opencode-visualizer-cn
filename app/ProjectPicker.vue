<template>
  <div v-if="open" class="modal-backdrop" @keydown.esc="$emit('close')">
    <div class="modal" role="dialog" aria-modal="true">
      <header class="modal-header">
        <div class="modal-title">Select Project Folder</div>
        <button type="button" class="control-button" @click="$emit('close')">Close</button>
      </header>
      <div class="modal-body">
        <div class="field-row">
          <label class="field-label" for="base-select">Base</label>
          <select id="base-select" v-model="baseId" class="control-input" :disabled="loading">
            <option v-for="base in basePaths" :key="base.id" :value="base.id">
              {{ base.label }}
            </option>
          </select>
        </div>
        <div class="field-row">
          <input
            v-model="searchQuery"
            class="control-input"
            type="text"
            placeholder="Search directories"
            @keydown.enter.prevent="runSearch"
          />
          <button type="button" class="control-button" @click="runSearch">Search</button>
        </div>
        <div class="path-row">
          <span class="path-label">Current</span>
          <span class="path-value">{{ currentDirectory || '—' }}</span>
          <button
            v-if="canGoUp"
            type="button"
            class="control-button subtle"
            @click="goUp"
          >
            Up
          </button>
        </div>
        <div v-if="error" class="error-text">{{ error }}</div>
        <div class="lists">
          <div class="list-block">
            <div class="list-title">Folders</div>
            <div class="list" :class="{ loading: loading }">
              <button
                v-for="dir in directories"
                :key="dir.absolute"
                type="button"
                class="list-item"
                @click="enterDirectory(dir.name)"
              >
                {{ dir.name }}
              </button>
              <div v-if="!loading && directories.length === 0" class="empty-text">
                No folders found.
              </div>
            </div>
          </div>
          <div class="list-block">
            <div class="list-title">Search Results</div>
            <div class="list" :class="{ loading: searching }">
              <button
                v-for="result in searchResults"
                :key="result.path"
                type="button"
                class="list-item"
                @click="selectSearchResult(result.path)"
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
      <footer class="modal-footer">
        <button
          type="button"
          class="control-button primary"
          :disabled="!currentDirectory"
          @click="selectCurrent"
        >
          Select folder
        </button>
        <button type="button" class="control-button" @click="$emit('close')">Cancel</button>
      </footer>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';

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
const relativePath = ref('');
const directories = ref<FileNode[]>([]);
const loading = ref(false);
const searching = ref(false);
const error = ref('');
const searchQuery = ref('');
const searchResults = ref<Array<{ path: string; label: string }>>([]);

const activeBasePath = computed(() => basePaths.value.find((base) => base.id === baseId.value));
const currentDirectory = computed(() => {
  const base = activeBasePath.value?.path ?? '';
  if (!base) return '';
  if (!relativePath.value) return base;
  return `${base.replace(/\/+$/, '')}/${relativePath.value}`;
});
const canGoUp = computed(() => relativePath.value.length > 0);

watch(
  () => props.open,
  (open) => {
    if (!open) return;
    void initPicker();
  },
);

watch(baseId, () => {
  if (!props.open) return;
  relativePath.value = '';
  searchQuery.value = '';
  searchResults.value = [];
  void loadDirectories();
});

async function initPicker() {
  error.value = '';
  searchResults.value = [];
  searchQuery.value = '';
  await loadBasePaths();
  if (props.initialDirectory) applyInitialDirectory(props.initialDirectory);
  if (!baseId.value && basePaths.value.length > 0) baseId.value = basePaths.value[0].id;
  await loadDirectories();
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
    if (!baseId.value && candidates.length > 0) baseId.value = candidates[0].id;
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
    relativePath.value = initialDirectory
      .slice(match.path.length)
      .replace(/^\/+/, '')
      .replace(/\/+$/, '');
  } else if (basePaths.value.length === 0) {
    basePaths.value = [{ id: 'current', label: 'current', path: initialDirectory }];
    baseId.value = 'current';
    relativePath.value = '';
  }
}

async function loadDirectories() {
  const base = activeBasePath.value?.path;
  if (!base) return;
  loading.value = true;
  error.value = '';
  try {
    const params = new URLSearchParams();
    params.set('directory', base);
    if (relativePath.value) params.set('path', relativePath.value);
    const response = await fetch(`${props.baseUrl}/file?${params.toString()}`);
    if (!response.ok) throw new Error(`File request failed (${response.status})`);
    const data = (await response.json()) as FileNode[];
    const list = Array.isArray(data) ? data : [];
    directories.value = list
      .filter((node) => node.type === 'directory' && !node.ignored)
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    directories.value = [];
  } finally {
    loading.value = false;
  }
}

function enterDirectory(name: string) {
  const next = relativePath.value ? `${relativePath.value}/${name}` : name;
  relativePath.value = next.replace(/^\/+/, '').replace(/\/+$/, '');
  void loadDirectories();
}

function goUp() {
  if (!relativePath.value) return;
  const parts = relativePath.value.split('/').filter((part) => part.length > 0);
  parts.pop();
  relativePath.value = parts.join('/');
  void loadDirectories();
}

async function runSearch() {
  const base = activeBasePath.value?.path;
  const query = searchQuery.value.trim();
  if (!base || !query) {
    searchResults.value = [];
    return;
  }
  searching.value = true;
  error.value = '';
  try {
    const params = new URLSearchParams({
      directory: base,
      query,
      type: 'directory',
      limit: '50',
    });
    const response = await fetch(`${props.baseUrl}/find/file?${params.toString()}`);
    if (!response.ok) throw new Error(`Search request failed (${response.status})`);
    const data = (await response.json()) as string[];
    const results = Array.isArray(data) ? data : [];
    searchResults.value = results.map((item) => {
      const label = toRelativeFromBase(item, base) || item;
      return { path: item, label };
    });
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
    searchResults.value = [];
  } finally {
    searching.value = false;
  }
}

function selectSearchResult(resultPath: string) {
  const base = activeBasePath.value?.path;
  if (!base) return;
  const relative = toRelativeFromBase(resultPath, base);
  if (relative) {
    relativePath.value = relative;
    void loadDirectories();
  }
}

function selectCurrent() {
  const directory = currentDirectory.value;
  if (!directory) return;
  emit('select', directory);
}

function toRelativeFromBase(resultPath: string, base: string) {
  if (resultPath.startsWith(base)) {
    return resultPath.slice(base.length).replace(/^\/+/, '').replace(/\/+$/, '');
  }
  if (resultPath.startsWith('/')) return resultPath.replace(/^\/+/, '').replace(/\/+$/, '');
  return resultPath.replace(/^\/+/, '').replace(/\/+$/, '');
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

.field-label {
  font-size: 12px;
  color: #94a3b8;
}

.path-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.path-label {
  color: #94a3b8;
}

.path-value {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lists {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
  min-height: 0;
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

.empty-text {
  font-size: 12px;
  color: #94a3b8;
}

.error-text {
  font-size: 12px;
  color: #fecaca;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
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

.control-button.primary {
  background: #2563eb;
  border-color: #1d4ed8;
}

.control-button.subtle {
  background: rgba(15, 23, 42, 0.6);
}

@media (max-width: 720px) {
  .lists {
    grid-template-columns: 1fr;
  }
}
</style>

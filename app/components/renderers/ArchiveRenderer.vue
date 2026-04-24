<template>
  <div class="archive-renderer">
    <div v-if="loading" class="archive-loading">{{ t('common.loading') }}</div>
    <div v-else-if="result.error" class="archive-error">{{ result.error }}</div>
    <div v-else-if="result.unsupported" class="archive-unsupported">
      {{ t('viewers.archive.unsupported') }}
    </div>
    <div v-else-if="result.entries.length === 0" class="archive-empty">
      {{ t('viewers.archive.empty') }}
    </div>
    <div v-else class="archive-content">
      <div v-if="result.format" class="archive-format">{{ result.format }}</div>
      <table class="archive-table">
        <thead>
          <tr>
            <th>{{ t('viewers.archive.name') }}</th>
            <th>{{ t('viewers.archive.size') }}</th>
            <th>{{ t('viewers.archive.date') }}</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="entry in result.entries"
            :key="entry.name"
            :class="{ 'is-dir': entry.isDirectory }"
          >
            <td class="entry-name">{{ entry.name }}</td>
            <td class="entry-size">{{ formatSize(entry.size) }}</td>
            <td class="entry-date">{{ formatDate(entry.date) }}</td>
          </tr>
        </tbody>
      </table>
      <div class="archive-summary">
        {{ t('viewers.archive.fileCount', { count: result.entries.length }) }}
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { parseArchive, type ArchiveParseResult } from '../../utils/archiveParser';

const { t } = useI18n();

const props = defineProps<{
  bytes: Uint8Array;
  extension: string;
}>();

const loading = ref(true);
const result = ref<ArchiveParseResult>({ entries: [] });

async function loadArchive() {
  loading.value = true;
  result.value = await parseArchive(props.bytes, props.extension);
  loading.value = false;
}

watch(
  () => [props.bytes, props.extension],
  () => {
    loadArchive();
  },
  { immediate: true },
);

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function formatDate(date?: Date): string {
  if (!date) return '-';
  return date.toLocaleString();
}
</script>

<style scoped>
.archive-renderer {
  height: 100%;
  overflow: auto;
  padding: 12px 16px;
  font-family: var(--term-font-family, 'JetBrains Mono', 'Fira Code', monospace);
  font-size: 13px;
  line-height: 1.5;
  color: var(--floating-text, #e2e8f0);
  background: var(--floating-surface, #1a1d24);
}

.archive-loading,
.archive-error,
.archive-unsupported,
.archive-empty {
  padding: 24px;
  text-align: center;
  color: var(--floating-text-soft, #8a8f9a);
}

.archive-error {
  color: var(--theme-status-danger, #f87171);
}

.archive-table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 12px;
}

.archive-table th {
  text-align: left;
  padding: 8px 12px;
  font-weight: 600;
  color: var(--floating-text-secondary, #cbd5e1);
  border-bottom: 1px solid var(--floating-border-muted, rgba(90, 100, 120, 0.35));
  white-space: nowrap;
}

.archive-table td {
  padding: 6px 12px;
  border-bottom: 1px solid var(--floating-border-subtle, rgba(90, 100, 120, 0.15));
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 400px;
}

.archive-table tr:hover td {
  background: var(--floating-surface-muted, rgba(26, 29, 36, 0.95));
}

.archive-table tr.is-dir .entry-name {
  color: var(--theme-status-info, #60a5fa);
  font-weight: 500;
}

.entry-name {
  color: var(--floating-text, #e2e8f0);
}

.entry-size {
  color: var(--floating-text-secondary, #cbd5e1);
  text-align: right;
  width: 100px;
}

.entry-date {
  color: var(--floating-text-soft, #8a8f9a);
  width: 160px;
}

.archive-format {
  padding: 4px 12px;
  margin-bottom: 8px;
  color: var(--theme-status-info, #60a5fa);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.archive-summary {
  padding: 8px 12px;
  color: var(--floating-text-soft, #8a8f9a);
  font-size: 12px;
  border-top: 1px solid var(--floating-border-muted, rgba(90, 100, 120, 0.35));
}
</style>

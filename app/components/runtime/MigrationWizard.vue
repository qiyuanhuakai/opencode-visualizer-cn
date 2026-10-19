<template>
  <dialog
    ref="dialogRef"
    class="modal-backdrop"
    :open="open"
    @close="$emit('close')"
    @cancel.prevent
    @click.self="handleClose"
  >
    <div class="modal" data-testid="migration-wizard">
      <header class="modal-header">
        <div class="modal-title">{{ $t('app.runtimeMigration.title') }}</div>
        <button type="button" class="modal-close-button" @click="handleClose">
          <Icon icon="lucide:x" :width="14" :height="14" />
        </button>
      </header>

      <p class="modal-description">{{ $t('app.runtimeMigration.description') }}</p>

      <div v-if="error" class="modal-error" data-testid="migration-error">
        <Icon icon="lucide:alert-triangle" :width="14" :height="14" />
        <span>{{ error }}</span>
      </div>

      <div v-if="retained" class="retained-note" data-testid="migration-retained">
        <Icon icon="lucide:shield" :width="14" :height="14" />
        <span>{{ $t('app.runtimeMigration.retained') }}</span>
      </div>

      <section class="inventory-section">
        <h3 class="section-title">{{ $t('app.runtimeMigration.inventory') }}</h3>
        <div class="source-list" role="group" :aria-label="$t('app.runtimeMigration.sourcesLabel')">
          <button
            v-for="source in inventory.sources"
            :key="source.sourceKey"
            type="button"
            class="source-row"
            :class="{ bound: boundSourceKeys.has(source.sourceKey) }"
            :data-testid="'migration-source-row'"
            :data-source-key="source.sourceKey"
            @click="bind(source)"
          >
            <span class="source-kind">{{ $t(`app.runtimeMigration.kind.${source.kind}`) }}</span>
            <span class="source-key">{{ source.sourceKey }}</span>
            <span class="source-meta">{{ formatBytes(source.bytes) }}</span>
          </button>
        </div>
        <div v-if="boundSourceKeys.size" class="bound-note" data-testid="migration-bound">
          <Icon icon="lucide:link" :width="14" :height="14" />
          <span>{{ $t('app.runtimeMigration.boundCount', { count: boundSourceKeys.size }) }}</span>
        </div>
      </section>

      <section v-if="backup" class="progress-section" data-testid="migration-backup-progress" :data-complete="String(backup.done)">
        <h3 class="section-title">{{ $t('app.runtimeMigration.backup') }}</h3>
        <div class="progress-track">
          <div class="progress-fill" :style="{ width: backupPercent + '%' }" />
        </div>
        <span class="progress-text">
          {{ $t('app.runtimeMigration.backupProgress', { records: backup.records, chunks: backup.chunks }) }}
        </span>
      </section>

      <section v-if="result" class="result-section" data-testid="migration-result">
        <h3 class="section-title">{{ $t('app.runtimeMigration.result') }}</h3>
        <span class="result-text">
          {{
            $t('app.runtimeMigration.resultSummary', {
              records: result.records,
              chunks: result.chunks,
              drafts: result.drafts,
              importId: result.importId,
            })
          }}
        </span>
      </section>

      <footer class="modal-actions">
        <button
          v-if="canRetry"
          type="button"
          class="action-button"
          data-testid="migration-retry"
          @click="$emit('retry')"
        >
          {{ $t('app.runtimeMigration.retry') }}
        </button>
        <button
          type="button"
          class="action-button save"
          data-testid="migration-start"
          :disabled="!canStart"
          @click="$emit('start')"
        >
          {{ $t('app.runtimeMigration.start') }}
        </button>
      </footer>
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { Icon } from '@iconify/vue';

export type MigrationSourceKind = 'composer' | 'question' | 'history' | 'metadata' | 'local';

export type MigrationSourceEntry = Readonly<{
  sourceKey: string;
  source: string;
  kind: MigrationSourceKind;
  bytes: number;
  nativeSessionId?: string;
}>;

export type MigrationInventory = Readonly<{
  revision: string;
  sources: readonly MigrationSourceEntry[];
}>;

export type MigrationBackupProgress = Readonly<{
  records: number;
  chunks: number;
  boundRecords: number;
  boundChunks: number;
  done: boolean;
}>;

export type MigrationResult = Readonly<{
  importId: string;
  records: number;
  chunks: number;
  drafts: number;
  boundRecords: number;
  localOnlyRecords: number;
}>;

const props = defineProps<{
  open: boolean;
  inventory: MigrationInventory;
  status?: 'idle' | 'backing-up' | 'migrating' | 'done' | 'failed';
  backup?: MigrationBackupProgress;
  result?: MigrationResult;
  error?: string;
  retained?: boolean;
}>();

const emit = defineEmits<{
  (event: 'close'): void;
  (event: 'bind', value: Readonly<{ sourceKey: string; nativeSessionId?: string }>): void;
  (event: 'start'): void;
  (event: 'retry'): void;
}>();

const dialogRef = ref<HTMLDialogElement | null>(null);
const boundSourceKeys = ref<ReadonlySet<string>>(new Set());

watch(
  () => props.open,
  (open) => {
    const el = dialogRef.value;
    if (!el) return;
    if (open) {
      if (!el.open) el.showModal();
    } else if (el.open) {
      el.close();
    }
  },
);

const backupPercent = computed(() => {
  const backup = props.backup;
  if (!backup || !backup.chunks) return 0;
  return Math.min(100, Math.round((backup.boundChunks / backup.chunks) * 100));
});

const canRetry = computed(() => props.status === 'failed');

const canStart = computed(() => props.status === 'idle' || props.status === 'failed');

function bind(source: MigrationSourceEntry) {
  emit('bind', { sourceKey: source.sourceKey, nativeSessionId: source.nativeSessionId });
  boundSourceKeys.value = new Set([...boundSourceKeys.value, source.sourceKey]);
}

function handleClose() {
  emit('close');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${Math.round(bytes / (1024 * 1024))} MB`;
}
</script>

<style scoped>
.modal-backdrop {
  border: none;
  padding: 0;
  margin: 0;
  background: transparent;
  color: inherit;
  position: fixed;
  inset: 0;
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  display: flex;
  align-items: center;
  justify-content: center;
}

.modal-backdrop:not([open]) {
  display: none;
}

.modal-backdrop::backdrop {
  background: var(--theme-surface-overlay, rgba(2, 6, 23, 0.65));
}

.modal {
  width: min(600px, 95vw);
  max-height: 90vh;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background: var(--theme-modal-bg, var(--theme-surface-panel-elevated, rgba(15, 23, 42, 0.98)));
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: 12px;
  box-shadow: var(--theme-shadow-panel, 0 12px 32px rgba(2, 6, 23, 0.45));
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
  font-family: var(--app-monospace-font-family);
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

.modal-close-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: 6px;
  background: transparent;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
  cursor: pointer;
}

.modal-close-button:hover {
  background: var(--theme-modal-active-bg, #1e293b);
  color: var(--theme-modal-text, #e2e8f0);
}

.modal-description {
  margin: 0;
  font-size: 12px;
  line-height: 1.45;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.modal-error,
.retained-note {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}

.modal-error {
  color: var(--theme-status-error, #f87171);
}

.retained-note {
  color: var(--color-success-400, #22c55e);
}

.section-title {
  margin: 0 0 8px;
  font-size: 12px;
  font-weight: 600;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.source-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.source-row {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 8px;
  text-align: left;
  padding: 6px 8px;
  background: var(--theme-modal-control-bg, #0b1320);
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: 8px;
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
}

.source-row:hover {
  background: var(--theme-modal-active-bg, #1e293b);
}

.source-row.bound {
  border-color: var(--color-success-400, #22c55e);
}

.source-row:focus-visible {
  outline: 2px solid var(--theme-modal-accent, #60a5fa);
  outline-offset: 1px;
}

.source-kind {
  font-weight: 600;
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.source-key {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.source-meta {
  font-size: 11px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.bound-note {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  font-size: 11px;
  color: var(--color-success-400, #22c55e);
}

.progress-track {
  height: 6px;
  border-radius: 999px;
  background: var(--theme-modal-control-bg, #0b1320);
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--theme-modal-accent, #60a5fa);
  transition: width 180ms ease-in-out;
}

.progress-text {
  display: block;
  margin-top: 6px;
  font-size: 11px;
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.result-text {
  font-size: 12px;
  color: var(--color-success-400, #22c55e);
}

.modal-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.action-button {
  background: transparent;
  border: 1px solid var(--theme-modal-border, var(--theme-border-default, #334155));
  border-radius: 8px;
  padding: 6px 14px;
  font-size: 12px;
  font-family: inherit;
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
  cursor: pointer;
}

.action-button:hover:not(:disabled) {
  background: var(--theme-modal-active-bg, #1e293b);
}

.action-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.action-button.save {
  background: color-mix(in srgb, var(--theme-modal-accent, #60a5fa) 72%, transparent);
  border-color: color-mix(in srgb, var(--theme-modal-accent, #60a5fa) 82%, transparent);
  color: var(--theme-modal-active-text, var(--theme-text-inverse, #e2e8f0));
}

.action-button.save:hover:not(:disabled) {
  background: color-mix(in srgb, var(--theme-modal-accent, #60a5fa) 88%, transparent);
}

.action-button:focus-visible {
  outline: 2px solid var(--theme-modal-accent, #60a5fa);
  outline-offset: 1px;
}
</style>

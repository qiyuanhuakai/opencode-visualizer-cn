<template>
  <section class="harness-settings" data-runtime-ui :aria-label="ariaLabel">
    <header class="harness-settings-header">
      <HarnessBadge class="harness-settings-badge" :harness="harnessKind" :detail="instanceLabel" />
      <div class="harness-settings-heading">
        <span class="harness-settings-title">{{ rt(title) }}</span>
        <span v-if="scopeDescription" class="harness-settings-scope" data-testid="harness-settings-scope">{{ scopeDescription }}</span>
      </div>
      <span v-if="unsupportedCount > 0" class="harness-settings-summary" data-testid="harness-settings-unsupported-count">
        {{ rt('{count} / {total} unavailable', { count: unsupportedCount, total: rows.length }) }}
      </span>
    </header>

    <ul class="harness-settings-list">
      <li
        v-for="row in rows"
        :key="row.control"
        class="harness-settings-row"
        :class="`is-${row.support.state}`"
        :data-control="row.control"
        :data-state="row.support.state"
        :data-group="row.group"
        :data-source-kind="row.support.state === 'unsupported' && row.support.source ? row.support.source.kind : harnessKind"
      >
        <div class="harness-settings-row-main">
          <span class="harness-settings-row-label">{{ rt(row.label) }}</span>
          <span class="harness-settings-row-operation">{{ row.operation }}</span>
        </div>
        <div class="harness-settings-row-state">
          <template v-if="row.support.state === 'supported'">
            <span class="harness-settings-available" data-testid="harness-control-available">{{ rt("available") }}</span>
            <button
              v-if="row.actionLabel"
              type="button"
              class="harness-settings-action"
              :disabled="row.disabled"
              data-testid="harness-control-action"
              @click="emit('save', row.control)"
            >
              {{ rt(row.actionLabel) }}
            </button>
          </template>
          <span v-else class="harness-settings-unavailable" data-testid="harness-control-unavailable">
            {{ rt("unavailable") }}
          </span>
        </div>
        <p v-if="row.support.state === 'unsupported'" class="harness-settings-source" data-testid="harness-control-source">
          {{ sourceLine(row.support) }}
        </p>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { useRuntimeUi } from '../../locales/runtimeUi';
const { rt } = useRuntimeUi();
import { computed } from 'vue';
import type { HarnessManifest, HarnessKind as ContractHarnessKind } from '../../../shared/runtime/harnessContract.js';
import type { ControlSupport } from '../../composables/useRuntimeCapabilities';
import { resolveControlSupport } from '../../composables/useRuntimeCapabilities';
import type { ControlScope } from '../../composables/useRuntimeCapabilities';
import { HARNESS_LABELS } from '../../composables/useRuntimeSessionTree';
import HarnessBadge from './HarnessBadge.vue';

const props = withDefaults(defineProps<{
  /** Which harness kind this panel describes. */
  harnessKind: ContractHarnessKind;
  /** The manifests visible to this panel. Only the target instance is resolved. */
  manifests: readonly HarnessManifest[];
  /** The scope the controls are entered for: the current session or an explicit instance. */
  scope: ControlScope;
  /** The controls to render, in display order. */
  controls: readonly string[];
  /** Human labels keyed by control id. */
  labels?: Readonly<Record<string, string>>;
  /** Action labels keyed by control id. Absent → read-only row. */
  actionLabels?: Readonly<Record<string, string>>;
  /** Per-control disabled state. */
  disabledControls?: readonly string[];
  title?: string;
}>(), { labels: () => ({}), actionLabels: () => ({}), disabledControls: () => [], title: '' });

const emit = defineEmits<{
  (event: 'save', control: string): void;
}>();

const ariaLabel = computed(() => rt('{name} native settings', { name: props.title || HARNESS_LABELS[props.harnessKind] }));
const instanceLabel = computed(() => {
  const target = props.scope.kind === 'session'
    ? props.scope.session.harnessInstanceId
    : props.scope.kind === 'instance' ? props.scope.harnessInstanceId : null;
  return target ? target.slice(0, 8) : undefined;
});
const scopeDescription = computed(() => {
  if (props.scope.kind === 'session') return rt('session {id}', { id: props.scope.session.nativeSessionId });
  if (props.scope.kind === 'instance') return rt('harness instance {id}', { id: props.scope.harnessInstanceId.slice(0, 8) });
  return rt('workspace {path}', { path: props.scope.canonicalPath });
});

type Row = Readonly<{
  control: string;
  label: string;
  operation: string;
  group: string;
  actionLabel: string;
  disabled: boolean;
  support: ControlSupport;
}>;

const rows = computed<readonly Row[]>(() => props.controls.map((control) => {
  const support = resolveControlSupport({ control, scope: props.scope, manifests: props.manifests });
  return Object.freeze({
    control,
    label: props.labels[control] ?? control,
    operation: support.state === 'supported' ? support.operation : (support.operation ?? control),
    group: support.state === 'supported' ? support.group : 'unavailable',
    actionLabel: props.actionLabels[control] ?? '',
    disabled: props.disabledControls.includes(control),
    support,
  });
}));

const unsupportedCount = computed(() => rows.value.filter((row) => row.support.state === 'unsupported').length);

function sourceLine(support: ControlSupport): string {
  if (support.state !== 'unsupported') return '';
  const source = support.source;
  if (support.channel === 'workspace') {
    return source?.kind === 'workspace'
      ? rt('Workspace {path} on {environment}: {reason}', { path: source.canonicalPath, environment: source.environmentId, reason: rt(support.reason) })
      : rt('Workspace: {reason}', { reason: rt(support.reason) });
  }
  return source && source.kind !== 'workspace'
    ? `${source.kind} (${source.environmentId} / ${source.harnessInstanceId}): ${rt(support.reason)}`
    : `${support.control}: ${rt(support.reason)}`;
}
</script>

<style scoped>
.harness-settings {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--theme-border-subtle, rgba(148, 163, 184, 0.18));
  border-radius: 10px;
  background: var(--theme-card-bg);
}

.harness-settings-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.harness-settings-badge {
  flex-shrink: 0;
}

.harness-settings-heading {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.harness-settings-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--theme-text-primary, #e2e8f0);
}

.harness-settings-scope {
  font-family: var(--app-monospace-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 10px;
  color: var(--theme-text-muted, #94a3b8);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.harness-settings-summary {
  margin-left: auto;
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--codex-status-warning, var(--theme-text-primary));
}

.harness-settings-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.harness-settings-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 4px 10px;
  align-items: center;
  padding: 6px 8px;
  border-radius: 8px;
  background: var(--theme-surface-panel, rgba(30, 41, 59, 0.35));
}

.harness-settings-row.is-unsupported {
  border: 1px dashed color-mix(in srgb, var(--theme-status-warning, #fcd34d) 40%, transparent);
}

.harness-settings-row-main {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.harness-settings-row-label {
  font-size: 12px;
  color: var(--theme-text-primary, #e2e8f0);
}

.harness-settings-row-operation {
  font-family: var(--app-monospace-font-family, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 10px;
  color: var(--theme-text-muted, #94a3b8);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.harness-settings-row-state {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.harness-settings-available {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--codex-status-success, var(--theme-text-primary));
}

.harness-settings-unavailable {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--codex-status-warning, var(--theme-text-primary));
}

.harness-settings-action {
  padding: 3px 10px;
  border: 1px solid color-mix(in srgb, var(--theme-accent-primary, #60a5fa) 45%, transparent);
  border-radius: 6px;
  background: var(--theme-accent-soft);
  color: var(--theme-accent-primary, #93c5fd);
  font-size: 11px;
  cursor: pointer;
}

.harness-settings-action:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.harness-settings-source {
  grid-column: 1 / -1;
  margin: 0;
  font-size: 10px;
  line-height: 1.5;
  color: var(--codex-status-warning, var(--theme-text-primary));
  word-break: break-word;
}

@media (max-width: 480px) {
  .harness-settings-row {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

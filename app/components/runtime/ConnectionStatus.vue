<template>
  <section
    v-if="identity || status || slurm"
    class="connection-status"
    data-testid="connection-lifecycle"
    :data-environment-id="identity?.environmentId ?? ''"
    :data-target-kind="identity?.targetKind ?? ''"
    :data-state="status?.state ?? 'disconnected'"
    :data-generation="String(status?.generation ?? 0)"
    :data-compute-node="slurm?.computeNode ?? ''"
    :data-job-id="slurm?.jobId ?? ''"
    :data-intent-id="slurm?.intentId ?? ''"
    :data-ownership="slurm?.ownership ?? ''"
    :data-pending-reason="pendingReason ?? ''"
    :data-terminal="slurm && isSlurmTerminal(slurm) ? 'true' : 'false'"
  >
    <header class="status-header">
      <span class="status-title">Execution target</span>
      <span class="status-chip" :data-state="status?.state ?? 'disconnected'" data-testid="connection-state">
        {{ status?.state ?? 'disconnected' }}
      </span>
    </header>

    <dl class="status-grid">
      <div class="status-cell" data-testid="connection-environment">
        <dt>Environment</dt>
        <dd class="mono" data-testid="connection-environment-id">{{ identity?.environmentId ?? '—' }}</dd>
      </div>
      <div class="status-cell" data-testid="connection-target-kind">
        <dt>Target kind</dt>
        <dd class="mono">{{ identity?.targetKind ?? '—' }}</dd>
      </div>
      <div v-if="slurm" class="status-cell" data-testid="connection-compute-node">
        <dt>Compute node</dt>
        <dd class="mono" data-testid="connection-compute-node-id">{{ slurm.computeNode ?? '—' }}</dd>
      </div>
      <div v-if="slurm" class="status-cell" data-testid="connection-job">
        <dt>Job</dt>
        <dd class="mono" data-testid="connection-job-id">{{ slurm.jobId ?? '—' }}</dd>
      </div>
      <div v-if="slurm" class="status-cell" data-testid="connection-intent">
        <dt>Intent</dt>
        <dd class="mono" data-testid="connection-intent-id">{{ slurm.intentId }}</dd>
      </div>
      <div v-if="slurm" class="status-cell" data-testid="connection-ownership">
        <dt>Ownership</dt>
        <dd class="mono" data-testid="connection-ownership-kind">{{ slurm.ownership }}</dd>
      </div>
      <div v-if="slurm" class="status-cell" data-testid="connection-queue">
        <dt>Queue / state</dt>
        <dd class="mono" data-testid="connection-queue-state">{{ slurm.queue ?? '—' }} / {{ slurm.state }}</dd>
      </div>
      <div v-if="slurm" class="status-cell" data-testid="connection-step">
        <dt>Step / epoch</dt>
        <dd class="mono" data-testid="connection-step-epoch">{{ slurm.stepId ?? '—' }} / {{ slurm.epoch ?? '—' }}</dd>
      </div>
      <div v-if="slurm" class="status-cell" data-testid="connection-bridge-instance">
        <dt>Bridge instance</dt>
        <dd class="mono" data-testid="connection-bridge-instance-id">{{ slurm.bridgeInstanceId ?? '—' }}</dd>
      </div>
    </dl>

    <p v-if="pendingReason" class="status-pending" data-testid="connection-pending-reason">
      {{ pendingReason }}
    </p>
    <p v-else-if="slurm && isSlurmTerminal(slurm)" class="status-terminal" data-testid="connection-terminal">
      Terminal: {{ slurm.terminal }}
    </p>

    <p v-if="status?.state === 'failed' && error" class="status-error" role="alert" data-testid="connection-status-error">
      {{ error }}
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type {
  RuntimeConnectionStatus,
  RuntimeTargetIdentity,
  SlurmLifecycleStatus,
} from '../../composables/useRuntimeProfiles';
import { isSlurmTerminal, slurmPendingReason } from '../../composables/useRuntimeProfiles';

const props = withDefaults(
  defineProps<{
    /** The stable environment identity the selected profile resolves to. */
    identity?: RuntimeTargetIdentity | null;
    status?: RuntimeConnectionStatus | null;
    /** The Slurm lifecycle for the attached intent, when there is one. */
    slurm?: SlurmLifecycleStatus | null;
    error?: string;
  }>(),
  { identity: null, status: null, slurm: null, error: '' },
);

/**
 * Why the execution target is not ready, derived from the control store's own fields.
 *
 * The reason is read from `queue` / `state` / `reconcile` rather than from a status string the
 * bridge happened to return, so a queued job, a lost submit acknowledgement and an ambiguous
 * submit are told apart instead of collapsing into one "pending".
 */
const pendingReason = computed<string | null>(() => {
  const slurm = props.slurm;
  if (slurm === null) return null;
  return slurmPendingReason(slurm);
});
</script>

<style scoped>
.connection-status {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--theme-border-subtle, var(--theme-border-muted, rgba(148, 163, 184, 0.18)));
  border-radius: var(--radius-panel, 10px);
  background: var(--theme-card-bg, var(--theme-surface-panel, rgba(30, 41, 59, 0.35)));
}

.status-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.status-title {
  font-size: var(--type-heading, 14px);
  font-weight: 600;
  color: var(--theme-text-primary, #e2e8f0);
}

.status-chip {
  margin-left: auto;
  font-size: var(--type-caption, 10px);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--theme-border-default, #334155);
  color: var(--theme-text-muted, #94a3b8);
}

.status-chip[data-state='connected'] {
  color: var(--theme-status-success, #86efac);
  border-color: var(--color-success-400, #22c55e);
}

.status-chip[data-state='failed'] {
  color: var(--theme-status-error, #f87171);
  border-color: var(--theme-status-error, #f87171);
}

.status-chip[data-state='connecting'] {
  color: var(--theme-status-warning, #fcd34d);
  border-color: var(--theme-status-warning, #fcd34d);
}

.status-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px 10px;
  margin: 0;
}

.status-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.status-cell dt {
  font-size: var(--type-caption, 10px);
  color: var(--theme-text-muted, #94a3b8);
}

.status-cell dd {
  margin: 0;
  font-size: var(--type-sm, 12px);
  color: var(--theme-text-primary, #e2e8f0);
  overflow: hidden;
  text-overflow: ellipsis;
}

.mono {
  font-family: var(--app-monospace-font-family);
}

.status-pending {
  margin: 0;
  font-size: var(--type-sm, 12px);
  line-height: 1.45;
  color: var(--theme-status-warning, #fcd34d);
  word-break: break-word;
}

.status-terminal {
  margin: 0;
  font-size: var(--type-sm, 12px);
  line-height: 1.45;
  color: var(--theme-text-muted, #94a3b8);
}

.status-error {
  margin: 0;
  font-size: var(--type-sm, 12px);
  line-height: 1.45;
  color: var(--theme-status-error, #f87171);
  word-break: break-word;
}

@media (max-width: 640px) {
  .status-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>

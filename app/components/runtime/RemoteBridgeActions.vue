<template>
  <section class="remote-actions" data-testid="remote-bridge-actions" aria-label="Remote bridge actions">
    <header class="actions-header">
      <span class="actions-title">Remote bridge</span>
      <span v-if="plan" class="actions-plan" data-testid="remote-bridge-plan">
        {{ plan.action }} · {{ plan.location }} · {{ plan.channel }}
      </span>
    </header>

    <div class="actions-row">
      <button
        type="button"
        class="action-button"
        data-testid="remote-detach"
        :disabled="!canDetach"
        :title="detachTitle"
        @click="$emit('detach')"
      >
        Detach
      </button>
      <button
        type="button"
        class="action-button"
        data-testid="remote-stop"
        :disabled="!canStop"
        :title="stopTitle"
        @click="$emit('stop')"
      >
        Stop
      </button>
      <button
        type="button"
        class="action-button"
        data-testid="remote-reconnect"
        :disabled="!canReconnect"
        :title="reconnectTitle"
        @click="$emit('reconnect')"
      >
        Reconnect
      </button>
      <button
        type="button"
        class="action-button"
        data-testid="remote-update"
        :disabled="!canUpdate"
        :title="updateTitle"
        @click="$emit('update')"
      >
        Update bridge
      </button>
    </div>

    <p v-if="stopRefusal" class="actions-refusal" data-testid="remote-stop-refusal">
      {{ stopRefusal }}
    </p>
    <p v-else-if="updateRefusal" class="actions-refusal" data-testid="remote-update-refusal">
      {{ updateRefusal }}
    </p>

    <p class="actions-note" data-testid="remote-detach-note">
      Detach stops tracking only. It never cancels the job, and it never signals a borrowed
      allocation — disconnect is not a stop request.
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type {
  RemoteBridgeUpdatePlan,
  RuntimeConnectionStatus,
  SlurmLifecycleStatus,
} from '../../composables/useRuntimeProfiles';
import { stopRefusalReason, updateRefusalReason } from '../../composables/useRuntimeProfiles';

const props = withDefaults(
  defineProps<{
    slurm?: SlurmLifecycleStatus | null;
    status?: RuntimeConnectionStatus | null;
    plan?: RemoteBridgeUpdatePlan | null;
    busy?: boolean;
  }>(),
  { slurm: null, status: null, plan: null, busy: false },
);

// The template consumes the emits through `$emit`; the refs below are the only script-side state
// this surface has, and every one of them is a pure read of the props.
defineEmits<{
  (event: 'detach'): void;
  (event: 'stop'): void;
  (event: 'reconnect'): void;
  (event: 'update'): void;
}>();

const attached = computed(() => props.slurm !== null && props.slurm.attached);

/** Detach is the only action always available on an attached intent. */
const canDetach = computed(() => attached.value && !props.busy);
const detachTitle = computed(() =>
  attached.value ? 'Stop tracking this job without cancelling it' : 'No attached execution to detach');

/**
 * Stop is owned-only.
 *
 * `stopRefusalReason` reads the intent's OWN `ownership` field, so a borrowed allocation is
 * refused before any signal can be produced rather than refused by a status string after the
 * fact. A terminal job and a job with no scheduler id are refused for the same reason.
 */
const stopRefusal = computed<string | null>(() => {
  const slurm = props.slurm;
  if (slurm === null || !slurm.attached) return null;
  const refusal = stopRefusalReason(slurm);
  if (refusal === 'borrowed') return 'Borrowed allocation: this client never signals it.';
  if (refusal === 'terminal') return `Terminal (${slurm.terminal}): nothing left to stop.`;
  if (refusal === 'no-job') return 'No scheduler job id yet: the submit has not been confirmed.';
  return null;
});
const canStop = computed(() => attached.value && stopRefusal.value === null && !props.busy);
const stopTitle = computed(() => stopRefusal.value ?? 'Cancel the job this client owns');

/**
 * Reconnect requires the live job and the bridge instance it was bound to.
 *
 * A reconnect without them would attach to whatever answered, which is exactly the ambiguity the
 * relay handshake exists to reject.
 */
const canReconnect = computed(() => {
  const slurm = props.slurm;
  if (slurm === null) return false;
  return slurm.bridgeInstanceId !== null && !props.busy;
});
const reconnectTitle = computed(() =>
  canReconnect.value
    ? 'Re-attach to the live job and its bound bridge instance'
    : 'Reconnect needs the live job and its bound bridge instance');

const updateRefusal = computed<string | null>(() => {
  if (props.plan === null) return 'No bridge probe yet: the update path is unknown.';
  const refusal = updateRefusalReason(props.plan);
  if (refusal === 'unsupported') return 'The installed bridge is not compatible with this client.';
  if (refusal === 'not-explicit') return 'Bridge updates are never automatic.';
  return null;
});
const canUpdate = computed(() => updateRefusal.value === null && !props.busy);
const updateTitle = computed(() => updateRefusal.value ?? `Explicitly ${props.plan?.action ?? 'update'} the remote bridge`);
</script>

<style scoped>
.remote-actions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--theme-border-subtle, var(--theme-border-muted, rgba(148, 163, 184, 0.18)));
  border-radius: var(--radius-panel, 10px);
  background: var(--theme-card-bg, var(--theme-surface-panel, rgba(30, 41, 59, 0.35)));
}

.actions-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.actions-title {
  font-size: var(--type-heading, 14px);
  font-weight: 600;
  color: var(--theme-text-primary, #e2e8f0);
}

.actions-plan {
  margin-left: auto;
  font-family: var(--app-monospace-font-family);
  font-size: var(--type-caption, 10px);
  color: var(--theme-text-muted, #94a3b8);
}

.actions-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.action-button {
  padding: 6px 14px;
  border: 1px solid var(--theme-input-border, var(--theme-border-default, #334155));
  border-radius: var(--radius-control, 8px);
  background: transparent;
  color: var(--theme-text-primary, #e2e8f0);
  font-family: inherit;
  font-size: var(--type-sm, 12px);
  cursor: pointer;
}

.action-button:hover:not(:disabled) {
  background: var(--theme-surface-panel-hover, rgba(15, 23, 42, 0.9));
}

.action-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.action-button:focus-visible {
  outline: 2px solid var(--theme-accent-primary, #60a5fa);
  outline-offset: 1px;
}

.actions-refusal {
  margin: 0;
  font-size: var(--type-sm, 12px);
  line-height: 1.45;
  color: var(--theme-status-warning, #fcd34d);
  word-break: break-word;
}

.actions-note {
  margin: 0;
  font-size: var(--type-caption, 10px);
  line-height: 1.45;
  color: var(--theme-text-muted, #94a3b8);
}

@media (max-width: 480px) {
  .actions-row {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>

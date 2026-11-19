<template>
  <!--
    One task's attempts: the native ladder (accepted → sent → observed → terminal) and the task's
    phase. `Agent finished` is shown when a native end moved the task to `review`; `Review pending`
    only after the task is explicitly submitted. A native end alone never shows review-pending or
    accepted — those come from the acceptance path.
  -->
  <section class="attempt-details" data-runtime-ui data-testid="attempt-details" :data-task-id="task.taskId" :data-phase="task.phase" :aria-label='rt("Attempt details")'>
    <div class="section-title">{{ rt("Attempts ·") }} {{ phaseLabel(task.phase) }}</div>

    <p class="attempt-phase" data-testid="attempt-phase" :data-phase="task.phase">
      <span class="phase-chip" :class="'phase-' + task.phase">{{ phaseLabel(task.phase) }}</span>
      <span class="attempt-phase-note">{{ phaseNote(task.phase) }}</span>
    </p>

    <ul v-if="attempts.length > 0" class="attempt-list">
      <li
        v-for="attempt in attempts"
        :key="attempt.attemptId"
        class="attempt-row"
        data-testid="attempt-row"
        :data-attempt-id="attempt.attemptId"
        :data-state="attempt.state"
      >
        <span class="attempt-state">{{ rt(attempt.state) }}</span>
        <span class="attempt-flags mono">{{ flagsOf(attempt) }}</span>
        <span v-if="attempt.terminalReason" class="attempt-reason" data-testid="attempt-reason">{{ rt(attempt.terminalReason) }}</span>
        <span class="attempt-sends mono">{{ rt("sends:") }}{{ attempt.sends }}</span>
      </li>
    </ul>
    <p v-else class="empty-note" data-testid="attempt-empty">{{ rt("No attempts yet. Dispatch the task first.") }}</p>

    <div class="attempt-actions">
      <button type="button" class="action-button" data-testid="attempt-dispatch" :disabled="busy || (task.phase !== 'pending' && task.phase !== 'paused')" @click="emit('dispatch', task.taskId)">
        {{ rt("Dispatch") }}
      </button>
      <button type="button" class="action-button" data-testid="attempt-send" :disabled="busy || task.phase !== 'dispatched'" @click="emit('send', task.taskId)">
        {{ rt("Send") }}
      </button>
    </div>
    <p v-if="task.phase === 'dispatched'" class="empty-note" role="status">{{ rt("Waiting for the Agent to report completion through the Bridge.") }}</p>

    <div class="deliverable-actions">
      <button
        type="button"
        class="action-button"
        data-testid="register-deliverable"
        :disabled="busy || !canCapture || task.phase === 'accepted' || task.phase === 'cancelled'"
        :title="rt(registerDeliverableNote)"
        @click="emit('capture-deliverable', task.taskId)"
      >
        {{ rt("Register deliverable") }}
      </button>
      <p class="deliverable-note" data-testid="register-deliverable-note">{{ rt(registerDeliverableNote) }}</p>
      <button
        type="button"
        class="action-button"
        data-testid="submit-review"
        :disabled="busy || task.phase !== 'agent-finished'"
        @click="emit('submit-review', { taskId: props.task.taskId, reviewer: 'reviewer' })"
      >
        {{ rt("Submit for review") }}
      </button>
    </div>

    <div v-if="task.deliverables.length > 0" class="deliverable-list" data-testid="deliverable-list">
      <div class="section-title">{{ rt("Deliverables") }}</div>
      <ul>
        <li v-for="deliverable in task.deliverables" :key="deliverable.deliverableId" class="deliverable-row" data-testid="deliverable-row" :data-deliverable-id="deliverable.deliverableId">
          <span class="deliverable-id mono">{{ shortId(deliverable.deliverableId) }}</span>
          <span class="deliverable-hash mono" :title="deliverable.artifactHash">{{ shortId(deliverable.artifactHash) }}</span>
          <span class="deliverable-bytes mono">{{ deliverable.bytes }}B</span>
          <span class="deliverable-paths mono">{{ deliverable.paths.join(', ') }}</span>
        </li>
      </ul>
    </div>
  </section>
</template>

<script setup lang="ts">
import { useRuntimeUi } from '../../locales/runtimeUi';
const { rt } = useRuntimeUi();
import type { CollaborationAttemptView, CollaborationTaskView, TaskPhase } from '../../composables/useRuntimeCollaboration';
const props = defineProps<{
  task: CollaborationTaskView;
  attempts: readonly CollaborationAttemptView[];
  busy?: boolean;
  canCapture?: boolean;
}>();

const emit = defineEmits<{
  (event: 'capture-deliverable', taskId: string): void;
  (event: 'dispatch', taskId: string): void;
  (event: 'send', taskId: string): void;
  (event: 'finish', input: { taskId: string; nativeEventId: string }): void;
  (event: 'register-deliverable', input: { taskId: string; deliverable: { deliverableId: string; artifactHash: string; bytes: number; paths: readonly string[] } }): void;
  (event: 'submit-review', input: { taskId: string; reviewer: string }): void;
}>();

const PHASE_LABELS: Readonly<Record<TaskPhase, string>> = Object.freeze({
  pending: 'Pending',
  dispatched: 'Dispatched',
  'agent-finished': 'Agent finished',
  'review-pending': 'Review pending',
  'review-approved': 'Review approved',
  accepted: 'Accepted',
  failed: 'Failed',
  cancelled: 'Cancelled',
  paused: 'Paused',
});

function phaseLabel(phase: TaskPhase): string {
  return rt(PHASE_LABELS[phase] ?? phase);
}

function phaseNote(phase: TaskPhase): string {
  switch (phase) {
    case 'agent-finished':
      return rt('The agent run finished; not yet reviewed.');
    case 'review-pending':
      return rt('Submitted for review; awaiting a verdict.');
    case 'review-approved':
      return rt('The review is approved; the task can be accepted.');
    case 'accepted':
      return rt('A reviewer accepted this task.');
    default:
      return '';
  }
}

/**
 * A deliverable is an ARTIFACT: its id, hash, byte count and paths come from a captured artifact,
 * never from this button. No artifact capture is wired into this surface yet, so the button
 * registers NOTHING rather than writing a fabricated record (an all-zero hash, zero bytes and a
 * synthetic path) that would then occupy the first deliverable slot the accept path reads. The
 * container registers the real artifact through the composable.
 */
const registerDeliverableNote = 'Capture the actual changes from this task’s writer worktree. The Bridge stores and verifies the artifact before registering it.';

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

function flagsOf(attempt: CollaborationAttemptView): string {
  const flag = (value: boolean): string => (value ? '1' : '0');
  return rt('sent:{sent} observed:{observed} terminal:{terminal}', { sent: flag(attempt.sent), observed: flag(attempt.observed), terminal: flag(attempt.terminal) });
}
</script>

<style scoped>
.attempt-details {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 10px;
  border: 1px solid var(--theme-border-subtle, var(--theme-border-muted, rgba(148, 163, 184, 0.18)));
  border-radius: var(--radius-panel, 10px);
  background: var(--theme-card-bg, var(--theme-surface-panel, rgba(30, 41, 59, 0.35)));
}

.section-title {
  font-size: var(--type-caption, 10px);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--theme-text-muted, #94a3b8);
}

.attempt-phase {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin: 0;
}

.phase-chip {
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--theme-border-default, #334155);
  font-size: var(--type-caption, 10px);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--theme-text-muted, #94a3b8);
}

.phase-chip.phase-agent-finished {
  color: var(--codex-status-info, var(--theme-text-primary));
  border-color: color-mix(in srgb, var(--theme-status-info, #7dd3fc) 45%, transparent);
  background: color-mix(in srgb, var(--theme-status-info, #7dd3fc) 10%, transparent);
}

.phase-chip.phase-review-pending {
  color: var(--codex-status-warning, var(--theme-text-primary));
  border-color: color-mix(in srgb, var(--theme-status-warning, #fcd34d) 45%, transparent);
  background: color-mix(in srgb, var(--theme-status-warning, #fcd34d) 10%, transparent);
}

.phase-chip.phase-accepted {
  color: var(--codex-status-success, var(--theme-text-primary));
  border-color: color-mix(in srgb, var(--theme-status-success, #4ade80) 45%, transparent);
  background: color-mix(in srgb, var(--theme-status-success, #4ade80) 12%, transparent);
}

.attempt-phase-note {
  font-size: var(--type-caption, 10px);
  color: var(--theme-text-muted, #94a3b8);
}

.attempt-list,
.deliverable-list ul {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.attempt-row,
.deliverable-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 4px 8px;
  border: 1px solid var(--theme-border-default, #334155);
  border-radius: var(--radius-control, 8px);
  background: var(--theme-surface-panel-muted, rgba(15, 23, 42, 0.72));
  font-size: var(--type-caption, 10px);
}

.attempt-state {
  font-weight: 600;
  color: var(--codex-status-info, var(--theme-text-primary));
}

.attempt-row[data-state='terminal'] .attempt-state {
  color: var(--codex-status-success, var(--theme-text-primary));
}

.attempt-row[data-state='reconcile'] .attempt-state {
  color: var(--codex-status-warning, var(--theme-text-primary));
}

.attempt-flags,
.attempt-sends,
.deliverable-hash,
.deliverable-bytes,
.deliverable-paths {
  color: var(--theme-text-muted, #94a3b8);
}

.attempt-reason {
  color: var(--theme-text-primary, #e2e8f0);
}

.deliverable-id {
  color: var(--theme-text-primary, #e2e8f0);
}

.deliverable-note {
  margin: 0;
  flex-basis: 100%;
  font-size: var(--type-caption, 10px);
  color: var(--theme-text-muted, #94a3b8);
}

.attempt-actions,
.deliverable-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}

.empty-note {
  margin: 0;
  font-size: var(--type-caption, 10px);
  color: var(--theme-text-muted, #94a3b8);
}

.action-button {
  padding: 4px 10px;
  border: 1px solid var(--theme-input-border, var(--theme-border-default, #334155));
  border-radius: var(--radius-control, 8px);
  background: transparent;
  color: var(--theme-text-primary, #e2e8f0);
  font-family: inherit;
  font-size: var(--type-caption, 10px);
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
</style>

<template>
  <!--
    One task's attempts: the native ladder (accepted → sent → observed → terminal) and the task's
    phase. `Agent finished` is shown when a native end moved the task to `review`; `Review pending`
    only after the task is explicitly submitted. A native end alone never shows review-pending or
    accepted — those come from the acceptance path.
  -->
  <section class="attempt-details" data-testid="attempt-details" :data-task-id="task.taskId" :data-phase="task.phase" aria-label="Attempt details">
    <div class="section-title">Attempts · {{ phaseLabel(task.phase) }}</div>

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
        <span class="attempt-state">{{ attempt.state }}</span>
        <span class="attempt-flags mono">{{ flagsOf(attempt) }}</span>
        <span v-if="attempt.terminalReason" class="attempt-reason" data-testid="attempt-reason">{{ attempt.terminalReason }}</span>
        <span class="attempt-sends mono">sends:{{ attempt.sends }}</span>
      </li>
    </ul>
    <p v-else class="empty-note" data-testid="attempt-empty">No attempts yet. Dispatch the task first.</p>

    <div class="attempt-actions">
      <button type="button" class="action-button" data-testid="attempt-dispatch" :disabled="busy || task.phase !== 'pending'" @click="emit('dispatch', task.taskId)">
        Dispatch
      </button>
      <button type="button" class="action-button" data-testid="attempt-send" :disabled="busy || task.phase !== 'dispatched'" @click="emit('send', task.taskId)">
        Send
      </button>
      <span class="finish-group">
        <input v-model="nativeEventId" class="native-event-input" type="text" placeholder="native event id" data-testid="native-event-input" :disabled="busy" />
        <button
          type="button"
          class="action-button"
          data-testid="attempt-finish"
          :disabled="busy || task.phase !== 'dispatched' || nativeEventId.trim().length === 0"
          @click="handleFinish"
        >
          Native end
        </button>
      </span>
    </div>

    <div class="deliverable-actions">
      <button
        type="button"
        class="action-button"
        data-testid="register-deliverable"
        :disabled="busy || task.phase !== 'agent-finished'"
        @click="handleRegisterDeliverable"
      >
        Register deliverable
      </button>
      <button
        type="button"
        class="action-button"
        data-testid="submit-review"
        :disabled="busy || task.phase !== 'agent-finished'"
        @click="emit('submit-review', { taskId: task.taskId, reviewer: 'reviewer' })"
      >
        Submit for review
      </button>
    </div>

    <div v-if="task.deliverables.length > 0" class="deliverable-list" data-testid="deliverable-list">
      <div class="section-title">Deliverables</div>
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
import { ref } from 'vue';
import type { CollaborationAttemptView, CollaborationTaskView, TaskPhase } from '../../composables/useRuntimeCollaboration';
const props = defineProps<{
  task: CollaborationTaskView;
  attempts: readonly CollaborationAttemptView[];
  busy?: boolean;
}>();

const emit = defineEmits<{
  (event: 'dispatch', taskId: string): void;
  (event: 'send', taskId: string): void;
  (event: 'finish', input: { taskId: string; nativeEventId: string }): void;
  (event: 'register-deliverable', input: { taskId: string; deliverable: { deliverableId: string; artifactHash: string; bytes: number; paths: readonly string[] } }): void;
  (event: 'submit-review', input: { taskId: string; reviewer: string }): void;
}>();

const nativeEventId = ref('');

const PHASE_LABELS: Readonly<Record<TaskPhase, string>> = Object.freeze({
  pending: 'Pending',
  dispatched: 'Dispatched',
  'agent-finished': 'Agent finished',
  'review-pending': 'Review pending',
  accepted: 'Accepted',
  failed: 'Failed',
  cancelled: 'Cancelled',
  paused: 'Paused',
});

function phaseLabel(phase: TaskPhase): string {
  return PHASE_LABELS[phase] ?? phase;
}

function phaseNote(phase: TaskPhase): string {
  switch (phase) {
    case 'agent-finished':
      return 'The agent run finished; not yet reviewed.';
    case 'review-pending':
      return 'Submitted for review; awaiting a verdict.';
    case 'accepted':
      return 'A reviewer accepted this task.';
    default:
      return '';
  }
}

function handleFinish(): void {
  if (nativeEventId.value.trim().length === 0) return;
  emit('finish', { taskId: props.task.taskId, nativeEventId: nativeEventId.value });
  nativeEventId.value = '';
}

function handleRegisterDeliverable(): void {
  // The deliverable id and hash are supplied by the container through the real service; the UI only
  // names the deliverable it is registering against this task.
  emit('register-deliverable', {
    taskId: props.task.taskId,
    deliverable: {
      deliverableId: `deliverable-${props.task.taskId.slice(0, 8)}`,
      artifactHash: '0'.repeat(64),
      bytes: 0,
      paths: ['(registered by the review surface)'],
    },
  });
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

function flagsOf(attempt: CollaborationAttemptView): string {
  const flag = (value: boolean): string => (value ? '1' : '0');
  return `sent:${flag(attempt.sent)} observed:${flag(attempt.observed)} terminal:${flag(attempt.terminal)}`;
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
  color: var(--theme-status-info, #7dd3fc);
  border-color: color-mix(in srgb, var(--theme-status-info, #7dd3fc) 45%, transparent);
  background: color-mix(in srgb, var(--theme-status-info, #7dd3fc) 10%, transparent);
}

.phase-chip.phase-review-pending {
  color: var(--theme-status-warning, #fcd34d);
  border-color: color-mix(in srgb, var(--theme-status-warning, #fcd34d) 45%, transparent);
  background: color-mix(in srgb, var(--theme-status-warning, #fcd34d) 10%, transparent);
}

.phase-chip.phase-accepted {
  color: var(--theme-status-success, #4ade80);
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
  color: var(--theme-status-info, #7dd3fc);
}

.attempt-row[data-state='terminal'] .attempt-state {
  color: var(--theme-status-success, #4ade80);
}

.attempt-row[data-state='reconcile'] .attempt-state {
  color: var(--theme-status-warning, #fcd34d);
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

.attempt-actions,
.deliverable-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}

.finish-group {
  display: inline-flex;
  gap: 6px;
  align-items: center;
}

.native-event-input {
  width: 140px;
  padding: 4px 8px;
  border: 1px solid var(--theme-input-border, var(--theme-border-default, #334155));
  border-radius: var(--radius-control, 8px);
  background: var(--theme-input-bg, var(--theme-surface-panel-muted, rgba(15, 23, 42, 0.72)));
  color: var(--theme-input-text, var(--theme-text-primary, #e2e8f0));
  font-family: inherit;
  font-size: var(--type-caption, 10px);
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

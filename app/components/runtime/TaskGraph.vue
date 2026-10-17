<template>
  <!--
    The task DAG. Each task renders its phase VERBATIM from the composable's derived read model, and
    the three review phases are kept visually distinct: Agent finished (a native end ran), Task
    review pending (submitted, awaiting a verdict), accepted (a reviewer approved it). The phase is
    never recomputed here and a native terminal event can never render as `accepted`.
  -->
  <section class="task-graph" data-testid="task-graph" aria-label="Task graph">
    <div class="section-title">Tasks</div>
    <ul v-if="tasks.length > 0" class="task-list">
      <li
        v-for="task in tasks"
        :key="task.taskId"
        class="task-row"
        data-testid="task-row"
        :data-task-id="task.taskId"
        :data-phase="task.phase"
        :data-depth="String(task.depth)"
        :class="{ 'is-selected': task.taskId === selectedTaskId }"
        :style="{ paddingLeft: `${4 + task.depth * 12}px` }"
      >
        <button type="button" class="task-select" data-testid="task-select" @click="emit('select-task', task.taskId)">
          <span class="phase-chip" :class="'phase-' + task.phase" data-testid="phase-chip">{{ phaseLabel(task.phase) }}</span>
          <span class="task-title">{{ task.title }}</span>
          <span v-if="task.blockedBy.length > 0" class="task-blocked mono" data-testid="task-blocked">blocked by {{ task.blockedBy.length }}</span>
          <span v-if="task.pausedReasons.length > 0" class="task-paused" data-testid="task-paused">paused: {{ task.pausedReasons.join(', ') }}</span>
          <span v-if="task.ambiguous" class="task-ambiguous" data-testid="task-ambiguous">ambiguous</span>
        </button>
        <div class="task-actions">
          <button
            type="button"
            class="action-button"
            data-testid="task-dispatch"
            :disabled="task.phase !== 'pending'"
            @click="emit('dispatch', task.taskId)"
          >
            Dispatch
          </button>
          <button
            type="button"
            class="action-button"
            data-testid="task-submit-review"
            :disabled="task.phase !== 'agent-finished'"
            @click="emit('submit-review', { taskId: task.taskId, reviewer: 'reviewer' })"
          >
            Submit review
          </button>
          <button
            type="button"
            class="action-button"
            data-testid="task-accept"
            :disabled="task.phase !== 'review-pending'"
            @click="emit('accept', { taskId: task.taskId, deliverableId: firstDeliverableId(task), acceptedBy: 'reviewer', criteria: task.criteria.map((c) => ({ id: c.id, met: true })) })"
          >
            Accept
          </button>
          <button
            type="button"
            class="action-button"
            data-testid="task-reject"
            :disabled="task.phase !== 'review-pending'"
            @click="emit('reject', { taskId: task.taskId, reason: 'rejected by reviewer' })"
          >
            Reject
          </button>
          <button
            type="button"
            class="action-button"
            data-testid="task-cancel"
            :disabled="task.phase === 'accepted' || task.phase === 'cancelled'"
            @click="emit('cancel', { taskId: task.taskId, reason: 'cancelled by reviewer' })"
          >
            Cancel
          </button>
        </div>
      </li>
    </ul>
    <p v-else class="empty-note" data-testid="task-graph-empty">No tasks yet.</p>
  </section>
</template>

<script setup lang="ts">
import type { CollaborationTaskView, TaskPhase } from '../../composables/useRuntimeCollaboration';

defineProps<{
  tasks: readonly CollaborationTaskView[];
  selectedTaskId: string | null;
}>();

const emit = defineEmits<{
  (event: 'select-task', taskId: string): void;
  (event: 'dispatch', taskId: string): void;
  (event: 'submit-review', input: { taskId: string; reviewer: string }): void;
  (event: 'review', input: { taskId: string; decision: string; reviewer: string }): void;
  (event: 'accept', input: { taskId: string; deliverableId: string; acceptedBy: string; criteria: readonly { id: string; met: boolean }[] }): void;
  (event: 'reject', input: { taskId: string; reason: string }): void;
  (event: 'cancel', input: { taskId: string; reason?: string }): void;
}>();

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

function firstDeliverableId(task: CollaborationTaskView): string {
  return task.deliverables[0]?.deliverableId ?? '';
}
</script>

<style scoped>
.task-graph {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.section-title {
  font-size: var(--type-caption, 10px);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--theme-text-muted, #94a3b8);
}

.task-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.task-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 8px;
  border: 1px solid var(--theme-border-default, #334155);
  border-radius: var(--radius-control, 8px);
  background: var(--theme-surface-panel-muted, rgba(15, 23, 42, 0.72));
}

.task-row.is-selected {
  border-color: var(--theme-accent-primary, #60a5fa);
}

.task-select {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 200px;
  min-width: 0;
  border: none;
  background: transparent;
  color: inherit;
  font-family: inherit;
  text-align: start;
  cursor: pointer;
}

.phase-chip {
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--theme-border-default, #334155);
  font-size: var(--type-caption, 10px);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  white-space: nowrap;
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

.phase-chip.phase-failed,
.phase-chip.phase-cancelled {
  color: var(--theme-status-error, #f87171);
  border-color: color-mix(in srgb, var(--theme-status-error, #f87171) 45%, transparent);
}

.task-title {
  color: var(--theme-text-primary, #e2e8f0);
  font-size: var(--type-sm, 12px);
}

.task-blocked,
.task-paused,
.task-ambiguous {
  font-size: var(--type-caption, 10px);
  color: var(--theme-status-warning, #fcd34d);
}

.task-actions {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
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

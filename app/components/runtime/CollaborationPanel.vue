<template>
  <!--
    Task 42 — the Team task and change-review surface. The root is a modal in the panel variant so
    the collaboration review never leaks into the inline composer. Every phase distinction
    (Agent finished / Task review pending / accepted) is rendered verbatim from the read model the
    composable derives from the landed services — nothing here recomputes a state.
  -->
  <dialog
    ref="dialogRef"
    class="collab-root modal-backdrop"
    data-testid="collaboration-panel"
    :data-thread-id="threadId ?? ''"
    :data-team-id="team?.teamId ?? ''"
    @close="$emit('close')"
    @cancel.prevent
    @click.self="handleClose"
  >
    <div class="modal">
      <header class="modal-header">
        <div class="modal-title">Team &amp; change review</div>
        <span v-if="team" class="collab-meta mono" data-testid="collab-team-meta">
          {{ team.name }} · {{ shortId(threadId ?? '') }} · {{ tasks.length }} tasks
        </span>
        <button type="button" class="modal-close-button" data-testid="collab-close" @click="handleClose">
          <Icon icon="lucide:x" :width="14" :height="14" />
        </button>
      </header>

      <p v-if="error" class="modal-error" role="alert" data-testid="collab-error">
        <Icon icon="lucide:alert-triangle" :width="14" :height="14" />
        <span>{{ error }}</span>
      </p>

      <TeamEditor
        :team="team"
        :budgets="budgets"
        :fanout="fanout"
        :busy="busy"
        @add-member="emit('add-member', $event)"
        @create-task="emit('create-task', $event)"
        @fan-out="emit('fan-out', $event)"
      />

      <TaskGraph
        :tasks="tasks"
        :selected-task-id="selectedTaskId"
        @select-task="emit('select-task', $event)"
        @dispatch="emit('dispatch', $event)"
        @submit-review="emit('submit-review', $event)"
        @review="emit('review', $event)"
        @accept="emit('accept', $event)"
        @reject="emit('reject', $event)"
        @cancel="emit('cancel', $event)"
      />

      <AttemptDetails
        v-if="selectedTask"
        :task="selectedTask"
        :attempts="attempts"
        :busy="busy"
        @dispatch="emit('dispatch', $event)"
        @send="emit('send', $event)"
        @finish="emit('finish', $event)"
        @register-deliverable="emit('register-deliverable', $event)"
        @submit-review="emit('submit-review', $event)"
      />

      <ArtifactReview
        v-if="selectedTask"
        :task="selectedTask"
        :writer="writer"
        :busy="busy"
        @allocate-writer="emit('allocate-writer', $event)"
        @approve="emit('approve', $event)"
      />
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import type { SessionRef } from '../../../shared/runtime/identity.js';
import type {
  CollaborationAttemptView,
  CollaborationBudgetView,
  CollaborationFanoutView,
  CollaborationTaskView,
  CollaborationTeamView,
  CollaborationWriterView,
} from '../../composables/useRuntimeCollaboration';
import TeamEditor from './TeamEditor.vue';
import TaskGraph from './TaskGraph.vue';
import AttemptDetails from './AttemptDetails.vue';
import ArtifactReview from './ArtifactReview.vue';

const props = defineProps<{
  open?: boolean;
  /** The captured Thread target every operation is scoped to. */
  threadId: string | null;
  team: CollaborationTeamView | null;
  tasks: readonly CollaborationTaskView[];
  selectedTaskId: string | null;
  selectedTask: CollaborationTaskView | null;
  attempts: readonly CollaborationAttemptView[];
  budgets: CollaborationBudgetView | null;
  fanout: CollaborationFanoutView | null;
  writer: CollaborationWriterView | null;
  busy?: boolean;
  error?: string;
}>();

const emit = defineEmits<{
  (event: 'close'): void;
  (event: 'select-task', taskId: string): void;
  (event: 'add-member', input: { role: 'lead' | 'worker'; harnessKind: string; session: SessionRef; participantId: string }): void;
  (event: 'create-task', input: { title: string; criteria: readonly { id: string; text: string; required?: boolean }[] }): void;
  (event: 'fan-out', input: { prompt: string; targets: readonly { participantId: string; session: SessionRef; attachmentPath?: string }[] }): void;
  (event: 'dispatch', taskId: string): void;
  (event: 'send', taskId: string): void;
  (event: 'finish', input: { taskId: string; nativeEventId: string }): void;
  (event: 'register-deliverable', input: { taskId: string; deliverable: { deliverableId: string; artifactHash: string; bytes: number; paths: readonly string[] } }): void;
  (event: 'submit-review', input: { taskId: string; reviewer: string }): void;
  (event: 'review', input: { taskId: string; decision: string; reviewer: string }): void;
  (event: 'accept', input: { taskId: string; deliverableId: string; acceptedBy: string; criteria: readonly { id: string; met: boolean }[] }): void;
  (event: 'reject', input: { taskId: string; reason: string }): void;
  (event: 'cancel', input: { taskId: string; reason?: string }): void;
  (event: 'allocate-writer', input: { taskId: string; repository: string }): void;
  (event: 'approve', input: { taskId: string; reviewerId: string }): void;
}>();

const dialogRef = ref<HTMLDialogElement | null>(null);

/**
 * The native modal's lifecycle is driven by the EXPECTED open state, through showModal()/close(),
 * never by setting the `open` attribute and reading it back to decide whether to call showModal:
 * a caller that mounts with open=true would otherwise skip showModal and get a non-modal dialog
 * (no ::backdrop, no focus isolation, no page inert), while a caller that mounts with open=false
 * would be opened by a watcher that only checked the element's own attribute. Both the prop and
 * the element are watched, so the call also happens once the element itself mounts.
 */
watch(
  () => [props.open, dialogRef.value] as const,
  ([expectedOpen, element]) => {
    if (element === null) return;
    if (expectedOpen && !element.open) element.showModal();
    else if (!expectedOpen && element.open) element.close();
  },
);

function handleClose(): void {
  emit('close');
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
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
  width: min(820px, 95vw);
  max-height: 92vh;
  overflow: auto;
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
  gap: 8px;
  flex-wrap: wrap;
}

.modal-title {
  font-size: var(--type-heading, 14px);
  font-weight: 600;
}

.collab-meta {
  font-size: var(--type-caption, 10px);
  color: var(--theme-modal-text-muted, var(--theme-text-muted, #94a3b8));
}

.modal-close-button {
  margin-left: auto;
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
  color: var(--theme-modal-text, var(--theme-text-primary, #e2e8f0));
}

.modal-error {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: var(--type-sm, 12px);
  color: var(--theme-status-error, #f87171);
  word-break: break-word;
}

.mono {
  font-family: var(--app-monospace-font-family);
}

@media (max-width: 640px) {
  .modal {
    width: 95vw;
  }
}
</style>

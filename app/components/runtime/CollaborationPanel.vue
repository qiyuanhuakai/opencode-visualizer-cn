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
    data-runtime-ui
    :aria-label='rt("Team and change review")'
    data-testid="collaboration-panel"
    :data-thread-id="threadId ?? ''"
    :data-team-id="team?.teamId ?? ''"
    @close="$emit('close')"
    @cancel.prevent="handleClose"
    @click.self="handleClose"
  >
    <div class="modal">
      <header class="modal-header">
        <div class="modal-title">{{ rt("Team & change review") }}</div>
        <span v-if="team" class="collab-meta mono" data-testid="collab-team-meta">
          {{ team.name }} · {{ shortId(threadId ?? '') }} · {{ tasks.length }} {{ rt("tasks") }}
        </span>
        <button type="button" class="modal-close-button" data-testid="collab-close" :aria-label='rt("Close team and change review")' @click="handleClose">
          <Icon icon="lucide:x" :width="14" :height="14" />
        </button>
      </header>

      <p v-if="error" class="modal-error" role="alert" data-testid="collab-error">
        <Icon icon="lucide:alert-triangle" :width="14" :height="14" />
        <span>{{ rt(error) }}</span>
      </p>

      <section v-if="fanouts?.length" class="fanout-history">
        <Dropdown :model-value="fanout?.fanoutId" :label="fanout ? fanoutLabel(fanout) : rt('Fan-out history')" :aria-label="rt('Fan-out history')" auto-close :disabled="busy" @update:model-value="selectFanout">
          <DropdownItem v-for="(entry, index) in fanouts" :key="entry.fanoutId" :value="entry.fanoutId">{{ (fanoutPage?.offset ?? 0) + index + 1 }} · {{ fanoutLabel(entry) }}</DropdownItem>
        </Dropdown>
        <nav v-if="fanoutPage && fanoutPage.total > 50" class="runtime-pagination" :aria-label="rt('Fan-out pages')">
          <button type="button" class="action-button" :disabled="busy || fanoutPage.offset === 0" @click="emit('fanout-page', Math.max(0, fanoutPage.offset - 50))">{{ rt('Previous fan-outs') }}</button>
          <span>{{ fanoutPage.offset + 1 }}–{{ Math.min(fanoutPage.offset + 50, fanoutPage.total) }} / {{ fanoutPage.total }}</span>
          <button type="button" class="action-button" :disabled="busy || fanoutPage.nextCursor === null" @click="emit('fanout-page', fanoutPage.nextCursor ?? 0)">{{ rt('Next fan-outs') }}</button>
        </nav>
      </section>

      <TeamEditor
        :team="team"
        :budgets="budgets"
        :fanout="fanout"
        :fanout-action="fanoutAction"
        :busy="busy"
        :available-members="availableMembers"
        @add-member="emit('add-member', $event)"
        @create-task="emit('create-task', $event)"
        @fan-out="emit('fan-out', $event)"
      />

      <nav v-if="memberPage && memberPage.total > 50" class="runtime-pagination" :aria-label="rt('Member pages')">
        <button type="button" :disabled="busy || memberPage.offset === 0" @click="emit('member-page', Math.max(0, memberPage.offset - 50))">{{ rt('Previous members') }}</button>
        <span>{{ memberPage.offset + 1 }}–{{ Math.min(memberPage.offset + 50, memberPage.total) }} / {{ memberPage.total }}</span>
        <button type="button" :disabled="busy || memberPage.nextCursor === null" @click="emit('member-page', memberPage.nextCursor ?? 0)">{{ rt('Next members') }}</button>
      </nav>

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

      <nav v-if="taskPage && taskPage.total > 50" class="runtime-pagination" :aria-label='rt("Task pages")'>
        <button type="button" :disabled="busy || taskPage.offset === 0" @click="emit('task-page', Math.max(0, taskPage.offset - 50))">{{ rt("Previous tasks") }}</button>
        <span>{{ taskPage.offset + 1 }}–{{ Math.min(taskPage.offset + 50, taskPage.total) }} / {{ taskPage.total }}</span>
        <button type="button" :disabled="busy || taskPage.nextCursor === null" @click="emit('task-page', taskPage.nextCursor ?? 0)">{{ rt("Next tasks") }}</button>
      </nav>

      <nav v-if="selectedTask && attemptPage && attemptPage.total > 50" class="runtime-pagination" :aria-label='rt("Attempt pages")'>
        <button type="button" :disabled="busy || attemptPage.offset === 0" @click="emit('attempt-page', Math.max(0, attemptPage.offset - 50))">{{ rt("Previous attempts") }}</button>
        <span>{{ attemptPage.offset + 1 }}–{{ Math.min(attemptPage.offset + 50, attemptPage.total) }} / {{ attemptPage.total }}</span>
        <button type="button" :disabled="busy || attemptPage.nextCursor === null" @click="emit('attempt-page', attemptPage.nextCursor ?? 0)">{{ rt("Next attempts") }}</button>
      </nav>

      <AttemptDetails
        v-if="selectedTask"
        :task="selectedTask"
        :attempts="attempts"
        :busy="busy"
        :can-capture="writer !== null"
        @capture-deliverable="emit('capture-deliverable', $event)"
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
        :artifact-status="artifactStatus"
        :artifact-workflow="artifactWorkflow"
        @artifact-action="emit('artifact-action', $event)"
        @apply-artifact="emit('apply-artifact', $event)"
        @allocate-writer="emit('allocate-writer', $event)"
        @writer-recovery="emit('writer-recovery', $event)"
        @approve="emit('approve', $event)"
      />
    </div>
  </dialog>
</template>

<script setup lang="ts">
import { useRuntimeUi } from '../../locales/runtimeUi';
const { rt } = useRuntimeUi();
import { ref, watch } from 'vue';
import { Icon } from '@iconify/vue';
import type { SessionRef } from '../../../shared/runtime/identity.js';
import type { ArtifactAction, ArtifactWorkflowView } from '../../runtime/hostArtifactViews';
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
import Dropdown from '../Dropdown.vue';
import DropdownItem from '../Dropdown/Item.vue';

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
  fanouts?: readonly CollaborationFanoutView[];
  fanoutPage?: { offset: number; total: number; nextCursor: number | null };
  fanoutAction?: (action: import('../../runtime/hostCollaborationViews').FanoutAction) => Promise<void>;
  writer: CollaborationWriterView | null;
  busy?: boolean;
  error?: string;
  availableMembers?: readonly { participantId: string; session: SessionRef; harnessKind: string }[];
  artifactStatus?: string;
  artifactWorkflow?: ArtifactWorkflowView;
  taskPage?: { offset: number; total: number; nextCursor: number | null };
  attemptPage?: { offset: number; total: number; nextCursor: number | null };
  memberPage?: { offset: number; total: number; nextCursor: number | null };
}>();

const emit = defineEmits<{
  (event: 'fanout-page', offset: number): void;
  (event: 'select-fanout', fanoutId: string): void;
  (event: 'member-page', offset: number): void;
  (event: 'task-page', offset: number): void;
  (event: 'attempt-page', offset: number): void;
  (event: 'artifact-action', input: ArtifactAction): void;
  (event: 'capture-deliverable', taskId: string): void;
  (event: 'apply-artifact', input: { taskId: string; artifactHash: string; target: string; dryRun: boolean }): void;
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
  (event: 'writer-recovery', input: { leaseId: string; action: 'reconcile' | 'create-missing' | 'reconnect' }): void;
  (event: 'approve', input: { taskId: string; reviewerId: string }): void;
}>();

function selectFanout(value: unknown): void { if (typeof value === 'string') emit('select-fanout', value); }
function fanoutLabel(entry: CollaborationFanoutView): string {
  const created = entry.createdAt ? new Date(entry.createdAt).toLocaleString() : shortId(entry.fanoutId);
  return `${rt(entry.state)} · ${entry.recipientCount ?? entry.targets.length} · ${created}${entry.promptPreview ? ` · ${entry.promptPreview.slice(0, 64)}` : ''}`;
}

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
.runtime-pagination {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}

.runtime-pagination button {
  padding: 4px 8px;
  min-height: 28px;
  border: 1px solid var(--ui-form-button-border);
  border-radius: var(--radius-control);
  background: var(--ui-form-button-bg);
  color: var(--ui-form-button-text);
}

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
  color: var(--codex-status-danger, var(--theme-text-primary));
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

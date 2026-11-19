<template>
  <section class="artifact-review" data-runtime-ui data-testid="artifact-review" :data-task-id="task.taskId" :aria-label='rt("Change review")'>
    <div class="section-title">{{ rt("Change review") }}</div>

    <div v-if="writer" class="writer-block" data-testid="writer-block">
      <div class="section-title">{{ rt("Writer path & resources") }}</div>
      <dl class="writer-grid">
        <dt>{{ rt("Writer status") }}</dt>
        <dd data-testid="writer-state">{{ rt(writer.state ?? 'Status unavailable') }}</dd>
        <template v-if="writer.binding">
          <dt>{{ rt("Agent session") }}</dt>
          <dd data-testid="writer-binding">{{ rt(writer.binding.phase) }}<span v-if="writer.binding.lastError"> · {{ writer.binding.lastError }}</span></dd>
        </template>
        <dt>{{ rt("Worktree") }}</dt>
        <dd class="mono" data-testid="writer-worktree" :title="writer.worktree">{{ writer.worktree }}</dd>
        <dt>{{ rt("Native cwd") }}</dt>
        <dd class="mono" data-testid="writer-native-cwd" :title="writer.nativeCwd">{{ writer.nativeCwd }}</dd>
        <dt>{{ rt("Base commit") }}</dt>
        <dd class="mono" data-testid="writer-base-commit" :title="writer.baseCommit">{{ shortId(writer.baseCommit) }}</dd>
        <dt>{{ rt("Worktree access") }}</dt>
        <dd data-testid="writer-worktree-access">{{ rt(writer.policy.worktreeAccess) }}</dd>
        <dt>{{ rt("User repository") }}</dt>
        <dd data-testid="writer-user-repository">{{ rt(writer.policy.userRepository) }}</dd>
      </dl>
      <div v-if="writer.state === 'allocating' || writer.state === 'reconciling'" class="writer-allocation">
        <p class="approve-note">{{ rt("Writer allocation was interrupted. Verify the existing worktree, or explicitly create it if missing. Recovery never resends an Agent turn.") }}</p>
        <button class="action-button" type="button" :disabled="busy" @click="emit('writer-recovery', { leaseId: writer.leaseId, action: 'reconcile' })">{{ rt("Verify and recover worktree") }}</button>
        <label><input v-model="createMissingConfirmed" type="checkbox" :disabled="busy" />{{ rt("Allow creating the missing worktree at the recorded base commit.") }}</label>
        <button class="action-button" type="button" :disabled="busy || !createMissingConfirmed" @click="emit('writer-recovery', { leaseId: writer.leaseId, action: 'create-missing' })">{{ rt("Create missing worktree") }}</button>
      </div>
      <button v-if="writer.binding?.phase === 'reconciling'" class="action-button" type="button" :disabled="busy" @click="emit('writer-recovery', { leaseId: writer.leaseId, action: 'reconnect' })">{{ rt("Reconnect existing Agent session") }}</button>
    </div>
    <p v-else class="empty-note" data-testid="writer-idle">{{ rt("No writer lease allocated for this task yet.") }}</p>

    <form v-if="!writer" class="writer-allocation" @submit.prevent="allocateWriter">
      <label class="repository-field">
        <span>{{ rt("Repository path") }}</span>
        <input v-model="repository" type="text" :disabled="busy" required autocomplete="off" />
      </label>
      <button class="action-button" type="submit" data-testid="allocate-writer" :disabled="busy || !repository.trim()">{{ rt("Allocate writer") }}</button>
    </form>

    <div v-if="writer" class="posture-block" data-testid="posture-block" :data-sandbox="String(postureSandbox(writer.posture))">
      <div class="section-title">{{ rt("Writer isolation posture") }}</div>
      <p class="posture-sandbox" data-testid="posture-sandbox">
        {{ rt("sandbox:") }} <strong data-testid="posture-sandbox-value">{{ postureSandbox(writer.posture) ? 'true' : 'false' }}</strong>
      </p>
      <p class="posture-mechanism" data-testid="posture-mechanism">{{ postureString(writer.posture, 'mechanism') }}</p>
      <ul class="posture-guarantees" data-testid="posture-guarantees">
        <li v-for="(entry, index) in postureList(writer.posture, 'guarantees')" :key="index">{{ rt(entry) }}</li>
      </ul>
      <p class="posture-not-provided-label">{{ rt("Not provided:") }}</p>
      <ul class="posture-not-provided" data-testid="posture-not-provided">
        <li v-for="(entry, index) in postureList(writer.posture, 'notProvided')" :key="index">{{ rt(entry) }}</li>
      </ul>
      <p class="posture-statement" data-testid="posture-statement">{{ postureString(writer.posture, 'reviewerStatement') }}</p>
    </div>

    <div class="approve-block">
      <button
        type="button"
        class="action-button approve-button"
        data-testid="approve-integration"
        :disabled="busy || task.phase !== 'review-pending'"
        @click="emit('approve', { taskId: task.taskId, reviewerId: 'reviewer' })"
      >
        {{ rt("Approve review") }}
      </button>
      <p class="approve-note" data-testid="approve-note">
        {{ rt("Approval records the review verdict. Check the captured artifact against the target repository, then explicitly apply the reviewed change. Nothing is pushed automatically.") }}
      </p>
    </div>

    <ArtifactIntegration v-if="task.deliverables.length" :task="task" :workflow="artifactWorkflow" :busy="busy" @action="emit('artifact-action', $event)" />
    <p v-if="artifactStatus" role="status" class="approve-note">{{ rt(artifactStatus) }}</p>
  </section>
</template>

<script setup lang="ts">
import { useRuntimeUi } from '../../locales/runtimeUi';
const { rt } = useRuntimeUi();
import { ref, watch } from 'vue';
import ArtifactIntegration from './ArtifactIntegration.vue';
import type { ArtifactAction, ArtifactWorkflowView } from '../../runtime/hostArtifactViews';
import type { CollaborationTaskView, CollaborationWriterView } from '../../composables/useRuntimeCollaboration';

const props = defineProps<{
  task: CollaborationTaskView;
  writer: CollaborationWriterView | null;
  busy?: boolean;
  artifactStatus?: string;
  artifactWorkflow?: ArtifactWorkflowView;
}>();

const repository = ref('');
const createMissingConfirmed = ref(false);
watch(() => props.task.taskId, () => { repository.value = ''; createMissingConfirmed.value = false; });
watch(() => props.writer?.leaseId, () => { createMissingConfirmed.value = false; });

function allocateWriter(): void {
  if (props.busy || props.writer || repository.value.trim().length === 0) return;
  emit('allocate-writer', { taskId: props.task.taskId, repository: repository.value.trim() });
}

const emit = defineEmits<{
  (event: 'writer-recovery', input: { leaseId: string; action: 'reconcile' | 'create-missing' | 'reconnect' }): void;
  (event: 'artifact-action', input: ArtifactAction): void;
  (event: 'apply-artifact', input: { taskId: string; artifactHash: string; target: string; dryRun: boolean }): void;
  (event: 'allocate-writer', input: { taskId: string; repository: string }): void;
  (event: 'approve', input: { taskId: string; reviewerId: string }): void;
}>();

/** The posture's `sandbox` claim, read from the port's OWN object — never assumed or fabricated. */
function postureSandbox(posture: Readonly<Record<string, unknown>>): boolean {
  return posture.sandbox === true;
}

function postureString(posture: Readonly<Record<string, unknown>>, key: string): string {
  const value = posture[key];
  return typeof value === 'string' ? rt(value) : '';
}

function postureList(posture: Readonly<Record<string, unknown>>, key: string): string[] {
  const value = posture[key];
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}

function shortId(value: string): string {
  return value.length > 16 ? `${value.slice(0, 16)}…` : value;
}
</script>

<style scoped>
.writer-allocation,
.repository-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.repository-field {
  font-size: var(--type-sm);
  color: var(--theme-text-primary);
}

.repository-field input {
  border: 1px solid var(--ui-form-control-border);
  border-radius: var(--radius-control);
  min-height: 28px;
  padding: 4px 8px;
}

.artifact-review {
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

.writer-grid {
  display: grid;
  grid-template-columns: max-content 1fr;
  gap: 4px 12px;
  margin: 0;
  font-size: var(--type-caption, 10px);
}

.writer-grid dt {
  color: var(--theme-text-muted, #94a3b8);
}

.writer-grid dd {
  margin: 0;
  color: var(--theme-text-primary, #e2e8f0);
  word-break: break-all;
}

.posture-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--theme-border-default, #334155);
  border-radius: var(--radius-control, 8px);
  background: var(--theme-surface-panel-muted, rgba(15, 23, 42, 0.72));
}

.posture-sandbox {
  margin: 0;
  font-size: var(--type-sm, 12px);
  color: var(--theme-text-primary, #e2e8f0);
}

.posture-sandbox strong {
  color: var(--codex-status-success, var(--theme-text-primary));
}

.posture-mechanism,
.posture-statement {
  margin: 0;
  font-size: var(--type-caption, 10px);
  line-height: 1.45;
  color: var(--theme-text-muted, #94a3b8);
}

.posture-guarantees,
.posture-not-provided {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding-inline-start: 18px;
  font-size: var(--type-caption, 10px);
  line-height: 1.4;
  color: var(--theme-text-primary, #e2e8f0);
}

.posture-not-provided-label {
  margin: 4px 0 0;
  font-size: var(--type-caption, 10px);
  color: var(--theme-text-muted, #94a3b8);
}

.approve-block {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.approve-button {
  border-color: color-mix(in srgb, var(--theme-status-success, #4ade80) 55%, transparent);
  color: var(--codex-status-success, var(--theme-text-primary));
}

.approve-note {
  margin: 0;
  font-size: var(--type-caption, 10px);
  color: var(--theme-text-muted, #94a3b8);
}

.empty-note {
  margin: 0;
  font-size: var(--type-caption, 10px);
  color: var(--theme-text-muted, #94a3b8);
}

.action-button {
  padding: 5px 12px;
  border: 1px solid var(--theme-form-control-border, var(--theme-border-default, #334155));
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

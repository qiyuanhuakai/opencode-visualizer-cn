<template>
  <!--
    The change review: the writer's OBSERVED path and resources, the writer's OWN frozen posture
    (task 40's WRITER_ISOLATION, `sandbox: false`), and the EXPLICIT review approve. There is no
    auto-push default and no fabricated read-only capability: the posture is the port's object
    surfaced verbatim, and the only forward action is the user-invoked approve below. The approve
    records the task's REVIEW verdict — applying the reviewed change to the repository is not
    wired into this surface yet, and the note says so rather than implying an apply happened.
  -->
  <section class="artifact-review" data-testid="artifact-review" :data-task-id="task.taskId" aria-label="Change review">
    <div class="section-title">Change review</div>

    <div v-if="writer" class="writer-block" data-testid="writer-block">
      <div class="section-title">Writer path &amp; resources</div>
      <dl class="writer-grid">
        <dt>Worktree</dt>
        <dd class="mono" data-testid="writer-worktree" :title="writer.worktree">{{ writer.worktree }}</dd>
        <dt>Native cwd</dt>
        <dd class="mono" data-testid="writer-native-cwd" :title="writer.nativeCwd">{{ writer.nativeCwd }}</dd>
        <dt>Base commit</dt>
        <dd class="mono" data-testid="writer-base-commit" :title="writer.baseCommit">{{ shortId(writer.baseCommit) }}</dd>
        <dt>Worktree access</dt>
        <dd data-testid="writer-worktree-access">{{ writer.policy.worktreeAccess }}</dd>
        <dt>User repository</dt>
        <dd data-testid="writer-user-repository">{{ writer.policy.userRepository }}</dd>
      </dl>
    </div>
    <p v-else class="empty-note" data-testid="writer-idle">No writer lease allocated for this task yet.</p>

    <div v-if="writer" class="posture-block" data-testid="posture-block" :data-sandbox="String(postureSandbox(writer.posture))">
      <div class="section-title">Writer isolation posture</div>
      <p class="posture-sandbox" data-testid="posture-sandbox">
        sandbox: <strong data-testid="posture-sandbox-value">{{ postureSandbox(writer.posture) ? 'true' : 'false' }}</strong>
      </p>
      <p class="posture-mechanism" data-testid="posture-mechanism">{{ postureString(writer.posture, 'mechanism') }}</p>
      <ul class="posture-guarantees" data-testid="posture-guarantees">
        <li v-for="(entry, index) in postureList(writer.posture, 'guarantees')" :key="index">{{ entry }}</li>
      </ul>
      <p class="posture-not-provided-label">Not provided:</p>
      <ul class="posture-not-provided" data-testid="posture-not-provided">
        <li v-for="(entry, index) in postureList(writer.posture, 'notProvided')" :key="index">{{ entry }}</li>
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
        Approve review
      </button>
      <p class="approve-note" data-testid="approve-note">
        Approval records the review verdict on this task only. Applying the reviewed change to the repository is not wired into this surface yet. Nothing is pushed automatically.
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { CollaborationTaskView, CollaborationWriterView } from '../../composables/useRuntimeCollaboration';

defineProps<{
  task: CollaborationTaskView;
  writer: CollaborationWriterView | null;
  busy?: boolean;
}>();

const emit = defineEmits<{
  (event: 'allocate-writer', input: { taskId: string; repository: string }): void;
  (event: 'approve', input: { taskId: string; reviewerId: string }): void;
}>();

/** The posture's `sandbox` claim, read from the port's OWN object — never assumed or fabricated. */
function postureSandbox(posture: Readonly<Record<string, unknown>>): boolean {
  return posture.sandbox === true;
}

function postureString(posture: Readonly<Record<string, unknown>>, key: string): string {
  const value = posture[key];
  return typeof value === 'string' ? value : '';
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
  color: var(--theme-status-success, #4ade80);
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
  color: var(--theme-status-success, #4ade80);
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

<template>
  <!--
    Team members (harness / role), the concurrency budget, and the fan-out targets with their
    PARTIAL outcome. The fan-out state is the OBSERVED per-recipient result the service derives —
    the panel renders it verbatim and never claims a recipient succeeded when the service said
    `failed` or `ambiguous`.
  -->
  <section class="team-editor" data-runtime-ui data-testid="team-editor" :aria-label='rt("Team")'>
    <div class="section-title">{{ rt("Team members") }}</div>
    <ul v-if="team && team.members.length > 0" class="member-list">
      <li
        v-for="member in team.members"
        :key="member.memberId"
        class="member-row"
        data-testid="member-row"
        :data-member-id="member.memberId"
        :data-role="member.role"
        :data-harness="member.harnessKind"
      >
        <span class="member-role" :class="{ 'is-lead': member.role === 'lead' }">{{ rt(member.role) }}</span>
        <span class="member-harness">{{ member.harnessKind }}</span>
        <span class="member-session mono" :title="member.session.nativeSessionId">{{ shortId(member.session.nativeSessionId) }}</span>
      </li>
    </ul>
    <p v-else class="empty-note" data-testid="team-empty">{{ rt("No members yet.") }}</p>

    <form v-if="team && candidates.length" class="member-create" @submit.prevent="addMember">
      <Dropdown v-model="selectedMember" :label="selectedCandidate ? `${selectedCandidate.harnessKind} · ${selectedCandidate.session.nativeSessionId}` : t('member')" :aria-label="t('member')" :placeholder="t('member')" auto-close :disabled="busy">
        <DropdownItem v-for="candidate in candidates" :key="candidate.participantId" :value="candidate.participantId">
          {{ candidate.harnessKind }} · {{ candidate.session.nativeSessionId }}
        </DropdownItem>
      </Dropdown>
      <Dropdown v-model="memberRole" :label="t(memberRole === 'lead' ? 'lead' : 'worker')" :aria-label="t('role')" auto-close :disabled="busy">
        <DropdownItem value="worker">{{ t('worker') }}</DropdownItem>
        <DropdownItem value="lead">{{ t('lead') }}</DropdownItem>
      </Dropdown>
      <button class="action-button" type="submit" data-testid="add-team-member" :disabled="busy || !selectedCandidate">{{ t('addMember') }}</button>
    </form>

    <form v-if="team" class="task-create" @submit.prevent="createTask">
      <label class="task-field">
        <span>{{ t('taskTitle') }}</span>
        <input v-model="taskTitle" class="fanout-prompt" :disabled="busy" required />
      </label>
      <label class="task-field">
        <span>{{ t('criteria') }}</span>
        <textarea v-model="taskCriteria" class="fanout-prompt" rows="3" :disabled="busy" required />
      </label>
      <button type="submit" class="action-button" data-testid="create-task" :disabled="busy || !canCreateTask">{{ t('createTask') }}</button>
    </form>

    <div v-if="budgets" class="budget-block" data-testid="budget-block">
      <div class="section-title">{{ rt("Concurrency budget") }}</div>
      <ul class="budget-list">
        <li
          v-for="(limit, key) in budgets.limits"
          :key="key"
          class="budget-row"
          data-testid="budget-row"
          :data-budget-key="key"
        >
          <span class="budget-key">{{ budgetLabel(key) }}</span>
          <span class="budget-used">{{ budgets.used[usedKeyFor(key)] ?? 0 }} / {{ limit }}</span>
        </li>
      </ul>
    </div>

    <div class="fanout-block" data-testid="fanout-block">
      <div class="section-title">{{ rt("Fan-out") }}</div>
      <fieldset :disabled="busy" class="fanout-recipients">
        <legend>{{ rt('Choose recipients from this member page') }}</legend>
        <label v-for="member in team?.members ?? []" :key="member.memberId">
          <input v-model="selectedRecipients" type="checkbox" :value="member.participantId" data-testid="fanout-select-recipient" />
          {{ member.harnessKind }} · {{ member.session.nativeSessionId }}
        </label>
      </fieldset>
      <div class="fanout-controls">
        <input
          v-model="prompt"
          class="fanout-prompt"
          type="text"
          :placeholder="rt('Prompt for selected recipients')"
          data-testid="fanout-prompt"
          :disabled="busy || !hasMembers"
        />
        <button
          type="button"
          class="action-button"
          data-testid="fanout-trigger"
          :disabled="busy || selectedRecipients.length === 0 || prompt.trim().length === 0"
          @click="handleFanOut"
        >
          {{ rt("Fan out") }}
        </button>
      </div>

      <div v-if="fanout" class="fanout-result" data-testid="fanout-result">
        <p class="fanout-state" data-testid="fanout-state" :data-state="fanout.state">
          {{ rt("Fan-out:") }} {{ rt(fanout.state) }}
        </p>
        <button v-if="fanoutAction && fanout.targets.some(target => target.outcome === 'pending')" type="button" class="action-button" :disabled="busy" @click="fanoutAction({ type: 'reconcile' })">{{ rt('Reconcile pending recipients') }}</button>
        <p class="fanout-stats mono" data-testid="fanout-stats">
          {{ rt("sent") }} {{ fanout.stats.sent ?? 0 }} {{ rt("· failed") }} {{ fanout.stats.failed ?? 0 }} {{ rt("· ambiguous") }}
          {{ fanout.stats.ambiguous ?? 0 }} {{ rt("· pending") }} {{ fanout.stats.pending ?? 0 }}
        </p>
        <ul class="fanout-recipients">
          <li
            v-for="target in fanout.targets"
            :key="target.recipientId"
            class="fanout-recipient"
            data-testid="fanout-recipient"
            :data-participant-id="target.participantId"
            :data-outcome="target.outcome"
          >
            <span class="recipient-id mono" :title="target.session.nativeSessionId">{{ recipientLabel(target) }}</span>
            <span class="recipient-outcome" :class="'is-' + target.outcome">{{ rt(target.outcome) }}</span>
            <span v-if="target.attachmentPath" class="recipient-attachment mono" :title="target.attachmentPath">{{ shortId(target.attachmentPath) }}</span>
            <span v-if="target.resolutionCode" class="recipient-resolution">{{ target.resolutionCode }}</span>
            <button v-if="fanoutAction && ['pending', 'sent'].includes(target.outcome)" type="button" class="action-button" :disabled="busy" @click="fanoutAction({ type: 'cancel', recipientId: target.recipientId })">{{ rt('Cancel recipient') }}</button>
            <button v-if="fanoutAction && fanout.retryable.includes(target.recipientId)" type="button" class="action-button" :disabled="busy" @click="fanoutAction({ type: 'retry', recipientId: target.recipientId })">{{ rt('Retry safe recipient') }}</button>
          </li>
        </ul>
      </div>
      <p v-else class="empty-note" data-testid="fanout-idle">{{ rt("No fan-out dispatched yet.") }}</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { useRuntimeUi } from '../../locales/runtimeUi';
import Dropdown from '../Dropdown.vue';
import DropdownItem from '../Dropdown/Item.vue';
import type { SessionRef } from '../../../shared/runtime/identity.js';
import type { CollaborationBudgetView, CollaborationFanoutView, CollaborationTeamView, CollaborationRecipientView } from '../../composables/useRuntimeCollaboration';

const props = defineProps<{
  team: CollaborationTeamView | null;
  budgets: CollaborationBudgetView | null;
  fanout: CollaborationFanoutView | null;
  fanoutAction?: (action: import('../../runtime/hostCollaborationViews').FanoutAction) => Promise<void>;
  busy?: boolean;
  availableMembers?: readonly { participantId: string; session: SessionRef; harnessKind: string }[];
}>();

const emit = defineEmits<{
  (event: 'add-member', input: { role: 'lead' | 'worker'; harnessKind: string; session: SessionRef; participantId: string }): void;
  (event: 'create-task', input: { title: string; criteria: readonly { id: string; text: string; required?: boolean }[] }): void;
  (event: 'fan-out', input: { prompt: string; targets: readonly { participantId: string; session: SessionRef; attachmentPath?: string }[] }): void;
}>();

const { t, rt } = useRuntimeUi();
const prompt = ref('');
const selectedRecipients = ref<string[]>([]);
watch(() => props.team?.members.map((member) => member.memberId).join('|'), () => { selectedRecipients.value = []; });
const selectedMember = ref<string>();
const memberRole = ref('worker');
const candidates = computed(() => (props.availableMembers ?? []).filter((candidate) =>
  !props.team?.members.some((member) => member.participantId === candidate.participantId)));
const selectedCandidate = computed(() => candidates.value.find((candidate) => candidate.participantId === selectedMember.value));

function addMember(): void {
  const candidate = selectedCandidate.value;
  if (!candidate || props.busy || (memberRole.value !== 'lead' && memberRole.value !== 'worker')) return;
  emit('add-member', { ...candidate, role: memberRole.value });
  selectedMember.value = undefined;
}
const taskTitle = ref('');
const taskCriteria = ref('');
const criterionLines = computed(() => taskCriteria.value.split('\n').map((line) => line.trim()).filter(Boolean));
const canCreateTask = computed(() => taskTitle.value.trim().length > 0 && criterionLines.value.length > 0);
const hasMembers = computed(() => (props.team?.members.length ?? 0) > 0);

function createTask(): void {
  if (props.busy || !props.team || !canCreateTask.value) return;
  emit('create-task', {
    title: taskTitle.value.trim(),
    criteria: criterionLines.value.map((text) => ({ id: crypto.randomUUID(), text, required: true })),
  });
  taskTitle.value = '';
  taskCriteria.value = '';
}

/**
 * The explicit limit-key → used-key map. The coordinator's budgets() reports the LIMITS as
 * `maxConcurrency` / `maxSessionMutations` / `maxDepth` / `maxChildren` / `maxMailbox` and the
 * observed USE as `concurrency` / `sessionMutations` / `depth` / `children` / `mailbox` — the two
 * read models deliberately do not share key names, so indexing `used` with a limit key silently
 * rendered 0 for every row. The mapping is spelled out here rather than derived by string
 * surgery, so a renamed budget is a compile-visible decision.
 */
const USED_KEY_FOR_LIMIT: Readonly<Record<string, string>> = Object.freeze({
  maxConcurrency: 'concurrency',
  maxSessionMutations: 'sessionMutations',
  maxDepth: 'depth',
  maxChildren: 'children',
  maxMailbox: 'mailbox',
});

function usedKeyFor(limitKey: string): string {
  return USED_KEY_FOR_LIMIT[limitKey] ?? limitKey;
}
function budgetLabel(key: string): string {
  switch (key) {
    case 'maxConcurrency': return rt('Concurrent tasks');
    case 'maxSessionMutations': return rt('Per-session actions');
    case 'maxDepth': return rt('Delegation depth');
    case 'maxChildren': return rt('Child tasks');
    case 'maxMailbox': return rt('Mailbox messages');
    default: return key;
  }
}

function handleFanOut(): void {
  const members = (props.team?.members ?? []).filter((member) => selectedRecipients.value.includes(member.participantId));
  if (props.busy || members.length === 0 || prompt.value.trim().length === 0) return;
  // Each recipient gets its OWN session; no attachment path is fabricated here — the container
  // supplies the real per-target attachment paths through the composable's fan-out port.
  emit('fan-out', {
    prompt: prompt.value,
    targets: members.map((member) => ({ participantId: member.participantId, session: member.session })),
  });
  prompt.value = '';
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}
function recipientLabel(target: CollaborationRecipientView): string {
  const member = props.team?.members.find(entry => entry.participantId === target.participantId);
  const source = member ? rt(member.harnessKind) : shortId(target.session.harnessInstanceId);
  return `${source} · ${shortId(target.session.nativeSessionId)}`;
}
</script>

<style scoped>
.task-create,
.member-create,
.task-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.task-field .fanout-prompt {
  flex: none;
  width: 100%;
  min-height: 28px;
  box-sizing: border-box;
}

.task-field textarea.fanout-prompt {
  min-height: 80px;
  resize: vertical;
}

.task-field {
  font-size: var(--type-sm);
  color: var(--theme-text-primary);
}

.team-editor {
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

.member-list,
.budget-list,
.fanout-recipients {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.member-row,
.budget-row,
.fanout-recipient {
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

.member-role {
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-weight: 600;
  color: var(--codex-status-info, var(--theme-text-primary));
}

.member-role.is-lead {
  color: var(--theme-accent-primary, #93c5fd);
}

.member-harness {
  color: var(--theme-text-primary, #e2e8f0);
}

.member-session {
  font-weight: 400;
  color: var(--theme-text-muted, #94a3b8);
}

.budget-key {
  color: var(--theme-text-muted, #94a3b8);
}

.budget-used {
  margin-left: auto;
  font-weight: 600;
  color: var(--theme-text-primary, #e2e8f0);
}

.fanout-controls {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}

.fanout-prompt {
  flex: 1 1 200px;
  min-width: 0;
  padding: 5px 8px;
  border: 1px solid var(--theme-form-control-border, var(--theme-border-default, #334155));
  border-radius: var(--radius-control, 8px);
  background: var(--theme-form-control-bg, var(--theme-surface-panel-muted, rgba(15, 23, 42, 0.72)));
  color: var(--theme-form-control-text, var(--theme-text-primary, #e2e8f0));
  font-family: inherit;
  font-size: var(--type-sm, 12px);
}

.fanout-state {
  margin: 0;
  font-size: var(--type-sm, 12px);
  font-weight: 600;
  color: var(--theme-text-primary, #e2e8f0);
}

.fanout-state[data-state='partial'] {
  color: var(--codex-status-warning, var(--theme-text-primary));
}

.fanout-state[data-state='failed'] {
  color: var(--codex-status-danger, var(--theme-text-primary));
}

.fanout-state[data-state='succeeded'] {
  color: var(--codex-status-success, var(--theme-text-primary));
}

.fanout-stats {
  margin: 0;
  font-size: var(--type-caption, 10px);
  color: var(--theme-text-muted, #94a3b8);
}

.recipient-outcome {
  font-weight: 600;
}

.recipient-outcome.is-sent {
  color: var(--codex-status-success, var(--theme-text-primary));
}

.recipient-outcome.is-failed {
  color: var(--codex-status-danger, var(--theme-text-primary));
}

.recipient-outcome.is-ambiguous {
  color: var(--codex-status-warning, var(--theme-text-primary));
}

.recipient-outcome.is-cancelled,
.recipient-outcome.is-pending {
  color: var(--theme-text-muted, #94a3b8);
}

.recipient-attachment {
  color: var(--theme-text-muted, #94a3b8);
}

.recipient-resolution {
  color: var(--codex-status-danger, var(--theme-text-primary));
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

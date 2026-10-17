<template>
  <!--
    Team members (harness / role), the concurrency budget, and the fan-out targets with their
    PARTIAL outcome. The fan-out state is the OBSERVED per-recipient result the service derives —
    the panel renders it verbatim and never claims a recipient succeeded when the service said
    `failed` or `ambiguous`.
  -->
  <section class="team-editor" data-testid="team-editor" aria-label="Team">
    <div class="section-title">Team members</div>
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
        <span class="member-role" :class="{ 'is-lead': member.role === 'lead' }">{{ member.role }}</span>
        <span class="member-harness">{{ member.harnessKind }}</span>
        <span class="member-session mono" :title="member.session.nativeSessionId">{{ shortId(member.session.nativeSessionId) }}</span>
      </li>
    </ul>
    <p v-else class="empty-note" data-testid="team-empty">No members yet.</p>

    <div v-if="budgets" class="budget-block" data-testid="budget-block">
      <div class="section-title">Concurrency budget</div>
      <ul class="budget-list">
        <li
          v-for="(limit, key) in budgets.limits"
          :key="key"
          class="budget-row"
          data-testid="budget-row"
          :data-budget-key="key"
        >
          <span class="budget-key">{{ key }}</span>
          <span class="budget-used">{{ budgets.used[key] ?? 0 }} / {{ limit }}</span>
        </li>
      </ul>
    </div>

    <div class="fanout-block" data-testid="fanout-block">
      <div class="section-title">Fan-out</div>
      <div class="fanout-controls">
        <input
          v-model="prompt"
          class="fanout-prompt"
          type="text"
          placeholder="Prompt to fan out to every member"
          data-testid="fanout-prompt"
          :disabled="busy || !hasMembers"
        />
        <button
          type="button"
          class="action-button"
          data-testid="fanout-trigger"
          :disabled="busy || !hasMembers || prompt.trim().length === 0"
          @click="handleFanOut"
        >
          Fan out
        </button>
      </div>

      <div v-if="fanout" class="fanout-result" data-testid="fanout-result">
        <p class="fanout-state" data-testid="fanout-state" :data-state="fanout.state">
          Fan-out: {{ fanout.state }}
        </p>
        <p class="fanout-stats mono" data-testid="fanout-stats">
          sent {{ fanout.stats.sent ?? 0 }} · failed {{ fanout.stats.failed ?? 0 }} · ambiguous
          {{ fanout.stats.ambiguous ?? 0 }} · pending {{ fanout.stats.pending ?? 0 }}
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
            <span class="recipient-id mono">{{ shortId(target.participantId) }}</span>
            <span class="recipient-outcome" :class="'is-' + target.outcome">{{ target.outcome }}</span>
            <span v-if="target.attachmentPath" class="recipient-attachment mono" :title="target.attachmentPath">{{ shortId(target.attachmentPath) }}</span>
            <span v-if="target.resolutionCode" class="recipient-resolution">{{ target.resolutionCode }}</span>
          </li>
        </ul>
      </div>
      <p v-else class="empty-note" data-testid="fanout-idle">No fan-out dispatched yet.</p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { SessionRef } from '../../../shared/runtime/identity.js';
import type { CollaborationBudgetView, CollaborationFanoutView, CollaborationTeamView } from '../../composables/useRuntimeCollaboration';

const props = defineProps<{
  team: CollaborationTeamView | null;
  budgets: CollaborationBudgetView | null;
  fanout: CollaborationFanoutView | null;
  busy?: boolean;
}>();

const emit = defineEmits<{
  (event: 'add-member', input: { role: 'lead' | 'worker'; harnessKind: string; session: SessionRef; participantId: string }): void;
  (event: 'create-task', input: { title: string; criteria: readonly { id: string; text: string; required?: boolean }[] }): void;
  (event: 'fan-out', input: { prompt: string; targets: readonly { participantId: string; session: SessionRef; attachmentPath?: string }[] }): void;
}>();

const prompt = ref('');
const hasMembers = computed(() => (props.team?.members.length ?? 0) > 0);

function handleFanOut(): void {
  const members = props.team?.members ?? [];
  if (members.length === 0 || prompt.value.trim().length === 0) return;
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
</script>

<style scoped>
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
  color: var(--theme-status-info, #7dd3fc);
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
  border: 1px solid var(--theme-input-border, var(--theme-border-default, #334155));
  border-radius: var(--radius-control, 8px);
  background: var(--theme-input-bg, var(--theme-surface-panel-muted, rgba(15, 23, 42, 0.72)));
  color: var(--theme-input-text, var(--theme-text-primary, #e2e8f0));
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
  color: var(--theme-status-warning, #fcd34d);
}

.fanout-state[data-state='failed'] {
  color: var(--theme-status-error, #f87171);
}

.fanout-state[data-state='succeeded'] {
  color: var(--theme-status-success, #4ade80);
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
  color: var(--theme-status-success, #4ade80);
}

.recipient-outcome.is-failed {
  color: var(--theme-status-error, #f87171);
}

.recipient-outcome.is-ambiguous {
  color: var(--theme-status-warning, #fcd34d);
}

.recipient-outcome.is-cancelled,
.recipient-outcome.is-pending {
  color: var(--theme-text-muted, #94a3b8);
}

.recipient-attachment {
  color: var(--theme-text-muted, #94a3b8);
}

.recipient-resolution {
  color: var(--theme-status-error, #f87171);
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

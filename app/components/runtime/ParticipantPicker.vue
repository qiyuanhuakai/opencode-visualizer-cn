<template>
  <section class="participant-picker" data-testid="participant-picker" :aria-label="'Thread participants'">
    <header class="picker-header">
      <span class="section-title">Participants</span>
      <span class="picker-count" data-testid="participant-count">{{ participants.length }}</span>
    </header>

    <p v-if="participants.length === 0" class="picker-empty" data-testid="participant-empty">
      This thread has no participants yet.
    </p>

    <ul v-else class="participant-list" role="group" aria-label="Thread participants">
      <li
        v-for="participant in participants"
        :key="participant.participantId"
        class="participant-row"
        :class="{ 'is-target': isTarget(participant.participantId), 'is-active': participant.participantId === activeParticipantId }"
        :data-testid="'participant-row'"
        :data-participant-id="participant.participantId"
        :data-role="participant.role"
        :data-state="participant.state"
        :data-target="String(isTarget(participant.participantId))"
      >
        <div class="participant-identity">
          <span class="participant-role">{{ participant.role }}</span>
          <span class="participant-state" :data-state="participant.state" data-testid="participant-state">
            {{ participant.state }}
          </span>
          <span v-if="participant.participantId === activeParticipantId" class="participant-active" data-testid="participant-active">
            active
          </span>
          <span v-if="participant.nativeParent" class="participant-parent mono" :title="participant.nativeParent.nativeSessionId">
            native parent: {{ shortId(participant.nativeParent.nativeSessionId) }}
          </span>
        </div>
        <div class="participant-session mono" data-testid="participant-session" :title="participant.session.nativeSessionId">
          {{ harnessLabel(participant.harnessInstanceId) }} · {{ shortId(participant.session.nativeSessionId) }}
        </div>
        <div class="participant-actions">
          <button
            type="button"
            class="action-button"
            :class="{ active: isTarget(participant.participantId) }"
            :disabled="busy || participant.state !== 'active'"
            :title="isTarget(participant.participantId) ? 'This participant receives the input' : 'Send the input to this participant'"
            :data-testid="'set-target'"
            :data-participant-id="participant.participantId"
            :aria-pressed="isTarget(participant.participantId)"
            @click="emit('select-target', participant.participantId)"
          >
            {{ isTarget(participant.participantId) ? 'Input target' : 'Send here' }}
          </button>
          <button
            type="button"
            class="action-button"
            :disabled="busy || participant.participantId === activeParticipantId"
            :data-testid="'activate-participant'"
            :data-participant-id="participant.participantId"
            title="Make this participant the thread's active selection"
            @click="emit('activate', participant.participantId)"
          >
            Activate
          </button>
          <button
            v-if="participant.state !== 'active'"
            type="button"
            class="action-button"
            :disabled="busy"
            :data-testid="'resume-participant'"
            :data-participant-id="participant.participantId"
            :title="participant.state === 'orphaned' ? 'The native session vanished; resuming re-checks it' : 'Re-bind this participant'"
            @click="emit('resume', participant.participantId)"
          >
            Resume
          </button>
          <button
            type="button"
            class="action-button"
            :disabled="busy || participant.role === 'owner'"
            :title="participant.role === 'owner' ? 'The owner binds the thread origin and cannot leave' : 'Remove this participant; its native history is kept'"
            :data-testid="'leave-participant'"
            :data-participant-id="participant.participantId"
            @click="emit('leave', participant.participantId)"
          >
            Leave
          </button>
          <button
            type="button"
            class="action-button"
            :disabled="busy"
            title="Locate this participant's native session in the session tree"
            :data-testid="'locate-session'"
            :data-participant-id="participant.participantId"
            @click="emit('locate-session', participant.session)"
          >
            <Icon icon="lucide:locate-fixed" :width="13" :height="13" />
          </button>
        </div>
      </li>
    </ul>

    <div v-if="availableSessions.length > 0" class="available-sources">
      <div class="section-title">Add a source to this thread</div>
      <div class="available-list" role="group" aria-label="Available native sessions">
        <button
          v-for="entry in availableSessions"
          :key="threadBindingKey(entry.session)"
          type="button"
          class="action-button"
          :disabled="busy || joined(entry.session)"
          :title="joined(entry.session) ? 'Already a participant of this thread' : 'Join this native session to the thread'"
          :data-testid="'add-source'"
          :data-native-session-id="entry.session.nativeSessionId"
          @click="emit('join', entry.session)"
        >
          <Icon icon="lucide:plus" :width="13" :height="13" />
          <span class="available-label">{{ entry.label }}</span>
          <span class="available-harness">{{ entry.harness }}</span>
        </button>
      </div>
      <p class="available-hint">
        A participant keeps its own native history; joining never merges two sessions into one.
      </p>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { Icon } from '@iconify/vue';
import type { ParticipantView } from '../../../bridge/runtime/threads/participantService.js';
import type { SessionRef } from '../../../shared/runtime/identity.js';
import { threadBindingKey } from '../../../shared/runtime/thread.js';
import type { AvailableSession } from '../../composables/useRuntimeThread';

const props = withDefaults(
  defineProps<{
    participants: readonly ParticipantView[];
    /** Which participants the input goes to; empty means the active participant. */
    targets: readonly string[];
    activeParticipantId?: string | null;
    /** Native sessions the session tree offers; already-joined ones are shown disabled. */
    availableSessions?: readonly AvailableSession[];
    /** harnessInstanceId → display label, supplied by the container's harness registry. */
    harnessLabels?: Readonly<Record<string, string>>;
    busy?: boolean;
  }>(),
  { activeParticipantId: null, availableSessions: () => [], harnessLabels: () => ({}), busy: false },
);

const emit = defineEmits<{
  (event: 'select-target', participantId: string): void;
  (event: 'activate', participantId: string): void;
  (event: 'leave', participantId: string): void;
  (event: 'resume', participantId: string): void;
  (event: 'join', session: SessionRef): void;
  (event: 'locate-session', session: SessionRef): void;
}>();

const joinedKeys = computed(() => new Set(props.participants.map((participant) => threadBindingKey(participant.session))));

function isTarget(participantId: string): boolean {
  if (props.targets.length > 0) return props.targets.includes(participantId);
  return participantId === props.activeParticipantId;
}

function joined(session: SessionRef): boolean {
  return joinedKeys.value.has(threadBindingKey(session));
}

/**
 * The label the container's harness registry gives this instance. When the registry has no entry
 * the raw instance id is shown — the read model carries the id, and the UI never guesses a kind.
 */
function harnessLabel(harnessInstanceId: string): string {
  return props.harnessLabels[harnessInstanceId] ?? shortId(harnessInstanceId);
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}
</script>

<style scoped>
.participant-picker {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--theme-border-subtle, var(--theme-border-muted, rgba(148, 163, 184, 0.18)));
  border-radius: var(--radius-panel, 10px);
  background: var(--theme-card-bg, var(--theme-surface-panel, rgba(30, 41, 59, 0.35)));
}

.picker-header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.section-title {
  font-size: var(--type-caption, 10px);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--theme-text-muted, #94a3b8);
}

.picker-count {
  margin-left: auto;
  font-size: var(--type-caption, 10px);
  font-weight: 600;
  color: var(--theme-text-muted, #94a3b8);
}

.picker-empty {
  margin: 0;
  font-size: var(--type-sm, 12px);
  color: var(--theme-text-muted, #94a3b8);
}

.participant-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.participant-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--theme-border-default, #334155);
  border-radius: var(--radius-control, 8px);
  background: var(--theme-surface-panel-muted, rgba(15, 23, 42, 0.72));
}

.participant-row.is-active {
  border-color: color-mix(in srgb, var(--theme-accent-primary, #60a5fa) 55%, transparent);
}

.participant-row.is-target {
  border-color: var(--theme-accent-primary, #60a5fa);
  box-shadow: inset 2px 0 0 var(--theme-accent-primary, #60a5fa);
}

.participant-identity {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.participant-role {
  font-size: var(--type-sm, 12px);
  font-weight: 600;
  color: var(--theme-text-primary, #e2e8f0);
}

.participant-state {
  font-size: var(--type-caption, 10px);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--theme-border-default, #334155);
  color: var(--theme-text-muted, #94a3b8);
}

.participant-state[data-state='active'] {
  color: var(--theme-status-success, #86efac);
  border-color: color-mix(in srgb, var(--color-success-400, #22c55e) 60%, transparent);
}

.participant-state[data-state='left'] {
  color: var(--theme-status-warning, #fcd34d);
  border-color: color-mix(in srgb, var(--theme-status-warning, #fcd34d) 45%, transparent);
}

.participant-state[data-state='orphaned'] {
  color: var(--theme-status-error, #f87171);
  border-color: color-mix(in srgb, var(--theme-status-error, #f87171) 55%, transparent);
}

.participant-active {
  font-size: var(--type-caption, 10px);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--theme-accent-primary, #93c5fd);
}

.participant-parent {
  font-size: var(--type-caption, 10px);
  color: var(--theme-text-muted, #94a3b8);
}

.participant-session {
  font-size: var(--type-caption, 10px);
  color: var(--theme-text-muted, #94a3b8);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.participant-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.available-sources {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.available-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.available-label {
  font-weight: 600;
}

.available-harness {
  font-size: var(--type-caption, 10px);
  color: var(--theme-text-muted, #94a3b8);
}

.available-hint {
  margin: 0;
  font-size: var(--type-caption, 10px);
  line-height: 1.4;
  color: var(--theme-text-muted, #94a3b8);
}

.mono {
  font-family: var(--app-monospace-font-family);
}

.action-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
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

.action-button.active {
  border-color: var(--theme-accent-primary, #60a5fa);
  color: var(--theme-accent-primary, #93c5fd);
}

.action-button:focus-visible {
  outline: 2px solid var(--theme-accent-primary, #60a5fa);
  outline-offset: 1px;
}
</style>

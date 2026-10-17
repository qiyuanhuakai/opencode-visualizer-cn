<template>
  <section
    class="handoff-dialog"
    data-testid="handoff-dialog"
    :data-state="handoff?.state ?? 'none'"
    :aria-label="'Handoff'"
  >
    <header class="handoff-header">
      <span class="section-title">Handoff</span>
      <span v-if="handoff" class="state-chip" :data-state="handoff.state" data-testid="handoff-state">
        {{ handoff.state }}
      </span>
      <span v-else class="state-chip" data-state="none" data-testid="handoff-state">not started</span>
      <!--
        `active` is the service's DERIVED value: it exists only after a real native observation.
        This marker renders `handoff.active` verbatim, so a native ack alone can never show it.
      -->
      <span
        v-if="handoff?.active === true"
        class="active-marker"
        data-testid="handoff-active"
        data-active="true"
      >
        active — confirmed by a native observation
      </span>
    </header>

    <p v-if="!handoff" class="handoff-empty">
      No handoff on this thread. A handoff carries the bounded context checkpoint from the source
      participant to the target participant; the thread's active selection moves only after the
      target's own native observation arrives.
    </p>

    <template v-else>
      <ol class="ladder" data-testid="handoff-ladder" :aria-label="'Handoff ladder'">
        <li
          v-for="rung in ladder"
          :key="rung"
          class="ladder-rung"
          :class="{ 'is-current': handoff.state === rung, 'is-resolution': resolutionStates.includes(handoff.state) }"
          :data-rung="rung"
          :data-current="String(handoff.state === rung)"
        >
          {{ rung }}
        </li>
      </ol>

      <dl class="handoff-grid">
        <div class="handoff-cell" data-testid="handoff-source" :data-participant-id="handoff.source.participantId">
          <dt>Source</dt>
          <dd>
            <span class="cell-label">{{ roleOf(handoff.source.participantId) }}</span>
            <span class="cell-harness" data-testid="handoff-source-harness">{{
              harnessLabel(handoff.source.session.harnessInstanceId)
            }}</span>
            <span class="mono cell-session" :title="handoff.source.session.nativeSessionId">{{
              shortId(handoff.source.session.nativeSessionId)
            }}</span>
          </dd>
        </div>
        <div class="handoff-cell" data-testid="handoff-target" :data-participant-id="handoff.target.participantId">
          <dt>Target</dt>
          <dd>
            <span class="cell-label">{{ roleOf(handoff.target.participantId) }}</span>
            <span class="cell-harness" data-testid="handoff-target-harness">{{
              harnessLabel(handoff.target.session.harnessInstanceId)
            }}</span>
            <span class="mono cell-session" :title="handoff.target.session.nativeSessionId">{{
              shortId(handoff.target.session.nativeSessionId)
            }}</span>
          </dd>
        </div>
        <div v-if="handoff.checkpoint" class="handoff-cell" data-testid="handoff-checkpoint">
          <dt>Carried checkpoint</dt>
          <dd class="mono" :title="handoff.checkpoint.digest">
            {{ shortId(handoff.checkpoint.checkpointId) }} · {{ handoff.checkpoint.entryCount }} entries · {{
              handoff.checkpoint.bytes }} B
          </dd>
        </div>
        <div v-if="handoff.delivered" class="handoff-cell" data-testid="handoff-delivered">
          <dt>Native ack</dt>
          <dd>
            delivered by <span class="mono" data-testid="handoff-delivered-by">{{ handoff.deliveredBy }}</span> — an
            ack only means delivered, never active
          </dd>
        </div>
        <div v-if="handoff.observed" class="handoff-cell" data-testid="handoff-observed">
          <dt>Native observation</dt>
          <dd class="mono" data-testid="handoff-observed-by">{{ handoff.observedBy }}</dd>
        </div>
      </dl>

      <p v-if="handoff.resolution" class="handoff-resolution" role="status" data-testid="handoff-resolution">
        Resolved as <strong>{{ handoff.resolution.resolution }}</strong> — {{ handoff.resolution.code }} /
        {{ handoff.resolution.field }}<span v-if="handoff.resolution.reason"> ({{ handoff.resolution.reason }})</span>
      </p>

      <div v-if="ops.length > 0" class="handoff-ops" data-testid="handoff-ops">
        <div class="section-title">Journal</div>
        <ol class="ops-list">
          <li v-for="op in ops" :key="op.opId" class="op-row" data-testid="handoff-op">
            {{ op.kind }} {{ op.outcome }}
          </li>
        </ol>
      </div>

    </template>

    <!--
      The actions render in BOTH states: with no handoff yet the only live action is Begin, so a
      user can always start one; every other action stays disabled until its rung is reached. The
      preconditions mirror the service's own guards, and the service enforces them again.
    -->
    <footer class="handoff-actions">
      <button
        type="button"
        class="action-button"
        :disabled="busy || !canBegin"
        :title="beginDisabledReason"
        data-testid="begin-handoff"
        @click="emit('begin', { sourceParticipantId, targetParticipantId, prompt: draftText, entries: handoffEntries })"
      >
        Begin handoff
      </button>
      <button
        type="button"
        class="action-button"
        :disabled="busy || handoff?.state !== 'attached' || draftText.trim().length === 0"
        :title="handoff?.state === 'attached' ? 'Freeze the prompt for this handoff' : 'The handoff must be attached first'"
        data-testid="prepare-handoff"
        @click="emit('prepare', draftText)"
      >
        Prepare prompt
      </button>
      <button
        type="button"
        class="action-button save"
        :disabled="busy || handoff?.state !== 'prepared'"
        :title="handoff?.state === 'prepared' ? 'Send the prepared prompt to the target' : 'The handoff must be prepared first'"
        data-testid="deliver-handoff"
        @click="emit('deliver')"
      >
        Deliver
      </button>
      <button
        type="button"
        class="action-button"
        :disabled="busy || handoff?.state !== 'delivered' || latestNativeEventId.trim().length === 0"
        :title="handoff?.state !== 'delivered' ? 'Only a delivered handoff can be observed' : 'Record the real native observation'"
        data-testid="observe-handoff"
        @click="emit('observe', latestNativeEventId)"
      >
        Record observation
      </button>
      <button
        type="button"
        class="action-button"
        :disabled="busy || handoff === null || handoff.state === 'active'"
        :title="handoff?.state === 'active' ? 'A completed handoff cannot be cancelled' : 'Cancel this handoff'"
        data-testid="cancel-handoff"
        @click="emit('cancel', 'cancelled from the thread view')"
      >
        Cancel
      </button>
    </footer>
    <p v-if="handoff?.state === 'delivered' && latestNativeEventId.trim().length === 0" class="observe-waiting" data-testid="observe-waiting">
      Waiting for a real native observation. The handoff stays at delivered until the target's own
      native event arrives — it is never marked active from an ack, and it is never retried.
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { ParticipantView } from '../../../bridge/runtime/threads/participantService.js';
import type { RuntimeHandoffOpView, RuntimeHandoffView } from '../../composables/useRuntimeThread';

const props = withDefaults(
  defineProps<{
    handoff: RuntimeHandoffView | null;
    ops?: readonly RuntimeHandoffOpView[];
    /** The thread's participants, so source and target get readable labels. */
    participants?: readonly ParticipantView[];
    /** harnessInstanceId → display label from the container's harness registry. */
    harnessLabels?: Readonly<Record<string, string>>;
    /** The single prompt draft this handoff would carry (parent-owned). */
    draftText?: string;
    /**
     * The bounded context entries this handoff carries (task 33's shape). A handoff mints or
     * carries a checkpoint, so with nothing to carry the begin action stays disabled rather than
     * inventing a context.
     */
    handoffEntries?: readonly unknown[];
    /** The latest real native event id observed for the target, when there is one. */
    latestNativeEventId?: string;
    /** The active participant — the source a handoff starts from. */
    activeParticipantId?: string | null;
    /** The participant the input currently targets — the handoff's target. */
    targetParticipantId?: string | null;
    busy?: boolean;
  }>(),
  {
    ops: () => [],
    participants: () => [],
    harnessLabels: () => ({}),
    draftText: '',
    handoffEntries: () => [],
    latestNativeEventId: '',
    activeParticipantId: null,
    targetParticipantId: null,
    busy: false,
  },
);

const emit = defineEmits<{
  (event: 'begin', input: { sourceParticipantId: string; targetParticipantId: string; prompt: string; entries: readonly unknown[] }): void;
  (event: 'prepare', prompt: string): void;
  (event: 'deliver'): void;
  (event: 'observe', nativeEventId: string): void;
  (event: 'cancel', reason?: string): void;
}>();

/**
 * The reachable rungs of the read model. `observed` is the internal step that DERIVES `active`
 * (projectHandoffState), so the UI shows the five states a view can actually report and labels the
 * last one as derived — it never renders a state the service did not derive.
 */
const ladder = Object.freeze(['checkpoint', 'attached', 'prepared', 'delivered', 'active'] as const);
const resolutionStates = Object.freeze(['reconcile', 'failed', 'cancelled']);

const sourceParticipantId = computed(() => props.activeParticipantId ?? '');
const targetParticipantId = computed(() => props.targetParticipantId ?? '');

const canBegin = computed(() => {
  const current = props.handoff;
  if (current !== null && current.state !== 'checkpoint' && current.state !== 'attached') return false;
  if (sourceParticipantId.value === '' || targetParticipantId.value === '') return false;
  if (sourceParticipantId.value === targetParticipantId.value) return false;
  return props.draftText.trim().length > 0;
});

const beginDisabledReason = computed(() => {
  if (sourceParticipantId.value === '' || targetParticipantId.value === '') {
    return 'A handoff needs an active source and a selected target participant';
  }
  if (sourceParticipantId.value === targetParticipantId.value) {
    return 'The source and the target must be different participants';
  }
  if (props.draftText.trim().length === 0) {
    return 'A handoff carries the current prompt; write it first';
  }
  if (props.handoffEntries.length === 0) {
    return 'A handoff carries a context checkpoint; no context entries are available to carry';
  }
  return 'Start the handoff from the active participant to the selected target';
});

function roleOf(participantId: string): string {
  return props.participants.find((participant) => participant.participantId === participantId)?.role ?? 'participant';
}

function harnessLabel(harnessInstanceId: string): string {
  return props.harnessLabels[harnessInstanceId] ?? shortId(harnessInstanceId);
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}
</script>

<style scoped>
.handoff-dialog {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--theme-border-subtle, var(--theme-border-muted, rgba(148, 163, 184, 0.18)));
  border-radius: var(--radius-panel, 10px);
  background: var(--theme-card-bg, var(--theme-surface-panel, rgba(30, 41, 59, 0.35)));
}

.handoff-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.section-title {
  font-size: var(--type-caption, 10px);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--theme-text-muted, #94a3b8);
}

.state-chip {
  font-size: var(--type-caption, 10px);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--theme-border-default, #334155);
  color: var(--theme-text-muted, #94a3b8);
}

.state-chip[data-state='checkpoint'],
.state-chip[data-state='attached'],
.state-chip[data-state='prepared'] {
  color: var(--theme-status-warning, #fcd34d);
  border-color: color-mix(in srgb, var(--theme-status-warning, #fcd34d) 45%, transparent);
}

.state-chip[data-state='delivered'] {
  color: var(--theme-status-info, #7dd3fc);
  border-color: color-mix(in srgb, var(--theme-status-info, #7dd3fc) 45%, transparent);
}

.state-chip[data-state='active'] {
  color: var(--theme-status-success, #86efac);
  border-color: color-mix(in srgb, var(--color-success-400, #22c55e) 60%, transparent);
}

.state-chip[data-state='reconcile'],
.state-chip[data-state='failed'] {
  color: var(--theme-status-error, #f87171);
  border-color: color-mix(in srgb, var(--theme-status-error, #f87171) 55%, transparent);
}

.active-marker {
  font-size: var(--type-caption, 10px);
  font-weight: 600;
  color: var(--theme-status-success, #86efac);
}

.handoff-empty {
  margin: 0;
  font-size: var(--type-sm, 12px);
  line-height: 1.45;
  color: var(--theme-text-muted, #94a3b8);
}

.ladder {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-wrap: wrap;
  margin: 0;
  padding: 0;
  list-style: none;
}

.ladder-rung {
  font-size: var(--type-caption, 10px);
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--theme-border-default, #334155);
  color: var(--theme-text-muted, #94a3b8);
}

.ladder-rung + .ladder-rung::before {
  content: '→';
  margin-right: 6px;
  color: var(--theme-text-muted, #94a3b8);
}

.ladder-rung.is-current {
  border-color: var(--theme-accent-primary, #60a5fa);
  color: var(--theme-accent-primary, #93c5fd);
}

.ladder-rung.is-resolution {
  border-color: var(--theme-status-error, #f87171);
  color: var(--theme-status-error, #f87171);
}

.handoff-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 6px 10px;
  margin: 0;
}

.handoff-cell {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.handoff-cell dt {
  font-size: var(--type-caption, 10px);
  color: var(--theme-text-muted, #94a3b8);
}

.handoff-cell dd {
  margin: 0;
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex-wrap: wrap;
  font-size: var(--type-sm, 12px);
  color: var(--theme-text-primary, #e2e8f0);
}

.cell-label {
  font-weight: 600;
}

.cell-harness {
  font-size: var(--type-caption, 10px);
  color: var(--theme-status-info, #7dd3fc);
}

.cell-session {
  font-size: var(--type-caption, 10px);
  color: var(--theme-text-muted, #94a3b8);
}

.handoff-resolution {
  margin: 0;
  font-size: var(--type-sm, 12px);
  line-height: 1.45;
  color: var(--theme-status-error, #f87171);
  word-break: break-word;
}

.handoff-ops {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.ops-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.op-row {
  font-size: var(--type-caption, 10px);
  color: var(--theme-text-muted, #94a3b8);
}

.op-row::before {
  content: '· ';
}

.handoff-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.observe-waiting {
  margin: 0;
  font-size: var(--type-caption, 10px);
  line-height: 1.45;
  color: var(--theme-status-warning, #fcd34d);
}

.mono {
  font-family: var(--app-monospace-font-family);
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

.action-button.save {
  background: color-mix(in srgb, var(--theme-accent-primary, #60a5fa) 72%, transparent);
  border-color: color-mix(in srgb, var(--theme-accent-primary, #60a5fa) 82%, transparent);
}

.action-button:focus-visible {
  outline: 2px solid var(--theme-accent-primary, #60a5fa);
  outline-offset: 1px;
}
</style>

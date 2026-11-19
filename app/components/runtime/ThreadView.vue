<template>
  <!--
    The root is a modal dialog in the panel variant and a plain inline row in the composer
    variant, so the composer never enters the top layer. One content block serves both.
  -->
  <component
    :is="variant === 'panel' ? 'dialog' : 'div'"
    ref="dialogRef"
    class="thread-root"
    data-runtime-ui
    :class="variant === 'panel' ? 'modal-backdrop' : 'composer-root'"
    :aria-label='rt("Thread")'
    data-testid="thread-view"
    :data-thread-id="thread?.threadId ?? ''"
    :data-variant="variant"
    :data-revision="String(thread?.revision ?? 0)"
    @close="$emit('close')"
    @cancel.prevent="handleClose"
    @click.self="handleClose"
  >
    <div :class="variant === 'panel' ? 'modal' : 'composer-body'">
      <header v-if="variant === 'panel'" class="modal-header">
        <div class="modal-title">{{ rt("Thread") }}</div>
        <span v-if="thread" class="thread-meta mono" data-testid="thread-meta">
          {{ shortId(thread.threadId) }} {{ rt("· rev") }} {{ thread.revision }} · {{ thread.participants.length }} {{ rt("participants") }}
        </span>
        <button type="button" class="modal-close-button" data-testid="thread-view-close" :aria-label='rt("Close Thread")' @click="handleClose">
          <Icon icon="lucide:x" :width="14" :height="14" />
        </button>
      </header>

      <p v-if="error" class="modal-error" role="alert" data-testid="thread-error">
        <Icon icon="lucide:alert-triangle" :width="14" :height="14" />
        <span>{{ rt(error) }}</span>
      </p>

      <!--
        WHICH PARTICIPANTS THE INPUT GOES TO. One chip per effective target, named by role and
        native session, so the user can never wonder where a prompt will land. With no explicit
        target the chips follow the thread's ACTIVE participant and say so.
      -->
      <section class="target-section" data-testid="target-section" :aria-label='rt("Input targets")'>
        <div class="section-title">{{ rt("Input goes to") }}</div>
        <div class="target-chips">
          <span
            v-for="participant in effectiveTargets"
            :key="participant.participantId"
            class="target-chip"
            :class="{ 'is-owner': participant.role === 'owner' }"
            :data-testid="'target-chip'"
            :data-participant-id="participant.participantId"
            :data-role="participant.role"
          >
            <span class="chip-role">{{ rt(participant.role) }}</span>
            <span class="chip-harness">{{ harnessLabel(participant.harnessInstanceId) }}</span>
            <span class="chip-session mono" :title="participant.session.nativeSessionId">{{
              shortId(participant.session.nativeSessionId)
            }}</span>
          </span>
          <span v-if="effectiveTargets.length === 0" class="target-none" data-testid="target-none">
            {{ rt("No participant can receive the input yet.") }}
          </span>
        </div>
        <p v-if="targets.length === 0 && effectiveTargets.length > 0" class="target-follow-hint" data-testid="target-follow-hint">
          {{ rt("No explicit target: the input follows the thread\u0027s active participant.") }}
        </p>
        <p class="target-count" data-testid="target-count">{{ effectiveTargets.length }}</p>
        <div class="draft-preview" data-testid="draft-preview" :title="draftText">
          {{ draftText.trim().length > 0 ? draftText : rt('(no prompt drafted)') }}
        </div>
      </section>

      <!--
        RESERVED fan-out slot. Task 38 builds the behaviour and task 42 enables this slot; until
        then it is an explicitly labelled, disabled placeholder that never claims fan-out works.
      -->
      <section
        v-if="variant === 'panel'"
        class="fanout-slot"
        data-testid="fanout-slot"
        :data-reserved="String(!fanoutEnabled)"
        :aria-label="rt('Fan-out')"
      >
        <div class="section-title">{{ rt("Fan-out") }}</div>
        <p class="fanout-note">
          <template v-if="fanoutEnabled">{{ rt("Fan-out is enabled for this thread.") }}</template>
          <template v-else>
            {{ rt("Fan-out is unavailable for this thread. Send to the selected participants above.") }}
          </template>
        </p>
        <button
          v-if="fanoutEnabled"
          type="button"
          class="action-button"
          data-testid="fanout-slot-action"
          @click="handleFanout"
        >
          {{ rt("Open Team dispatch") }}
        </button>
        <button v-else type="button" class="action-button" disabled data-testid="fanout-slot-action" :title="rt('Fan-out unavailable')">
          {{ rt("Fan-out unavailable") }}
        </button>
      </section>

      <ParticipantPicker
        v-if="variant === 'panel' && thread"
        :participants="thread.participants"
        :targets="targets"
        :active-participant-id="thread.activeParticipantId"
        :available-sessions="availableSessions"
        :harness-labels="harnessLabels"
        :busy="busy"
        @select-target="emit('select-target', $event)"
        @activate="emit('activate', $event)"
        @leave="emit('leave', $event)"
        @resume="emit('resume', $event)"
        @join="emit('join', $event)"
        @locate-session="emit('locate-session', $event)"
      />

      <nav v-if="variant === 'panel' && participantPage && participantPage.total > 50" class="runtime-pagination" :aria-label="rt('Participant pages')">
        <button type="button" class="action-button" :disabled="busy || participantPage.offset === 0" @click="emit('participant-page', Math.max(0, participantPage.offset - 50))">{{ rt('Previous participants') }}</button>
        <span>{{ participantPage.offset + 1 }}–{{ Math.min(participantPage.offset + 50, participantPage.total) }} / {{ participantPage.total }}</span>
        <button type="button" class="action-button" :disabled="busy || participantPage.nextCursor === null" @click="emit('participant-page', participantPage.nextCursor ?? 0)">{{ rt('Next participants') }}</button>
      </nav>

      <section v-if="variant === 'panel' && handoffs.length" class="handoff-history">
        <Dropdown :model-value="handoff?.handoffId" :label="handoff ? handoffLabel(handoff) : rt('Handoff history')" :aria-label="rt('Handoff history')" auto-close :disabled="busy" @update:model-value="selectHandoff">
          <DropdownItem v-for="entry in handoffs" :key="entry.handoffId" :value="entry.handoffId">{{ handoffLabel(entry) }}</DropdownItem>
        </Dropdown>
        <nav v-if="handoffPage && handoffPage.total > 50" class="runtime-pagination" :aria-label="rt('Handoff pages')">
          <button type="button" class="action-button" :disabled="busy || handoffPage.offset === 0" @click="emit('handoff-page', Math.max(0, handoffPage.offset - 50))">{{ rt('Previous handoffs') }}</button>
          <span>{{ handoffPage.offset + 1 }}–{{ Math.min(handoffPage.offset + 50, handoffPage.total) }} / {{ handoffPage.total }}</span>
          <button type="button" class="action-button" :disabled="busy || handoffPage.nextCursor === null" @click="emit('handoff-page', handoffPage.nextCursor ?? 0)">{{ rt('Next handoffs') }}</button>
        </nav>
      </section>

      <HandoffDialog
        v-if="variant === 'panel'"
        :handoff="handoff"
        :ops="handoffOps"
        :participants="thread?.participants ?? []"
        :harness-labels="harnessLabels"
        :draft-text="draftText"
        :handoff-entries="handoffEntries"
        :latest-native-event-id="latestNativeEventId"
        :active-participant-id="thread?.activeParticipantId ?? null"
        :target-participant-id="effectiveTargets[0]?.participantId ?? null"
        :busy="busy"
        @begin="emit('begin-handoff', $event)"
        @prepare="emit('prepare-handoff', $event)"
        @deliver="emit('deliver-handoff')"
        @observe="emit('observe-handoff', $event)"
        @cancel="emit('cancel-handoff', $event)"
      />

      <!-- Thread ↔ session tree: the tree's current selection, resolved against this thread. -->
      <p
        v-if="variant === 'panel' && selectedSession"
        class="session-resolution"
        data-testid="thread-for-session"
        :data-thread-id="selectedSessionResolution?.threadId ?? ''"
        :data-participant-id="selectedSessionResolution?.participantId ?? ''"
        :data-unresolved="String(selectedSessionResolution === null)"
      >
        <template v-if="selectedSessionResolution">
          {{ rt("The session tree\u0027s selection is a participant of this thread.") }}
        </template>
        <template v-else>
          {{ rt("The session tree\u0027s selection is not part of this thread.") }}
        </template>
      </p>

      <!-- Causal timeline: every entry keeps its own source; history is not a blind concatenation. -->
      <section v-if="variant === 'panel' && timeline && timeline.entries.length > 0" class="timeline-section" data-testid="timeline-section">
        <div class="section-title">{{ rt("Causal timeline") }}</div>
        <ol class="timeline-list">
          <li
            v-for="entry in timeline.entries"
            :key="entry.entryId"
            class="timeline-entry"
            :data-testid="'timeline-entry'"
            :data-source-kind="entry.source.kind"
            :data-source-label="sourceLabel(entry.source)"
            :data-kind="entry.kind"
          >
            <span class="entry-source" :data-source-kind="entry.source.kind">{{ sourceLabel(entry.source) }}</span>
            <span class="entry-kind">{{ entry.kind }}</span>
            <span class="entry-payload">{{ payloadPreview(entry.payload) }}</span>
          </li>
        </ol>
        <nav v-if="timeline.total > 50" class="runtime-pagination" :aria-label="rt('Timeline pages')">
          <button type="button" class="action-button" :disabled="busy || timelineOffset === 0" @click="emit('timeline-page', Math.max(0, timelineOffset - 50))">{{ rt('Previous timeline entries') }}</button>
          <span>{{ timelineOffset + 1 }}–{{ Math.min(timelineOffset + 50, timeline.total) }} / {{ timeline.total }}</span>
          <button type="button" class="action-button" :disabled="busy || timeline.nextCursor === null" @click="emit('timeline-page', timeline.nextCursor ?? 0)">{{ rt('Next timeline entries') }}</button>
        </nav>
        <p class="timeline-note" data-testid="timeline-note">
          {{ rt("Entries are ordered per-source with their own origin; the host command and each native harness keep separate histories.") }}
        </p>
      </section>

      <ContextEvidenceView
        v-if="variant === 'panel'"
        :checkpoint="checkpoint"
        :current-target="currentTarget"
        :target-error="evidenceTargetError"
        :read-evidence="readEvidence"
        :read-evidence-page="readEvidencePage"
        :capture-evidence="captureEvidence"
        :captured-evidence="capturedEvidence"
        :remove-evidence="removeEvidence"
        :busy="busy"
        :page-length="pageLength"
      />

      <!--
        NATIVE HISTORY, PER PARTICIPANT. Each participant's own history renders under its own
        heading, labelled with its harness and native session; the groups are listed side by side
        and NEVER concatenated into one history.
      -->
      <section v-if="variant === 'panel' && nativeHistory.length > 0" class="native-history" data-testid="native-history">
        <div class="section-title">{{ rt("Native history") }}</div>
        <p class="native-history-note" data-testid="native-history-note">
          {{ rt("One list per participant. Histories are browsed individually and never merged.") }}
        </p>
        <div
          v-for="group in nativeHistory"
          :key="group.participantId"
          class="native-history-group"
          :data-testid="'native-history-group'"
          :data-participant-id="group.participantId"
          :data-harness="group.harness"
          :data-state="stateOf(group.participantId)"
        >
          <header class="group-header">
            <span class="group-label">{{ group.label }}</span>
            <span class="group-harness">{{ rt(group.harness) }}</span>
            <span class="group-session mono" data-testid="native-history-session" :title="group.session.nativeSessionId">{{
              group.session.nativeSessionId
            }}</span>
            <button
              type="button"
              class="action-button"
              :disabled="busy || nativeHistory.some(entry => entry.loading)"
              :title='rt("Re-read this participant\u0027s own native history")'
              :data-testid="'browse-native-history'"
              :data-participant-id="group.participantId"
              @click="emit('browse-native-history', group.participantId)"
            >
              {{ rt("Refresh") }}
            </button>
          </header>
          <p v-if="group.loading" role="status">{{ rt('Loading native history') }}</p>
          <p v-if="group.error" role="alert">{{ group.error }}</p>
          <ol class="group-entries">
            <li
              v-for="entry in group.entries"
              :key="entry.id"
              class="group-entry"
              :data-testid="'native-history-entry'"
              :data-kind="entry.kind"
            >
              {{ entry.text }}
            </li>
          </ol>
          <!--
            An unavailable participant's own target is not readable from here: a different
            environment or harness instance, or a failed read on the right one. It is stated
            explicitly — an empty list here would read as "this participant has no messages".
          -->
          <p
            v-if="group.unavailable"
            class="group-unavailable"
            data-testid="native-history-unavailable"
            :data-participant-id="group.participantId"
          >
            This participant's session belongs to another target; its history is unavailable here.
          </p>
        </div>
      </section>

      <footer v-if="variant === 'panel'" class="modal-actions">
        <button type="button" class="action-button" data-testid="thread-view-done" @click="handleClose">{{ rt("Done") }}</button>
      </footer>
    </div>
  </component>
</template>

<script setup lang="ts">
import { useRuntimeUi } from '../../locales/runtimeUi';
const { rt } = useRuntimeUi();
import { computed, ref, watch } from 'vue';
import type { AsyncEvidenceCapture, AsyncEvidencePageReader } from '../../runtime/hostEvidenceViews';
import { Icon } from '@iconify/vue';
import type { ThreadSummary } from '../../../bridge/runtime/threads/threadService.js';
import type { ParticipantView } from '../../../bridge/runtime/threads/participantService.js';
import type { SessionRef } from '../../../shared/runtime/identity.js';
import type {
  ContextCheckpointView,
  EvidenceReader,
  EvidenceRecordView,
  EvidenceTarget,
} from '../../../shared/runtime/context.js';
import { effectiveTargetParticipants } from '../../composables/useRuntimeThread';
import type {
  NativeHistoryGroup,
  RuntimeHandoffOpView,
  RuntimeHandoffView,
  ThreadSessionResolution,
} from '../../composables/useRuntimeThread';
import type { TimelinePage, TimelineSource } from '../../runtime/timeline';
import ParticipantPicker from './ParticipantPicker.vue';
import HandoffDialog from './HandoffDialog.vue';
import Dropdown from '../Dropdown.vue';
import DropdownItem from '../Dropdown/Item.vue';
import ContextEvidenceView from './ContextEvidenceView.vue';

const props = withDefaults(
  defineProps<{
    open?: boolean;
    /** The frozen thread read model (task 31's `get()`), never a live record. */
    thread: ThreadSummary | null;
    /** Explicit target participant ids; empty follows the active participant. */
    targets: readonly string[];
    /** The handoff read model; `state`/`active` are the service's DERIVED values. */
    handoff: RuntimeHandoffView | null;
    handoffOps?: readonly RuntimeHandoffOpView[];
    handoffs?: readonly RuntimeHandoffView[];
    handoffPage?: { offset: number; total: number; nextCursor: number | null };
    /** The causal timeline page (task 32), each entry carrying its own source. */
    timeline?: TimelinePage | null;
    timelineOffset?: number;
    participantPage?: { offset: number; total: number; nextCursor: number | null };
    /** The bounded context checkpoint preview (task 33). */
    checkpoint?: ContextCheckpointView | null;
    /** The CURRENT evidence target the reader re-verifies against. */
    currentTarget?: EvidenceTarget | null;
    evidenceTargetError?: string;
    readEvidence?: EvidenceReader | null;
    readEvidencePage?: AsyncEvidencePageReader | null;
    captureEvidence?: AsyncEvidenceCapture | null;
    capturedEvidence?: readonly EvidenceRecordView[];
    removeEvidence?: ((hash: string) => void) | null;
    /** Byte page size for evidence reads; the contract default applies when omitted. */
    pageLength?: number;
    /** Per-participant native histories, supplied by the container — never merged here. */
    nativeHistory?: readonly NativeHistoryGroup[];
    /** Native sessions the picker can offer (the session tree's rows). */
    availableSessions?: readonly { session: SessionRef; label: string; harness: string }[];
    /** harnessInstanceId → display label from the container's harness registry. */
    harnessLabels?: Readonly<Record<string, string>>;
    /** The latest REAL native event id for the target, when one has arrived. */
    latestNativeEventId?: string;
    /** The single prompt draft (parent-owned); switching targets never touches it. */
    draftText?: string;
    /** The bounded context entries a handoff would carry (task 33's shape). */
    handoffEntries?: readonly unknown[];
    /** True only once task 42 enables the fan-out slot. */
    fanoutEnabled?: boolean;
    /** The session tree's current selection. */
    selectedSession?: SessionRef | null;
    /** That selection resolved against this thread, when it belongs to it. */
    selectedSessionResolution?: ThreadSessionResolution | null;
    busy?: boolean;
    error?: string;
    /** `composer` renders the compact target row inside the input panel; `panel` the full surface. */
    variant?: 'composer' | 'panel';
  }>(),
  {
    open: false,
    handoffOps: () => [],
    handoffs: () => [],
    timeline: null,
    timelineOffset: 0,
    checkpoint: null,
    currentTarget: null,
    readEvidence: null,
    readEvidencePage: null,
    captureEvidence: null,
    capturedEvidence: () => [],
    removeEvidence: null,
    pageLength: 4096,
    nativeHistory: () => [],
    availableSessions: () => [],
    harnessLabels: () => ({}),
    latestNativeEventId: '',
    draftText: '',
    handoffEntries: () => [],
    fanoutEnabled: false,
    selectedSession: null,
    selectedSessionResolution: null,
    busy: false,
    error: '',
    variant: 'panel',
  },
);

const emit = defineEmits<{
  (event: 'handoff-page', offset: number): void;
  (event: 'select-handoff', handoffId: string): void;
  (event: 'fanout'): void;
  (event: 'participant-page', offset: number): void;
  (event: 'timeline-page', offset: number): void;
  (event: 'close'): void;
  (event: 'select-target', participantId: string): void;
  (event: 'activate', participantId: string): void;
  (event: 'leave', participantId: string): void;
  (event: 'resume', participantId: string): void;
  (event: 'join', session: SessionRef): void;
  (event: 'begin-handoff', input: { sourceParticipantId: string; targetParticipantId: string; prompt: string; entries: readonly unknown[] }): void;
  (event: 'prepare-handoff', prompt: string): void;
  (event: 'deliver-handoff'): void;
  (event: 'observe-handoff', nativeEventId: string): void;
  (event: 'cancel-handoff', reason?: string): void;
  (event: 'locate-session', session: SessionRef): void;
  (event: 'browse-native-history', participantId: string): void;
}>();

const dialogRef = ref<HTMLDialogElement | null>(null);
function selectHandoff(value: unknown): void { if (typeof value === 'string') emit('select-handoff', value); }
function handoffLabel(value: RuntimeHandoffView): string {
  return `${rt(value.state)} · ${new Date(value.createdAt).toLocaleString()} · ${value.target.session.nativeSessionId}`;
}

watch(
  () => [props.open, props.variant, dialogRef.value] as const,
  ([open]) => {
    // Only the panel variant owns a real dialog element; the composer row is inline.
    if (props.variant !== 'panel') return;
    const element = dialogRef.value;
    if (element === null) return;
    if (open) {
      if (!element.open) element.showModal();
    } else if (element.open) {
      element.close();
    }
  },
);

/**
 * THE target rule, in one place: an explicit selection wins; with none, the input follows the
 * thread's active participant. The chips render exactly this list, so the user always sees where
 * the prompt goes — and InputPanel sends through the very same rule.
 */
const effectiveTargets = computed<readonly ParticipantView[]>(() =>
  effectiveTargetParticipants(props.thread, props.targets),
);

function stateOf(participantId: string): string {
  return props.thread?.participants.find((participant) => participant.participantId === participantId)?.state ?? 'unknown';
}

function sourceLabel(source: TimelineSource): string {
  return source.kind === 'host' ? `host:${source.commandId}` : `native:${source.harness}`;
}

function payloadPreview(payload: Readonly<Record<string, unknown>>): string {
  const text = typeof payload.text === 'string' ? payload.text : JSON.stringify(payload);
  return text.length > 80 ? `${text.slice(0, 80)}…` : text;
}

function harnessLabel(harnessInstanceId: string): string {
  return props.harnessLabels[harnessInstanceId] ?? shortId(harnessInstanceId);
}

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value;
}

function handleClose(): void {
  emit('close');
}

function handleFanout(): void {
  emit('fanout');
}
</script>

<style scoped>
.runtime-pagination {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
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
  width: min(720px, 95vw);
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

/* The composer variant is a slim row inside the input panel, not a modal. */
.composer-root {
  display: block;
  width: 100%;
}

.composer-body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
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

.thread-meta {
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

.section-title {
  font-size: var(--type-caption, 10px);
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--theme-text-muted, #94a3b8);
}

.target-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px solid var(--theme-border-subtle, var(--theme-border-muted, rgba(148, 163, 184, 0.18)));
  border-radius: var(--radius-panel, 10px);
  background: var(--theme-card-bg, var(--theme-surface-panel, rgba(30, 41, 59, 0.35)));
}

.target-chips {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.target-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 999px;
  border: 1px solid var(--theme-accent-primary, #60a5fa);
  background: color-mix(in srgb, var(--theme-accent-primary, #60a5fa) 14%, transparent);
  color: var(--theme-text-primary, #e2e8f0);
  font-size: var(--type-caption, 10px);
  font-weight: 600;
}

.chip-role {
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--theme-accent-primary, #93c5fd);
}

.chip-harness {
  color: var(--codex-status-info, var(--theme-text-primary));
}

.chip-session {
  font-weight: 400;
  color: var(--theme-text-muted, #94a3b8);
}

.target-none {
  font-size: var(--type-sm, 12px);
  color: var(--codex-status-warning, var(--theme-text-primary));
}

.target-follow-hint,
.target-count {
  margin: 0;
  font-size: var(--type-caption, 10px);
  line-height: 1.4;
  color: var(--theme-text-muted, #94a3b8);
}

.target-count {
  align-self: flex-end;
  font-weight: 600;
}

.draft-preview {
  padding: 6px 8px;
  border: 1px dashed var(--theme-input-border, var(--theme-border-default, #334155));
  border-radius: var(--radius-control, 8px);
  background: var(--theme-input-bg, var(--theme-surface-panel-muted, rgba(15, 23, 42, 0.72)));
  color: var(--theme-input-text, var(--theme-text-primary, #e2e8f0));
  font-size: var(--type-sm, 12px);
  line-height: 1.45;
  max-height: 64px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
}

.fanout-slot {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 10px;
  border: 1px dashed color-mix(in srgb, var(--theme-status-warning, #fcd34d) 45%, transparent);
  border-radius: var(--radius-panel, 10px);
  background: color-mix(in srgb, var(--theme-status-warning, #fcd34d) 6%, transparent);
}

.fanout-note {
  margin: 0;
  font-size: var(--type-caption, 10px);
  line-height: 1.45;
  color: var(--codex-status-warning, var(--theme-text-primary));
}

.session-resolution {
  margin: 0;
  font-size: var(--type-caption, 10px);
  line-height: 1.45;
  color: var(--theme-text-muted, #94a3b8);
}

.session-resolution[data-unresolved='true'] {
  color: var(--codex-status-warning, var(--theme-text-primary));
}

.timeline-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.timeline-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.timeline-entry {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  padding: 4px 8px;
  border: 1px solid var(--theme-border-default, #334155);
  border-radius: var(--radius-control, 8px);
  background: var(--theme-surface-panel-muted, rgba(15, 23, 42, 0.72));
  font-size: var(--type-caption, 10px);
}

.entry-source {
  font-weight: 600;
  color: var(--codex-status-info, var(--theme-text-primary));
}

.entry-source[data-source-kind='host'] {
  color: var(--theme-accent-primary, #93c5fd);
}

.entry-kind {
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--theme-text-muted, #94a3b8);
}

.entry-payload {
  flex: 1 1 160px;
  min-width: 0;
  color: var(--theme-text-primary, #e2e8f0);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.timeline-note {
  margin: 0;
  font-size: var(--type-caption, 10px);
  line-height: 1.4;
  color: var(--theme-text-muted, #94a3b8);
}

.native-history {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.native-history-note {
  margin: 0;
  font-size: var(--type-caption, 10px);
  line-height: 1.4;
  color: var(--theme-text-muted, #94a3b8);
}

.native-history-group {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border: 1px solid var(--theme-border-default, #334155);
  border-radius: var(--radius-control, 8px);
  background: var(--theme-surface-panel-muted, rgba(15, 23, 42, 0.72));
}

.native-history-group[data-state='left'] {
  border-color: color-mix(in srgb, var(--theme-status-warning, #fcd34d) 45%, transparent);
}

.native-history-group[data-state='orphaned'] {
  border-color: color-mix(in srgb, var(--theme-status-error, #f87171) 55%, transparent);
}

.group-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.group-label {
  font-size: var(--type-sm, 12px);
  font-weight: 600;
  color: var(--theme-text-primary, #e2e8f0);
}

.group-harness {
  font-size: var(--type-caption, 10px);
  color: var(--codex-status-info, var(--theme-text-primary));
}

.group-session {
  font-size: var(--type-caption, 10px);
  color: var(--theme-text-muted, #94a3b8);
}

.group-header .action-button {
  margin-left: auto;
}

.group-entries {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.group-entry {
  font-size: var(--type-caption, 10px);
  line-height: 1.45;
  color: var(--theme-text-primary, #e2e8f0);
  word-break: break-word;
}

.group-entry::before {
  content: '· ';
  color: var(--theme-text-muted, #94a3b8);
}

.group-unavailable {
  margin: 0;
  font-size: var(--type-caption, 10px);
  line-height: 1.45;
  color: var(--theme-text-muted, #94a3b8);
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

.action-button:focus-visible {
  outline: 2px solid var(--theme-accent-primary, #60a5fa);
  outline-offset: 1px;
}

.modal-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

@media (max-width: 640px) {
  .modal {
    width: 95vw;
  }
}
</style>

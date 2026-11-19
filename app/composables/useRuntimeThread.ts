/**
 * Task 35 — the Thread participant and handoff interaction state.
 *
 * This composable is the app-side seat of the Thread UI. It consumes the landed task-31 Thread
 * service and the landed task-34 Handoff service through narrow ports, and it holds NO product
 * state of its own beyond what those services report:
 *
 *   - every read model is a FROZEN snapshot taken at the moment of observation (`get()` /
 *     `history()` / `nativeHistory()` / `handoff()`), never a live internal record — task 31's
 *     `resume()` mutates the very object a live reference would hold;
 *   - the handoff state is the service's DERIVED state (`projectHandoffState`): `active` is
 *     reachable only through `observation.observed`, so a native ack can never render as active
 *     here either. The UI renders `handoff.state` and `handoff.active` verbatim;
 *   - the target chips are the UI's own selection (which participant the single prompt goes to);
 *     fan-out is task 38's behaviour and task 42's enablement, so `targets` stays a list the UI
 *     owns and this composable never fans out;
 *   - the session↔thread index is keyed by the canonical `threadBindingKey`, so a native
 *     SessionRef resolves to exactly one thread and one participant in both locate directions.
 *
 * The ports are injected (RUNTIME_THREAD_STATE_KEY) so presentational components stay pure and
 * the wiring point for the container is a single provide — the same optional-seam posture task
 * 22's RUNTIME_SESSION_ACTIONS_KEY uses. Absent seam → nothing renders, so existing surfaces
 * are unaffected.
 */
import { computed, inject, ref, type ComputedRef, type InjectionKey, type Ref } from 'vue';
import type { ProtocolError } from '../../shared/runtime/capabilities.js';
import type { RepoRef, SessionRef } from '../../shared/runtime/identity.js';
import type { ThreadService, ThreadSummary } from '../../bridge/runtime/threads/threadService.js';
import type { ParticipantView } from '../../bridge/runtime/threads/participantService.js';
import { threadBindingKey } from '../../shared/runtime/thread.js';
import type { TimelinePage, TurnTimeline } from '../runtime/timeline';
import { createTurnTimeline } from '../runtime/timeline';

/**
 * THE target rule, in one place: an explicit selection wins; with none, the
 * input follows the thread's active participant.
 *
 * ThreadView's chips render exactly this list, and InputPanel sends through
 * exactly this participant, so the display and the send can never disagree
 * about where a prompt lands. The rule is a pure function of the frozen read
 * model so both callers — and the composable's own `effectiveTargets` — are
 * provably the same rule rather than two implementations that can drift.
 */
export function effectiveTargetParticipants(
  summary: ThreadSummary | null,
  targets: readonly string[],
): readonly ParticipantView[] {
  if (summary === null) return Object.freeze([]);
  if (targets.length > 0) {
    return Object.freeze(
      summary.participants.filter((participant) => targets.includes(participant.participantId)),
    );
  }
  const active = summary.participants.find(
    (participant) => participant.participantId === summary.activeParticipantId,
  );
  return Object.freeze(active === undefined ? [] : [active]);
}

/**
 * The frozen handoff read model this UI renders (task 34's `handoffView`).
 *
 * Declared here rather than imported: the bridge handoff module ships no sibling declaration,
 * and a static import of a .d.ts-less module is TS7016 under the repo's strict gate (task 34's
 * own test loads it through createRequire for exactly this reason). `state` and `active` are the
 * service's DERIVED values; nothing here recomputes them.
 */
export interface RuntimeHandoffView {
  readonly handoffId: string;
  readonly threadId: string;
  readonly environmentId: string;
  readonly state: string;
  readonly active: boolean;
  readonly source: { readonly participantId: string; readonly session: SessionRef };
  readonly target: { readonly participantId: string; readonly session: SessionRef };
  readonly originalParticipantId: string;
  readonly checkpoint: { readonly checkpointId: string; readonly digest: string; readonly bytes: number; readonly entryCount: number } | null;
  readonly promptFingerprint: string | null;
  readonly delivered: boolean;
  readonly deliveredAt: number | null;
  readonly deliveredBy: string | null;
  readonly observed: boolean;
  readonly observedAt: number | null;
  readonly observedBy: string | null;
  readonly resolution: { readonly resolution: string; readonly code: string; readonly field: string; readonly reason: string | null; readonly at: number } | null;
  readonly sends: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** One journaled handoff operation (task 34's `opView`), shown so a replay is visible as a duplicate. */
export interface RuntimeHandoffOpView {
  readonly opId: string;
  readonly handoffId: string;
  readonly kind: string;
  readonly at: number;
  readonly applied: boolean;
  readonly duplicate: boolean;
  readonly outcome: string;
  readonly code: string | null;
  readonly field: string | null;
}

/** The narrow handoff surface the UI drives; the real task-34 service satisfies it structurally. */
export interface RuntimeHandoffPort {
  begin(input: {
    threadId: string;
    sourceParticipantId: string;
    targetParticipantId: string;
    prompt?: string;
    entries?: readonly unknown[];
    handoffId?: string;
  }): Promise<RuntimeHandoffView>;
  attach(input: { handoffId: string }): Promise<RuntimeHandoffView>;
  prepare(input: { handoffId: string; prompt: string }): Promise<RuntimeHandoffView>;
  deliver(input: { handoffId: string }): Promise<RuntimeHandoffView>;
  observe(input: { handoffId: string; nativeEventId: string }): Promise<RuntimeHandoffView>;
  cancel(input: { handoffId: string; reason?: string }): Promise<RuntimeHandoffView>;
  handoff(handoffId: string): RuntimeHandoffView;
  handoffs(): readonly RuntimeHandoffView[];
  ops(handoffId: string): readonly RuntimeHandoffOpView[];
}

export interface RuntimeThreadPorts {
  /** The landed task-31 Thread service. */
  readonly thread: ThreadService;
  /** The landed task-34 Handoff service, when the container wires one. */
  readonly handoff?: RuntimeHandoffPort | null;
  /** The causal timeline the UI renders; the app-side task-32 twin by default. */
  readonly timeline?: TurnTimeline;
}

/** One participant's own native history, supplied by the container per participant — never merged. */
export interface NativeHistoryGroup {
  readonly participantId: string;
  readonly label: string;
  readonly harness: string;
  readonly session: SessionRef;
  readonly entries: readonly { readonly id: string; readonly kind: string; readonly text: string; readonly at: number }[];
  /**
   * True when this participant's own qualified target is not one this browser can read — a
   * different environment or harness instance, or a failed read on the right one. The group is
   * then explicitly unavailable: never another target's bytes relabelled as this participant,
   * and never a silent empty history that reads as "no messages".
   */
  readonly unavailable?: boolean;
}

/** A native session the picker can offer to the thread (the session tree's rows). */
export interface AvailableSession {
  readonly session: SessionRef;
  readonly label: string;
  readonly harness: string;
}

export interface ThreadSessionResolution {
  readonly threadId: string;
  readonly participantId: string;
}

export interface RuntimeThreadState {
  /** False until a thread port exists; components render nothing when false. */
  readonly available: boolean;
  readonly threadId: Ref<string | null>;
  readonly summary: Ref<ThreadSummary | null>;
  /** Which participants the single prompt goes to. Empty = follow the active participant. */
  readonly targets: Ref<readonly string[]>;
  /**
   * THE target rule: explicit selection, else the thread's active participant.
   * The chips render this list and the composer sends through it.
   */
  readonly effectiveTargets: ComputedRef<readonly ParticipantView[]>;
  readonly handoff: Ref<RuntimeHandoffView | null>;
  readonly handoffOps: Ref<readonly RuntimeHandoffOpView[]>;
  /** The session tree's current selection, resolved against this thread. */
  readonly selectedSession: Ref<SessionRef | null>;
  readonly busy: Ref<boolean>;
  readonly error: Ref<string>;
  readonly timelinePage: Ref<TimelinePage | null>;
  readonly selectedSessionResolution: ComputedRef<ThreadSessionResolution | null>;
  openThread(input: { session: SessionRef; repo: RepoRef }): Promise<void>;
  joinThread(session: SessionRef): Promise<void>;
  leaveParticipant(participantId: string): Promise<void>;
  resumeParticipant(participantId: string): Promise<void>;
  activateParticipant(participantId: string): Promise<void>;
  setTarget(participantId: string): void;
  clearTarget(): void;
  setSelectedSession(session: SessionRef | null): void;
  /**
   * The complete qualified locate: write the selection and answer the resolution the
   * container drives the real session-tree selection with (null when the session is not
   * part of the current thread).
   */
  locateSession(session: SessionRef | null): ThreadSessionResolution | null;
  beginHandoff(input: {
    sourceParticipantId: string;
    targetParticipantId: string;
    prompt: string;
    entries?: readonly unknown[];
  }): Promise<void>;
  prepareHandoff(prompt: string): Promise<void>;
  deliverHandoff(): Promise<void>;
  observeHandoff(nativeEventId: string): Promise<void>;
  cancelHandoff(reason?: string): Promise<void>;
  /** Thread → session tree: the participant's own frozen native SessionRef. */
  sessionOfParticipant(participantId: string): SessionRef | null;
  /** Session tree → thread: which thread and participant a native SessionRef belongs to. */
  threadForSession(session: SessionRef): ThreadSessionResolution | null;
  closeThread(): void;
}

const TIMELINE_PAGE_LIMIT = 100;
/**
 * The DECIDED handoff states — the ones whose outcome the user already knows: completed,
 * cancelled or definitely failed. A decided record is HISTORY: it never blocks a new handoff and
 * it is never restored on reopen.
 *
 * `reconcile` is deliberately NOT one of them. Its send outcome is UNKNOWN, so the delivery is
 * still live work: it must stay visible after a reopen and keep blocking a second handoff, exactly
 * like the forward rungs. Treating it as history is what hid an unresolved delivery and let a
 * duplicate handoff start beside it.
 */
const RESOLVED_HANDOFF_STATES: ReadonlySet<string> = new Set(['cancelled', 'failed', 'active']);

/** Read a rejection as a readable sentence; a bare protocol code is never shown to the user. */
function readableError(error: unknown, fallback: string): string {
  if (error instanceof Error) {
    const protocol = error as ProtocolError;
    const code = typeof protocol.code === 'string' ? protocol.code : '';
    const field = typeof protocol.field === 'string' ? protocol.field : '';
    const detail = code || field ? ` (${[code, field].filter(Boolean).join('/')})` : '';
    return `${fallback}: ${error.message}${detail}`;
  }
  return fallback;
}

/**
 * A decided handoff record never blocks a new handoff; live work — every forward rung and
 * `reconcile` — does. Presentational surfaces (the handoff dialog's Begin button) read the SAME
 * rule the composable enforces, so the button and the action can never disagree.
 */
export function handoffStateAllowsBegin(state: string): boolean {
  return RESOLVED_HANDOFF_STATES.has(state);
}

export function createRuntimeThreadState(ports: RuntimeThreadPorts): RuntimeThreadState {
  const timeline: TurnTimeline = ports.timeline ?? createTurnTimeline();
  const threadId = ref<string | null>(null);
  const summary = ref<ThreadSummary | null>(null);
  const targets = ref<readonly string[]>([]);
  const effectiveTargets = computed<readonly ParticipantView[]>(() =>
    effectiveTargetParticipants(summary.value, targets.value),
  );
  const handoff = ref<RuntimeHandoffView | null>(null);
  const handoffOps = ref<readonly RuntimeHandoffOpView[]>([]);
  const selectedSession = ref<SessionRef | null>(null);
  const busy = ref(false);
  const error = ref('');
  const timelinePage = ref<TimelinePage | null>(null);
  let repo: RepoRef | null = null;
  /** Bumped by close and open; a late landing is dropped when its captured value is stale. */
  let generation = 0;
  /** bindingKey → {threadId, participantId}: one stable key per native SessionRef. */
  const sessionIndex = new Map<string, ThreadSessionResolution>();

  function isCurrent(entered: number): boolean {
    return entered === generation;
  }

  /**
   * Resolve a candidate session against the CURRENT thread without touching the
   * selection. The locate action validates with this BEFORE it writes, so a session
   * the thread does not hold can never reach `selectedSession` at all.
   */
  function resolveSessionForCurrentThread(session: SessionRef | null): ThreadSessionResolution | null {
    const currentThreadId = threadId.value;
    if (session === null || currentThreadId === null) return null;
    const resolution = sessionIndex.get(threadBindingKey(session));
    return resolution !== undefined && resolution.threadId === currentThreadId ? resolution : null;
  }

  const selectedSessionResolution = computed<ThreadSessionResolution | null>(() =>
    resolveSessionForCurrentThread(selectedSession.value),
  );

  function syncTimeline(): void {
    timelinePage.value = timeline.page({ limit: TIMELINE_PAGE_LIMIT });
  }

  /** Snapshot the frozen read model at the moment of observation — never hold a live record. */
  function syncThread(id: string): void {
    const next = ports.thread.get(id);
    summary.value = next;
    threadId.value = id;
  }

  function indexSession(resolution: ThreadSessionResolution, session: SessionRef): void {
    sessionIndex.set(threadBindingKey(session), resolution);
  }

  function fail(message: string): void {
    error.value = message;
  }

  async function openThread(input: { session: SessionRef; repo: RepoRef }): Promise<void> {
    generation += 1;
    const entered = generation;
    busy.value = true;
    error.value = '';
    try {
      const thread = await ports.thread.bind({ session: input.session, repo: input.repo });
      if (!isCurrent(entered)) return;
      repo = input.repo;
      syncThread(thread.threadId);
      // Every participant is indexed by its OWN native session: a thread reached from a joined
      // session must resolve that participant, never the owner the wrapper happened to start with.
      const summaryNow = summary.value;
      if (summaryNow !== null) {
        const openedBinding = threadBindingKey(input.session);
        for (const participant of summaryNow.participants) {
          indexSession({ threadId: thread.threadId, participantId: participant.participantId }, participant.session);
        }
        const opened = summaryNow.participants.find(
          (participant) => threadBindingKey(participant.session) === openedBinding,
        );
        if (opened !== undefined) {
          indexSession({ threadId: thread.threadId, participantId: opened.participantId }, input.session);
        }
      }
      targets.value = [];
      handoff.value = restoreHandoff(thread.threadId);
      handoffOps.value = handoff.value === null ? [] : (ports.handoff?.ops(handoff.value.handoffId) ?? []);
      syncTimeline();
    } catch (openError) {
      if (!isCurrent(entered)) return;
      threadId.value = null;
      summary.value = null;
      fail(readableError(openError, 'The thread could not be opened for this session'));
    } finally {
      if (isCurrent(entered)) busy.value = false;
    }
  }

  /** The thread's live handoff, or null: a DECIDED record is history and is never restored. */
  function restoreHandoff(id: string): RuntimeHandoffView | null {
    const live = ports.handoff?.handoffs().find((entry) => entry.threadId === id && !RESOLVED_HANDOFF_STATES.has(entry.state));
    return live ?? null;
  }

  async function joinThread(session: SessionRef): Promise<void> {
    const id = threadId.value;
    const currentRepo = repo;
    if (id === null || currentRepo === null) {
      fail('There is no open thread to join. Open a thread first.');
      return;
    }
    // A second window (or a re-opened thread) meets a session that is ALREADY a participant: the
    // service refuses the duplicate join, and that refusal is not an error here — the frozen read
    // model already carries the participant, so it is indexed and the UI settles.
    const binding = threadBindingKey(session);
    const existing = summary.value?.participants.find(
      (participant) => threadBindingKey(participant.session) === binding,
    );
    if (existing !== undefined) {
      indexSession({ threadId: id, participantId: existing.participantId }, session);
      return;
    }
    busy.value = true;
    error.value = '';
    const entered = generation;
    try {
      const participant = await ports.thread.join({ threadId: id, session, repo: currentRepo });
      if (!isCurrent(entered)) return;
      indexSession({ threadId: id, participantId: participant.participantId }, session);
      syncThread(id);
      syncTimeline();
    } catch (joinError) {
      if (!isCurrent(entered)) return;
      fail(readableError(joinError, `Session "${session.nativeSessionId}" could not be joined`));
    } finally {
      if (isCurrent(entered)) busy.value = false;
    }
  }

  async function leaveParticipant(participantId: string): Promise<void> {
    const id = threadId.value;
    if (id === null) return;
    busy.value = true;
    error.value = '';
    const entered = generation;
    try {
      ports.thread.leave({ threadId: id, participantId });
      if (!isCurrent(entered)) return;
      syncThread(id);
      syncTimeline();
    } catch (leaveError) {
      if (isCurrent(entered)) fail(readableError(leaveError, 'The participant could not be removed'));
    } finally {
      if (isCurrent(entered)) busy.value = false;
    }
  }

  async function resumeParticipant(participantId: string): Promise<void> {
    const id = threadId.value;
    if (id === null) return;
    busy.value = true;
    error.value = '';
    const entered = generation;
    try {
      await ports.thread.resume({ threadId: id, participantId });
      if (!isCurrent(entered)) return;
      syncThread(id);
      syncTimeline();
    } catch (resumeError) {
      if (isCurrent(entered)) fail(readableError(resumeError, 'The participant could not be resumed'));
    } finally {
      if (isCurrent(entered)) busy.value = false;
    }
  }

  async function activateParticipant(participantId: string): Promise<void> {
    const id = threadId.value;
    if (id === null) return;
    busy.value = true;
    error.value = '';
    const entered = generation;
    try {
      ports.thread.activate({ threadId: id, participantId });
      if (!isCurrent(entered)) return;
      syncThread(id);
      syncTimeline();
    } catch (activateError) {
      if (isCurrent(entered)) fail(readableError(activateError, 'The participant could not be activated'));
    } finally {
      busy.value = false;
    }
  }

  function setTarget(participantId: string): void {
    const current = summary.value;
    if (current === null) return;
    if (!current.participants.some((participant) => participant.participantId === participantId)) {
      fail('That participant is not part of this thread.');
      return;
    }
    error.value = '';
    targets.value = Object.freeze([participantId]);
  }

  function clearTarget(): void {
    targets.value = Object.freeze([]);
  }

  function setSelectedSession(session: SessionRef | null): void {
    selectedSession.value = session;
  }

  /**
   * Locate a native session THROUGH this thread — the complete qualified selection.
   *
   * Writing the ref alone left Locate inert: no container consumed
   * `selectedSession`, so the real session tree never moved. The action therefore
   * writes the selection AND answers the resolution the container drives the real
   * tree selection with — `null` when the session is not a participant of the
   * CURRENT thread, so a locate can never point the tree at a session the open
   * thread does not hold.
   *
   * The resolution is validated BEFORE the selection is written. Writing first and
   * answering null afterwards did not stop the container: its watcher fires on the
   * write and reads the NATIVE id alone, so a locate that resolved to nothing still
   * moved the real tree onto whatever same-named session the current target happens
   * to hold. A session the thread does not hold must therefore never reach
   * `selectedSession` at all, not merely resolve to null there.
   */
  function locateSession(session: SessionRef | null): ThreadSessionResolution | null {
    if (session !== null && resolveSessionForCurrentThread(session) === null) return null;
    selectedSession.value = session;
    return selectedSessionResolution.value;
  }

  function requireHandoffPort(): RuntimeHandoffPort | null {
    const port = ports.handoff ?? null;
    if (port === null) {
      fail('The handoff service is not wired to this surface yet.');
      return null;
    }
    return port;
  }

  async function beginHandoff(input: {
    sourceParticipantId: string;
    targetParticipantId: string;
    prompt: string;
    entries?: readonly unknown[];
  }): Promise<void> {
    const id = threadId.value;
    const port = requireHandoffPort();
    if (id === null || port === null) return;
    if (input.sourceParticipantId === input.targetParticipantId) {
      fail('A handoff needs two different participants: the source and the target must differ.');
      return;
    }
    if (input.prompt.trim().length === 0) {
      fail('A handoff carries the current prompt; write it before handing off.');
      return;
    }
    // The checkpoint is the carried context: the UI never fabricates one.
    if (input.entries === undefined || input.entries.length === 0) {
      fail('A handoff carries a bounded context checkpoint; no context entries are available to carry.');
      return;
    }
    const existing = handoff.value;
    // A DECIDED record is history: it is kept on the service and may be inspected, but it never
    // blocks a new handoff. Only live work — including an unresolved `reconcile` — does.
    if (existing !== null && !RESOLVED_HANDOFF_STATES.has(existing.state)) {
      fail(`This thread already has a handoff at "${existing.state}". Resolve or cancel it before starting another.`);
      return;
    }
    busy.value = true;
    error.value = '';
    const entered = generation;
    try {
      // begin mints or carries the bounded context checkpoint; attach binds the target's OWN
      // native session. Both go through the real service, so the ladder order is enforced there.
      const begun = await port.begin({
        threadId: id,
        sourceParticipantId: input.sourceParticipantId,
        targetParticipantId: input.targetParticipantId,
        ...(input.entries === undefined ? {} : { entries: input.entries }),
      });
      if (!isCurrent(entered)) return;
      handoff.value = begun;
      const attached = await port.attach({ handoffId: begun.handoffId });
      if (!isCurrent(entered)) return;
      handoff.value = attached;
      handoffOps.value = port.ops(attached.handoffId);
      syncThread(id);
      syncTimeline();
    } catch (beginError) {
      if (isCurrent(entered)) fail(readableError(beginError, 'The handoff could not be started'));
    } finally {
      if (isCurrent(entered)) busy.value = false;
    }
  }

  async function prepareHandoff(prompt: string): Promise<void> {
    const port = requireHandoffPort();
    const current = handoff.value;
    if (port === null || current === null) return;
    if (current.state !== 'attached') {
      fail(`The handoff is at "${current.state}"; it can only be prepared from "attached".`);
      return;
    }
    busy.value = true;
    error.value = '';
    const entered = generation;
    try {
      const prepared = await port.prepare({ handoffId: current.handoffId, prompt });
      if (!isCurrent(entered)) return;
      handoff.value = prepared;
      handoffOps.value = port.ops(prepared.handoffId);
      syncTimeline();
    } catch (prepareError) {
      if (isCurrent(entered)) fail(readableError(prepareError, 'The handoff prompt could not be prepared'));
    } finally {
      if (isCurrent(entered)) busy.value = false;
    }
  }

  async function deliverHandoff(): Promise<void> {
    const port = requireHandoffPort();
    const current = handoff.value;
    if (port === null || current === null) return;
    if (current.state !== 'prepared') {
      fail(`The handoff is at "${current.state}"; it can only be delivered from "prepared".`);
      return;
    }
    busy.value = true;
    error.value = '';
    const entered = generation;
    try {
      const delivered = await port.deliver({ handoffId: current.handoffId });
      if (!isCurrent(entered)) return;
      handoff.value = delivered;
      handoffOps.value = port.ops(delivered.handoffId);
      syncTimeline();
    } catch (deliverError) {
      // An ambiguous send stops at reconcile: never retried, never marked successful.
      if (!isCurrent(entered)) return;
      fail(readableError(deliverError, 'The handoff could not be delivered'));
      if (current.handoffId !== '') {
        handoff.value = port.handoff(current.handoffId);
        handoffOps.value = port.ops(current.handoffId);
      }
    } finally {
      if (isCurrent(entered)) busy.value = false;
    }
  }

  async function observeHandoff(nativeEventId: string): Promise<void> {
    const port = requireHandoffPort();
    const current = handoff.value;
    if (port === null || current === null) return;
    if (nativeEventId.trim().length === 0) {
      fail('A handoff becomes active only through a real native observation, which carries its own native event id.');
      return;
    }
    if (current.state !== 'delivered') {
      fail(`The handoff is at "${current.state}"; only a delivered handoff can be observed.`);
      return;
    }
    busy.value = true;
    error.value = '';
    const entered = generation;
    try {
      const observed = await port.observe({ handoffId: current.handoffId, nativeEventId });
      if (!isCurrent(entered)) return;
      handoff.value = observed;
      handoffOps.value = port.ops(observed.handoffId);
      syncThread(observed.threadId);
      syncTimeline();
    } catch (observeError) {
      if (isCurrent(entered)) fail(readableError(observeError, 'The native observation could not be recorded'));
    } finally {
      if (isCurrent(entered)) busy.value = false;
    }
  }

  async function cancelHandoff(reason?: string): Promise<void> {
    const port = requireHandoffPort();
    const current = handoff.value;
    if (port === null || current === null) return;
    if (current.state === 'active') {
      fail('A completed handoff cannot be cancelled.');
      return;
    }
    busy.value = true;
    error.value = '';
    const entered = generation;
    try {
      const cancelled = await port.cancel({
        handoffId: current.handoffId,
        ...(reason === undefined ? {} : { reason }),
      });
      if (!isCurrent(entered)) return;
      handoff.value = cancelled;
      handoffOps.value = port.ops(cancelled.handoffId);
      syncThread(cancelled.threadId);
      syncTimeline();
    } catch (cancelError) {
      if (isCurrent(entered)) fail(readableError(cancelError, 'The handoff could not be cancelled'));
    } finally {
      if (isCurrent(entered)) busy.value = false;
    }
  }

  function sessionOfParticipant(participantId: string): SessionRef | null {
    const participant = summary.value?.participants.find((entry) => entry.participantId === participantId);
    return participant?.session ?? null;
  }

  function threadForSession(session: SessionRef): ThreadSessionResolution | null {
    return sessionIndex.get(threadBindingKey(session)) ?? null;
  }

  function closeThread(): void {
    generation += 1;
    threadId.value = null;
    summary.value = null;
    targets.value = Object.freeze([]);
    handoff.value = null;
    handoffOps.value = [];
    selectedSession.value = null;
    timelinePage.value = null;
    repo = null;
    sessionIndex.clear();
  }

  return {
    available: true,
    threadId,
    summary,
    targets,
    effectiveTargets,
    handoff,
    handoffOps,
    selectedSession,
    busy,
    error,
    timelinePage,
    selectedSessionResolution,
    openThread,
    joinThread,
    leaveParticipant,
    resumeParticipant,
    activateParticipant,
    setTarget,
    clearTarget,
    setSelectedSession,
    locateSession,
    beginHandoff,
    prepareHandoff,
    deliverHandoff,
    observeHandoff,
    cancelHandoff,
    sessionOfParticipant,
    threadForSession,
    closeThread,
  };
}

/**
 * Injection key a container provides so the composer and the output panel can host the thread
 * surfaces. Absent → both keep their legacy behaviour exactly.
 */
export const RUNTIME_THREAD_STATE_KEY: InjectionKey<RuntimeThreadState | null> = Symbol('vis.runtime.threadState');

/** Resolve the optional thread state; null when no container provides one. */
export function useRuntimeThreadState(): RuntimeThreadState | null {
  return inject(RUNTIME_THREAD_STATE_KEY, null);
}

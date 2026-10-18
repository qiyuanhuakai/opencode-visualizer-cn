// @vitest-environment node
//
// Task 34 — the observable, recoverable cross-harness handoff.
//
// Product under test: bridge/runtime/threads/handoffService.js (the ladder, the journal, the
// three sinks) and bridge/runtime/threads/handoffRecovery.js (return to the original participant
// selection, the reconcile stop). Both consume task 31's createThreadService and task 33's
// createCheckpointService; neither is modified here.
//
// The two bridge modules under test are loaded through createRequire rather than a static
// import: every other bridge module a .ts file imports ships a sibling .d.ts (threadService,
// participantService, the shared contracts), but this task's grant is exactly three new paths
// and none of them is a declaration file. A static import of a .d.ts-less bridge module is
// TS7016 under the repo's strict vue-tsc gate — reproduced on turnService.js, which also has no
// sibling. The contracts below are therefore declared here, in the test, and the require
// boundary is the only untyped edge. checkpointService.js (task 33, consumed read-only) has no
// .d.ts either and is loaded the same way.
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { createThreadService } from '../../bridge/runtime/threads/threadService.js';
import type { ParticipantRecord } from '../../bridge/runtime/threads/participantService.js';
import {
  parseEnvironmentId,
  parseHarnessInstanceId,
  parseRepoRef,
  parseSessionRef,
} from '../../shared/runtime/identity.js';
import type { RepoRef, SessionRef } from '../../shared/runtime/identity.js';
import type { ThreadRecord, ThreadService } from '../../bridge/runtime/threads/threadService.js';
import type { ThreadSessionView } from '../../shared/runtime/thread.js';

/* ------------------------------------------------------------------ contracts */

interface DeliverySlice {
  delivered: boolean;
  deliveredAt: number | null;
  deliveredBy: string | null;
}
interface ObservationSlice {
  observed: boolean;
  observedAt: number | null;
  observedBy: string | null;
}
interface HostSlice {
  checkpoint: unknown;
  attachedAt: number | null;
  preparedAt: number | null;
  promptFingerprint: string | null;
  cancelledAt: number | null;
  failedAt: number | null;
  reconcileAt: number | null;
}
interface ResolutionSlot {
  value: HandoffResolutionView | null;
}

/** The ack sink: the ONLY sink that may write `delivered`. It has no member that reaches observed or active. */
interface AckSink {
  deliver(input: { readonly ackId: string; readonly at?: number }): { readonly applied: boolean; readonly duplicate: boolean };
}
/** The native observation sink: the ONLY sink that may write `observed` (and therefore `active`). */
interface ObserveSink {
  observe(input: { readonly nativeEventId: string; readonly at?: number }): { readonly applied: boolean; readonly duplicate: boolean };
}
/** The Host sink: checkpoint/attach/prepare/cancel/fail/reconcile — and nothing on the native side. */
interface HostSink {
  checkpoint(input: { readonly checkpoint: unknown; readonly at?: number }): void;
  attach(input: { readonly at?: number }): void;
  prepare(input: { readonly promptFingerprint: string; readonly at?: number }): void;
  cancel(input: { readonly code: string; readonly field: string; readonly reason?: string | null; readonly at?: number }): void;
  fail(input: { readonly code: string; readonly field: string; readonly reason?: string | null; readonly at?: number }): void;
  reconcile(input: { readonly code: string; readonly field: string; readonly reason?: string | null; readonly at?: number }): void;
}

interface HandoffCheckpointView {
  readonly checkpointId: string;
  readonly digest: string;
  readonly bytes: number;
  readonly entryCount: number;
}
interface HandoffResolutionView {
  readonly resolution: 'reconcile' | 'failed' | 'cancelled';
  readonly code: string;
  readonly field: string;
  readonly reason: string | null;
  readonly at: number;
}
interface HandoffView {
  readonly handoffId: string;
  readonly threadId: string;
  readonly environmentId: string;
  readonly state: string;
  readonly active: boolean;
  readonly source: { readonly participantId: string; readonly session: SessionRef };
  readonly target: { readonly participantId: string; readonly session: SessionRef };
  readonly originalParticipantId: string;
  readonly checkpoint: HandoffCheckpointView | null;
  readonly promptFingerprint: string | null;
  readonly delivered: boolean;
  readonly deliveredAt: number | null;
  readonly deliveredBy: string | null;
  readonly observed: boolean;
  readonly observedAt: number | null;
  readonly observedBy: string | null;
  readonly resolution: HandoffResolutionView | null;
  readonly sends: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}
interface HandoffOpView {
  readonly opId: string;
  readonly handoffId: string;
  readonly kind: string;
  readonly fingerprint: string;
  readonly at: number;
  readonly applied: boolean;
  readonly duplicate: boolean;
  readonly outcome: string;
  readonly code: string | null;
  readonly field: string | null;
  readonly detail: unknown;
}
interface HandoffErrorLike extends Error {
  readonly code: string;
  readonly field: string;
}
interface HandoffTarget {
  readonly participantId: string;
  readonly session: SessionRef;
}
interface OpenTargetInput {
  readonly threadId: string;
  readonly handoffId: string;
  readonly target: HandoffTarget;
}
interface SendPromptInput {
  readonly threadId: string;
  readonly handoffId: string;
  readonly target: HandoffTarget;
  readonly prompt: string;
  readonly promptFingerprint: string;
}
type SendPromptResult = { readonly ackId: string } | { readonly ambiguous: true };
interface HandoffServiceOptions {
  readonly threads: ThreadService;
  readonly checkpoints: CheckpointServiceLike;
  readonly openTarget: (input: OpenTargetInput) => Promise<{ readonly nativeSessionId: string }>;
  readonly sendPrompt: (input: SendPromptInput) => Promise<SendPromptResult>;
  readonly cancelSource?: (input: { readonly threadId: string; readonly participantId: string }) => Promise<void>;
  readonly isSourceBusy?: (input: { readonly threadId: string; readonly participantId: string }) => boolean;
}
interface HandoffServiceLike {
  begin(input: {
    readonly threadId: string;
    readonly sourceParticipantId: string;
    readonly targetParticipantId: string;
    readonly entries?: readonly unknown[];
    readonly checkpointId?: string;
    readonly handoffId?: string;
    readonly cancel?: boolean;
    readonly at?: number;
  }): Promise<HandoffView>;
  attach(input: { readonly handoffId: string; readonly at?: number }): Promise<HandoffView>;
  prepare(input: { readonly handoffId: string; readonly prompt: string; readonly at?: number }): Promise<HandoffView>;
  deliver(input: { readonly handoffId: string; readonly at?: number }): Promise<HandoffView>;
  observe(input: { readonly handoffId: string; readonly nativeEventId: string; readonly at?: number }): Promise<HandoffView>;
  cancel(input: { readonly handoffId: string; readonly reason?: string | null; readonly at?: number }): Promise<HandoffView>;
  resolve(input: {
    readonly handoffId: string;
    readonly resolution: 'reconcile' | 'failed' | 'cancelled';
    readonly code: string;
    readonly field: string;
    readonly reason?: string | null;
    readonly at?: number;
  }): HandoffView;
  handoff(handoffId: string): HandoffView;
  handoffs(): readonly HandoffView[];
  ops(handoffId: string): readonly HandoffOpView[];
  close(): void;
  readonly state: {
    readonly handoffs: number;
    readonly ops: number;
    readonly applied: number;
    readonly duplicates: number;
    readonly sends: number;
    readonly reconciles: number;
    readonly failures: number;
    readonly closed: boolean;
  };
}
interface CheckpointServiceLike {
  create(input: {
    readonly checkpointId?: string;
    readonly scope: { readonly threadId: string; readonly environmentId: string };
    readonly entries: readonly unknown[];
    readonly at?: number;
  }): CheckpointModel;
  get(checkpointId: string): CheckpointModel;
}
interface CheckpointModel {
  readonly checkpointId: string;
  readonly digest: string;
  readonly bytes: number;
  readonly entryCount: number;
  readonly redactions: number;
  readonly scope: { readonly threadId: string; readonly environmentId: string };
}
interface CheckpointModule {
  createCheckpointService(): CheckpointServiceLike;
}
interface HandoffModule {
  readonly HandoffError: new (code: string, field: string) => HandoffErrorLike;
  readonly HANDOFF_LADDER: readonly string[];
  readonly HANDOFF_STATES: readonly string[];
  createAckSink(scope: { readonly delivery: DeliverySlice }): AckSink;
  createObserveSink(scope: { readonly observation: ObservationSlice }): ObserveSink;
  createHostSink(scope: { readonly host: HostSlice; readonly resolution: ResolutionSlot }): HostSink;
  createHandoffService(options: HandoffServiceOptions): HandoffServiceLike;
}

/* ------------------------------------------------------------------ fixtures */

const ENV_A = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const HARNESS_A = parseHarnessInstanceId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const HARNESS_B = parseHarnessInstanceId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
const REPO: RepoRef = parseRepoRef({
  environmentId: ENV_A,
  canonicalCommonDir: '/srv/repo',
  pathPolicy: { platform: 'posix', volumeId: 'vol-1', caseSensitive: true },
});
const SESSION_A: SessionRef = parseSessionRef({
  environmentId: ENV_A,
  harnessInstanceId: HARNESS_A,
  nativeSessionId: 'native:codex-1',
});
const SESSION_B: SessionRef = parseSessionRef({
  environmentId: ENV_A,
  harnessInstanceId: HARNESS_B,
  nativeSessionId: 'native:acp-1',
});

const CONTEXT_ENTRIES: readonly unknown[] = Object.freeze([
  { class: 'goal', origin: { kind: 'host', commandId: 'handoff-test' }, text: 'continue the runtime migration across harnesses' },
  { class: 'decision', origin: { kind: 'host', commandId: 'handoff-test' }, text: 'keep each native session binding intact' },
]);
const SECRET_ENTRIES: readonly unknown[] = Object.freeze([
  { class: 'goal', origin: { kind: 'host', commandId: 'handoff-test' }, text: 'rotate the bridge token sk-abcdef1234567890abcdefghij' },
]);
const PROMPT = 'continue the migration on the ACP harness';

const require = createRequire(import.meta.url);

function loadCheckpoints(): CheckpointModule {
  // checkpointService.js (task 33) exists and loads through the same require boundary.
  return require('../../bridge/runtime/threads/checkpointService.js') as CheckpointModule;
}

function loadHandoff(): HandoffModule {
  return require('../../bridge/runtime/threads/handoffService.js') as HandoffModule;
}

function loadRecovery(): RecoveryModule {
  return require('../../bridge/runtime/threads/handoffRecovery.js') as RecoveryModule;
}

interface RecoveryOutcomeView {
  readonly handoffId: string;
  readonly action: string;
  readonly reason: string | null;
  readonly state: string;
  readonly restoredParticipantId: string;
  readonly sendAttempted: boolean;
  readonly observed: boolean;
}
interface RecoveryModule {
  recoverHandoff(input: {
    readonly service: HandoffServiceLike;
    readonly threads: ThreadService;
    readonly handoffId: string;
    readonly action?: 'auto' | 'rollback' | 'reconcile';
  }): RecoveryOutcomeView;
  restoreOriginalSelection(input: {
    readonly threads: ThreadService;
    readonly threadId: string;
    readonly participantId: string;
  }): { readonly participantId: string; readonly revision: number };
  handoffRecoveryDecision(input: {
    readonly record: HandoffView;
    readonly ops: readonly HandoffOpView[];
  }): { readonly action: string; readonly reason: string | null; readonly sendAttempted: boolean };
}

interface HarnessFixture {
  readonly threads: ThreadService;
  readonly thread: ThreadRecord;
  readonly participantA: string;
  readonly participantB: string;
  readonly checkpoints: CheckpointServiceLike;
  readonly calls: { readonly openTarget: () => number; readonly sendPrompt: () => number; readonly cancelSource: () => number };
  readonly service: HandoffServiceLike;
  readonly catalogSize: () => number;
}

interface WorldOverrides {
  readonly sourceBusy?: boolean;
  readonly openTarget?: (input: OpenTargetInput) => Promise<{ readonly nativeSessionId: string }>;
  readonly sendPrompt?: (input: SendPromptInput) => Promise<SendPromptResult>;
  readonly cancelSource?: (input: { readonly threadId: string; readonly participantId: string }) => Promise<void>;
}

function sessionView(session: SessionRef): ThreadSessionView {
  return { session, archived: false, parentSession: null };
}

async function makeWorld(overrides: WorldOverrides = {}): Promise<HarnessFixture> {
  const catalog = new Map<string, ThreadSessionView>([
    [`${SESSION_A.environmentId}|${SESSION_A.harnessInstanceId}|${SESSION_A.nativeSessionId}`, sessionView(SESSION_A)],
    [`${SESSION_B.environmentId}|${SESSION_B.harnessInstanceId}|${SESSION_B.nativeSessionId}`, sessionView(SESSION_B)],
  ]);
  const resolveSession = async (session: SessionRef): Promise<ThreadSessionView | null> =>
    catalog.get(`${session.environmentId}|${session.harnessInstanceId}|${session.nativeSessionId}`) ?? null;
  const threads: ThreadService = createThreadService({ resolveSession });
  const thread: ThreadRecord = await threads.bind({ session: SESSION_A, repo: REPO });
  const owner = thread.participants[0];
  if (owner === undefined) throw new Error('thread has no owner participant');
  const joinedB: ParticipantRecord = await threads.join({ threadId: thread.threadId, session: SESSION_B, repo: REPO });

  const counters = { openTarget: 0, sendPrompt: 0, cancelSource: 0 };
  const openTargetBehavior = overrides.openTarget
    ?? (async ({ target }: OpenTargetInput) => ({ nativeSessionId: target.session.nativeSessionId }));
  const openTarget = async (input: OpenTargetInput): Promise<{ nativeSessionId: string }> => {
    counters.openTarget += 1;
    return openTargetBehavior(input);
  };
  const sendPromptBehavior = overrides.sendPrompt
    ?? (async () => ({ ackId: `ack-${counters.sendPrompt + 1}` }));
  const sendPrompt = async (input: SendPromptInput): Promise<SendPromptResult> => {
    counters.sendPrompt += 1;
    return sendPromptBehavior(input);
  };
  const cancelSourceBehavior = overrides.cancelSource ?? (async (): Promise<void> => {});
  const cancelSource = async (input: { readonly threadId: string; readonly participantId: string }): Promise<void> => {
    counters.cancelSource += 1;
    return cancelSourceBehavior(input);
  };

  const checkpoints = loadCheckpoints().createCheckpointService();
  const service = loadHandoff().createHandoffService({
    threads,
    checkpoints,
    openTarget,
    sendPrompt,
    cancelSource,
    isSourceBusy: () => overrides.sourceBusy === true,
  });
  return {
    threads,
    thread,
    participantA: owner.participantId,
    participantB: joinedB.participantId,
    checkpoints,
    calls: {
      openTarget: () => counters.openTarget,
      sendPrompt: () => counters.sendPrompt,
      cancelSource: () => counters.cancelSource,
    },
    service,
    catalogSize: () => catalog.size,
  };
}

function rejectionOf(run: () => unknown): { code: string | null; field: string | null } {
  try {
    run();
    return { code: null, field: null };
  } catch (error) {
    const typed = error as { code?: unknown; field?: unknown };
    return {
      code: typeof typed.code === 'string' ? typed.code : null,
      field: typeof typed.field === 'string' ? typed.field : null,
    };
  }
}

async function driveToPrepared(world: HarnessFixture, handoffId: string): Promise<HandoffView> {
  await world.service.attach({ handoffId });
  return world.service.prepare({ handoffId, prompt: PROMPT });
}

/* ------------------------------------------------------------------ the ladder */

describe('handoff state ladder', () => {
  it('walks checkpoint → attached → prepared → delivered → observed → active on observed values', async () => {
    const world = await makeWorld();
    const begun = await world.service.begin({
      threadId: world.thread.threadId,
      sourceParticipantId: world.participantA,
      targetParticipantId: world.participantB,
      entries: CONTEXT_ENTRIES,
    });
    expect(begun.state).toBe('checkpoint');
    expect(begun.checkpoint?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(begun.source.session).toEqual(SESSION_A);
    expect(begun.target.session).toEqual(SESSION_B);

    const attached = await world.service.attach({ handoffId: begun.handoffId });
    expect(attached.state).toBe('attached');
    expect(world.calls.openTarget()).toBe(1);

    const prepared = await driveToPrepared(world, begun.handoffId);
    expect(prepared.state).toBe('prepared');
    expect(prepared.promptFingerprint).toMatch(/^[a-f0-9]{64}$/);

    const delivered = await world.service.deliver({ handoffId: begun.handoffId });
    expect(delivered.state).toBe('delivered');
    expect(delivered.delivered).toBe(true);
    expect(world.calls.sendPrompt()).toBe(1);

    const active = await world.service.observe({ handoffId: begun.handoffId, nativeEventId: 'evt-acp-1' });
    expect(active.state).toBe('active');
    expect(active.observed).toBe(true);
    expect(active.active).toBe(true);
    expect(world.threads.active(world.thread.threadId)?.participantId).toBe(world.participantB);
  });

  it('exposes the plan ladder as a fixed ordered table', () => {
    const module = loadHandoff();
    expect(module.HANDOFF_LADDER).toEqual(['checkpoint', 'attached', 'prepared', 'delivered', 'observed', 'active']);
    expect(module.HANDOFF_STATES).toEqual([...module.HANDOFF_LADDER, 'reconcile', 'failed', 'cancelled']);
  });

  it('native ack only means delivered: the ack sink has no member that can write observed or active', async () => {
    const module = loadHandoff();
    const delivery: DeliverySlice = { delivered: false, deliveredAt: null, deliveredBy: null };
    const ackSink = module.createAckSink({ delivery });
    // The guarantee is structural: the sink OBJECT has no observe member, so no input can reach it.
    expect(Object.keys(ackSink)).toEqual(['deliver']);

    const world = await makeWorld();
    const begun = await world.service.begin({
      threadId: world.thread.threadId,
      sourceParticipantId: world.participantA,
      targetParticipantId: world.participantB,
      entries: CONTEXT_ENTRIES,
    });
    await world.service.attach({ handoffId: begun.handoffId });
    await world.service.prepare({ handoffId: begun.handoffId, prompt: PROMPT });
    // A hostile ack payload that also claims observation and activeness changes nothing.
    const hostileAck = { handoffId: begun.handoffId, observed: true, active: true, state: 'active' };
    const delivered = await world.service.deliver(hostileAck);
    expect(delivered.state).toBe('delivered');
    expect(delivered.delivered).toBe(true);
    expect(delivered.observed).toBe(false);
    expect(delivered.active).toBe(false);
    expect(delivered.observedAt).toBeNull();
    expect(delivered.observedBy).toBeNull();
    // The selection has not moved either: an ack is not an observation.
    expect(world.threads.active(world.thread.threadId)?.participantId).toBe(world.participantA);
  });

  it('the observe sink cannot write delivered and the host sink can write neither', () => {
    const module = loadHandoff();
    const delivery: DeliverySlice = { delivered: false, deliveredAt: null, deliveredBy: null };
    const observation: ObservationSlice = { observed: false, observedAt: null, observedBy: null };
    const observeSink = module.createObserveSink({ observation });
    expect(Object.keys(observeSink)).toEqual(['observe']);

    observeSink.observe({ nativeEventId: 'evt-1', at: 11 });
    expect(observation).toEqual({ observed: true, observedAt: 11, observedBy: 'evt-1' });
    expect(delivery).toEqual({ delivered: false, deliveredAt: null, deliveredBy: null });

    const host: HostSlice = {
      checkpoint: null, attachedAt: null, preparedAt: null, promptFingerprint: null,
      cancelledAt: null, failedAt: null, reconcileAt: null,
    };
    const resolution: ResolutionSlot = { value: null };
    const hostSink = module.createHostSink({ host, resolution });
    expect(Object.keys(hostSink)).toEqual(['checkpoint', 'attach', 'prepare', 'cancel', 'fail', 'reconcile']);
    hostSink.checkpoint({ checkpoint: { digest: 'd' }, at: 1 });
    hostSink.attach({ at: 2 });
    hostSink.prepare({ promptFingerprint: 'f', at: 3 });
    hostSink.fail({ code: 'conflict', field: 'x', reason: 'r', at: 4 });
    expect(host.attachedAt).toBe(2);
    expect(host.preparedAt).toBe(3);
    expect(resolution.value).toMatchObject({ resolution: 'failed', code: 'conflict', field: 'x', reason: 'r', at: 4 });
    // The Host sink drove every member it has and still touched nothing on the native side.
    expect(delivery).toEqual({ delivered: false, deliveredAt: null, deliveredBy: null });
    expect(observation).toEqual({ observed: true, observedAt: 11, observedBy: 'evt-1' });
  });

  it('the UI sees active only after a real native observed, never on a native ack', async () => {
    const world = await makeWorld();
    const begun = await world.service.begin({
      threadId: world.thread.threadId,
      sourceParticipantId: world.participantA,
      targetParticipantId: world.participantB,
      entries: CONTEXT_ENTRIES,
    });
    await world.service.attach({ handoffId: begun.handoffId });
    await world.service.prepare({ handoffId: begun.handoffId, prompt: PROMPT });
    const afterAck = await world.service.deliver({ handoffId: begun.handoffId });
    expect(afterAck.state).toBe('delivered');
    expect(afterAck.active).toBe(false);
    const afterObserved = await world.service.observe({ handoffId: begun.handoffId, nativeEventId: 'evt-acp-2' });
    expect(afterObserved.state).toBe('active');
    expect(afterObserved.active).toBe(true);
  });

  it('A→B→A preserves the native session identities and the context hash', async () => {
    const world = await makeWorld();
    const before = world.threads.history(world.thread.threadId).participants.map((entry) => entry.session);

    const first = await world.service.begin({
      threadId: world.thread.threadId,
      sourceParticipantId: world.participantA,
      targetParticipantId: world.participantB,
      entries: CONTEXT_ENTRIES,
    });
    const carriedDigest = first.checkpoint?.digest ?? '';
    await world.service.attach({ handoffId: first.handoffId });
    await world.service.prepare({ handoffId: first.handoffId, prompt: PROMPT });
    await world.service.deliver({ handoffId: first.handoffId });
    const firstActive = await world.service.observe({ handoffId: first.handoffId, nativeEventId: 'evt-acp-a' });
    expect(firstActive.state).toBe('active');
    expect(world.threads.active(world.thread.threadId)?.participantId).toBe(world.participantB);

    // The return leg carries the SAME checkpoint id; the context hash must survive the round trip.
    const second = await world.service.begin({
      threadId: world.thread.threadId,
      sourceParticipantId: world.participantB,
      targetParticipantId: world.participantA,
      entries: CONTEXT_ENTRIES,
      checkpointId: first.checkpoint?.checkpointId,
    });
    expect(second.checkpoint?.digest).toBe(carriedDigest);
    await world.service.attach({ handoffId: second.handoffId });
    await world.service.prepare({ handoffId: second.handoffId, prompt: PROMPT });
    await world.service.deliver({ handoffId: second.handoffId });
    const secondActive = await world.service.observe({ handoffId: second.handoffId, nativeEventId: 'evt-codex-a' });
    expect(secondActive.state).toBe('active');
    expect(world.threads.active(world.thread.threadId)?.participantId).toBe(world.participantA);

    // Observed native session identities: unchanged, in order, on both participants.
    const after = world.threads.history(world.thread.threadId).participants.map((entry) => entry.session);
    expect(after).toEqual(before);
    expect(after).toEqual([SESSION_A, SESSION_B]);
    // The source binding is retained through the handoff: nobody left, nothing was re-created.
    const participants = world.threads.get(world.thread.threadId).participants;
    expect(participants).toHaveLength(2);
    expect(participants.every((entry) => entry.state === 'active')).toBe(true);
    expect(second.source.session).toEqual(SESSION_B);
    expect(second.target.session).toEqual(SESSION_A);
    // Observed context hash: the very checkpoint object the first leg carried.
    expect(world.checkpoints.get(first.checkpoint?.checkpointId ?? '').digest).toBe(carriedDigest);
    expect(world.catalogSize()).toBe(2);
    // Each leg sent exactly one prompt.
    expect(firstActive.sends).toBe(1);
    expect(secondActive.sends).toBe(1);
    expect(world.calls.sendPrompt()).toBe(2);
  });

  it('refuses to rewrite a carried context hash with different entries', async () => {
    const world = await makeWorld();
    const first = await world.service.begin({
      threadId: world.thread.threadId,
      sourceParticipantId: world.participantA,
      targetParticipantId: world.participantB,
      entries: CONTEXT_ENTRIES,
    });
    await expect(
      world.service.begin({
        threadId: world.thread.threadId,
        sourceParticipantId: world.participantB,
        targetParticipantId: world.participantA,
        entries: [{ class: 'goal', origin: { kind: 'host', commandId: 'handoff-test' }, text: 'a different goal entirely' }],
        checkpointId: first.checkpoint?.checkpointId,
      }),
    ).rejects.toMatchObject({ code: 'conflict', field: 'handoff_checkpoint' });
    expect(world.service.handoff(first.handoffId).checkpoint?.digest).toBe(first.checkpoint?.digest);
  });

  it('carries a checkpoint whose secrets are redacted at the entry boundary', async () => {
    const world = await makeWorld();
    const begun = await world.service.begin({
      threadId: world.thread.threadId,
      sourceParticipantId: world.participantA,
      targetParticipantId: world.participantB,
      entries: SECRET_ENTRIES,
    });
    const carried = world.checkpoints.get(begun.checkpoint?.checkpointId ?? '');
    expect(carried.redactions).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(carried)).not.toContain('sk-abcdef1234567890abcdefghij');
    expect(JSON.stringify(carried)).toContain('[redacted]');
  });
});

/* ------------------------------------------------------------------ failures */

describe('handoff failure classes', () => {
  it('a failed target open loses neither the thread nor the prompt (send count 0, original selection)', async () => {
    const failure = loadHandoff().HandoffError;
    const world = await makeWorld({
      openTarget: async () => {
        throw new failure('source_unavailable', 'handoff_target_open');
      },
    });
    const begun = await world.service.begin({
      threadId: world.thread.threadId,
      sourceParticipantId: world.participantA,
      targetParticipantId: world.participantB,
      entries: CONTEXT_ENTRIES,
    });
    await expect(world.service.attach({ handoffId: begun.handoffId })).rejects.toMatchObject({
      code: 'source_unavailable',
      field: 'handoff_target_open',
    });
    const failed = world.service.handoff(begun.handoffId);
    expect(failed.state).toBe('failed');
    expect(failed.resolution).toMatchObject({ resolution: 'failed', code: 'source_unavailable', field: 'handoff_target_open' });
    // The thread and both native participants survive untouched.
    expect(world.threads.get(world.thread.threadId).participants).toHaveLength(2);
    expect(world.threads.active(world.thread.threadId)?.participantId).toBe(world.participantA);
    expect(world.catalogSize()).toBe(2);
    // No prompt was ever prepared or sent.
    expect(world.calls.sendPrompt()).toBe(0);
    expect(failed.promptFingerprint).toBeNull();
  });

  it('a failed send sends exactly one prompt and never duplicates it', async () => {
    const failure = loadHandoff().HandoffError;
    let attempts = 0;
    const world = await makeWorld({
      sendPrompt: async () => {
        attempts += 1;
        throw new failure('unauthorized', 'handoff_target_auth');
      },
    });
    const begun = await world.service.begin({
      threadId: world.thread.threadId,
      sourceParticipantId: world.participantA,
      targetParticipantId: world.participantB,
      entries: CONTEXT_ENTRIES,
    });
    await world.service.attach({ handoffId: begun.handoffId });
    await world.service.prepare({ handoffId: begun.handoffId, prompt: PROMPT });
    await expect(world.service.deliver({ handoffId: begun.handoffId })).rejects.toMatchObject({
      code: 'unauthorized',
      field: 'handoff_target_auth',
    });
    const failed = world.service.handoff(begun.handoffId);
    expect(failed.state).toBe('failed');
    // Exactly one send attempt was made — never a second.
    expect(attempts).toBe(1);
    expect(failed.sends).toBe(1);
    expect(world.calls.sendPrompt()).toBe(1);
    // The thread survives with both participants and the original selection.
    expect(world.threads.get(world.thread.threadId).participants).toHaveLength(2);
    expect(world.threads.active(world.thread.threadId)?.participantId).toBe(world.participantA);
    // A re-delivery is refused, not retried.
    await expect(world.service.deliver({ handoffId: begun.handoffId })).rejects.toMatchObject({
      code: 'conflict',
      field: 'handoff_state',
    });
    expect(world.calls.sendPrompt()).toBe(1);
  });

  it('an ambiguous send stops at reconcile and is never retried or marked successful', async () => {
    const world = await makeWorld({ sendPrompt: async () => ({ ambiguous: true }) });
    const begun = await world.service.begin({
      threadId: world.thread.threadId,
      sourceParticipantId: world.participantA,
      targetParticipantId: world.participantB,
      entries: CONTEXT_ENTRIES,
    });
    await world.service.attach({ handoffId: begun.handoffId });
    await world.service.prepare({ handoffId: begun.handoffId, prompt: PROMPT });
    await expect(world.service.deliver({ handoffId: begun.handoffId })).rejects.toMatchObject({
      code: 'reconcile_required',
      field: 'handoff_ambiguous',
    });
    const stopped = world.service.handoff(begun.handoffId);
    expect(stopped.state).toBe('reconcile');
    expect(stopped.active).toBe(false);
    expect(stopped.resolution).toMatchObject({ resolution: 'reconcile', code: 'reconcile_required', field: 'handoff_ambiguous' });
    expect(world.calls.sendPrompt()).toBe(1);
    // The original selection is restored and the handoff goes no further.
    expect(world.threads.active(world.thread.threadId)?.participantId).toBe(world.participantA);
    await expect(world.service.observe({ handoffId: begun.handoffId, nativeEventId: 'evt-late' })).rejects.toMatchObject({
      code: 'conflict',
      field: 'handoff_state',
    });
    await expect(world.service.deliver({ handoffId: begun.handoffId })).rejects.toMatchObject({
      code: 'conflict',
      field: 'handoff_state',
    });
    expect(world.calls.sendPrompt()).toBe(1);
  });

  it('treats an unreadable send outcome as ambiguous instead of assuming delivery', async () => {
    const world = await makeWorld({ sendPrompt: async () => undefined as unknown as { ackId: string } });
    const begun = await world.service.begin({
      threadId: world.thread.threadId,
      sourceParticipantId: world.participantA,
      targetParticipantId: world.participantB,
      entries: CONTEXT_ENTRIES,
    });
    await world.service.attach({ handoffId: begun.handoffId });
    await world.service.prepare({ handoffId: begun.handoffId, prompt: PROMPT });
    await expect(world.service.deliver({ handoffId: begun.handoffId })).rejects.toMatchObject({
      code: 'reconcile_required',
      field: 'handoff_ambiguous',
    });
    expect(world.service.handoff(begun.handoffId).state).toBe('reconcile');
    expect(world.calls.sendPrompt()).toBe(1);
  });

  it('a busy source never auto-migrates without an explicit cancel', async () => {
    const world = await makeWorld({ sourceBusy: true });
    await expect(
      world.service.begin({
        threadId: world.thread.threadId,
        sourceParticipantId: world.participantA,
        targetParticipantId: world.participantB,
        entries: CONTEXT_ENTRIES,
      }),
    ).rejects.toMatchObject({ code: 'conflict', field: 'handoff_source_busy' });
    // No migration was attempted: no handoff record, no attach, no prompt, no cancel.
    expect(world.service.state.handoffs).toBe(0);
    expect(world.service.state.ops).toBe(0);
    expect(world.calls.openTarget()).toBe(0);
    expect(world.calls.sendPrompt()).toBe(0);
    expect(world.calls.cancelSource()).toBe(0);
    expect(world.threads.active(world.thread.threadId)?.participantId).toBe(world.participantA);
    expect(world.threads.get(world.thread.threadId).participants).toHaveLength(2);
  });

  it('a busy source migrates only after an explicit cancel', async () => {
    const world = await makeWorld({ sourceBusy: true });
    const begun = await world.service.begin({
      threadId: world.thread.threadId,
      sourceParticipantId: world.participantA,
      targetParticipantId: world.participantB,
      entries: CONTEXT_ENTRIES,
      cancel: true,
    });
    expect(begun.state).toBe('checkpoint');
    expect(world.calls.cancelSource()).toBe(1);
    await world.service.attach({ handoffId: begun.handoffId });
    await world.service.prepare({ handoffId: begun.handoffId, prompt: PROMPT });
    await world.service.deliver({ handoffId: begun.handoffId });
    const active = await world.service.observe({ handoffId: begun.handoffId, nativeEventId: 'evt-after-cancel' });
    expect(active.state).toBe('active');
    expect(world.threads.active(world.thread.threadId)?.participantId).toBe(world.participantB);
  });

  it('a target attach that binds a different native session is refused', async () => {
    const world = await makeWorld({
      openTarget: async () => ({ nativeSessionId: 'native:someone-else' }),
    });
    const begun = await world.service.begin({
      threadId: world.thread.threadId,
      sourceParticipantId: world.participantA,
      targetParticipantId: world.participantB,
      entries: CONTEXT_ENTRIES,
    });
    await expect(world.service.attach({ handoffId: begun.handoffId })).rejects.toMatchObject({
      code: 'conflict',
      field: 'handoff_target_session',
    });
    expect(world.service.handoff(begun.handoffId).state).toBe('failed');
    expect(world.threads.active(world.thread.threadId)?.participantId).toBe(world.participantA);
    expect(world.calls.sendPrompt()).toBe(0);
  });

  it('wraps a driver error that carries no protocol code instead of throwing it bare', async () => {
    const world = await makeWorld({
      openTarget: async () => {
        throw new Error('socket hung up');
      },
    });
    const begun = await world.service.begin({
      threadId: world.thread.threadId,
      sourceParticipantId: world.participantA,
      targetParticipantId: world.participantB,
      entries: CONTEXT_ENTRIES,
    });
    const error: unknown = await world.service.attach({ handoffId: begun.handoffId }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(loadHandoff().HandoffError);
    expect(error).toMatchObject({ code: 'source_unavailable', field: 'handoff_target_open' });
    expect(world.service.handoff(begun.handoffId).state).toBe('failed');
    expect(world.threads.active(world.thread.threadId)?.participantId).toBe(world.participantA);
  });

  it('an explicit cancel stops an in-flight handoff and restores the original selection', async () => {
    const world = await makeWorld();
    const begun = await world.service.begin({
      threadId: world.thread.threadId,
      sourceParticipantId: world.participantA,
      targetParticipantId: world.participantB,
      entries: CONTEXT_ENTRIES,
    });
    await world.service.attach({ handoffId: begun.handoffId });
    await world.service.prepare({ handoffId: begun.handoffId, prompt: PROMPT });
    const cancelled = await world.service.cancel({ handoffId: begun.handoffId, reason: 'user cancelled' });
    expect(cancelled.state).toBe('cancelled');
    expect(cancelled.resolution).toMatchObject({ resolution: 'cancelled', code: 'cancelled', field: 'handoff_cancelled' });
    expect(world.calls.sendPrompt()).toBe(0);
    expect(world.threads.active(world.thread.threadId)?.participantId).toBe(world.participantA);
    await expect(world.service.deliver({ handoffId: begun.handoffId })).rejects.toMatchObject({
      code: 'conflict',
      field: 'handoff_state',
    });
    await expect(world.service.observe({ handoffId: begun.handoffId, nativeEventId: 'evt-after-cancel' })).rejects.toMatchObject({
      code: 'conflict',
      field: 'handoff_state',
    });
    expect(world.service.handoff(begun.handoffId).active).toBe(false);
  });
});

/* ------------------------------------------------------------------ journal */

describe('operation journal idempotency', () => {
  it('replays the whole handoff as duplicates without a second prompt', async () => {
    const world = await makeWorld();
    const begun = await world.service.begin({
      threadId: world.thread.threadId,
      sourceParticipantId: world.participantA,
      targetParticipantId: world.participantB,
      entries: CONTEXT_ENTRIES,
    });
    await world.service.attach({ handoffId: begun.handoffId });
    await world.service.prepare({ handoffId: begun.handoffId, prompt: PROMPT });
    await world.service.deliver({ handoffId: begun.handoffId });
    const active = await world.service.observe({ handoffId: begun.handoffId, nativeEventId: 'evt-acp-3' });
    expect(active.state).toBe('active');
    expect(world.calls.sendPrompt()).toBe(1);

    // Replay the exact same sequence against the same handoff id.
    const replayed = await world.service.begin({
      handoffId: begun.handoffId,
      threadId: world.thread.threadId,
      sourceParticipantId: world.participantA,
      targetParticipantId: world.participantB,
      entries: CONTEXT_ENTRIES,
      checkpointId: begun.checkpoint?.checkpointId,
    });
    expect(replayed.state).toBe('active');
    const reAttached = await world.service.attach({ handoffId: begun.handoffId });
    expect(reAttached.state).toBe('active');
    const rePrepared = await world.service.prepare({ handoffId: begun.handoffId, prompt: PROMPT });
    expect(rePrepared.state).toBe('active');
    const reDelivered = await world.service.deliver({ handoffId: begun.handoffId });
    expect(reDelivered.state).toBe('active');
    const reObserved = await world.service.observe({ handoffId: begun.handoffId, nativeEventId: 'evt-acp-3' });
    expect(reObserved.state).toBe('active');

    // Observed journal state: one op per rung, every replayed op a duplicate, no side effects.
    const ops = world.service.ops(begun.handoffId);
    expect(ops.map((op) => op.kind)).toEqual(['checkpoint', 'attach', 'prepare', 'deliver', 'observe']);
    expect(ops.filter((op) => op.duplicate)).toHaveLength(0);
    expect(world.service.state.duplicates).toBeGreaterThanOrEqual(4);
    // The prompt was sent exactly once across the whole replay.
    expect(world.calls.sendPrompt()).toBe(1);
    expect(reObserved.sends).toBe(1);
    expect(world.calls.openTarget()).toBe(1);
    expect(world.threads.active(world.thread.threadId)?.participantId).toBe(world.participantB);
  });

  it('re-detects a duplicate deliver and observe with real observed counters', async () => {
    const world = await makeWorld();
    const begun = await world.service.begin({
      threadId: world.thread.threadId,
      sourceParticipantId: world.participantA,
      targetParticipantId: world.participantB,
      entries: CONTEXT_ENTRIES,
    });
    await world.service.attach({ handoffId: begun.handoffId });
    await world.service.prepare({ handoffId: begun.handoffId, prompt: PROMPT });
    await world.service.deliver({ handoffId: begun.handoffId });
    const duplicateDeliver = await world.service.deliver({ handoffId: begun.handoffId });
    expect(duplicateDeliver.state).toBe('delivered');
    expect(world.calls.sendPrompt()).toBe(1);
    await world.service.observe({ handoffId: begun.handoffId, nativeEventId: 'evt-acp-4' });
    const duplicateObserve = await world.service.observe({ handoffId: begun.handoffId, nativeEventId: 'evt-acp-5' });
    expect(duplicateObserve.state).toBe('active');
    expect(world.calls.sendPrompt()).toBe(1);
    const ops = world.service.ops(begun.handoffId);
    const deliverOps = ops.filter((op) => op.kind === 'deliver');
    const observeOps = ops.filter((op) => op.kind === 'observe');
    expect(deliverOps).toHaveLength(1);
    expect(observeOps).toHaveLength(1);
    expect(world.service.state.duplicates).toBeGreaterThanOrEqual(2);
    expect(world.service.state.sends).toBe(1);
  });

  it('refuses a different prompt after the handoff is prepared', async () => {
    const world = await makeWorld();
    const begun = await world.service.begin({
      threadId: world.thread.threadId,
      sourceParticipantId: world.participantA,
      targetParticipantId: world.participantB,
      entries: CONTEXT_ENTRIES,
    });
    await world.service.attach({ handoffId: begun.handoffId });
    await world.service.prepare({ handoffId: begun.handoffId, prompt: PROMPT });
    await expect(
      world.service.prepare({ handoffId: begun.handoffId, prompt: 'a different prompt' }),
    ).rejects.toMatchObject({ code: 'conflict', field: 'handoff_prompt' });
    expect(world.calls.sendPrompt()).toBe(0);
  });
});

/* ------------------------------------------------------------------ recovery */

describe('handoff recovery', () => {
  it('returns to the original participant selection after a failed handoff (idempotent rollback)', async () => {
    const failure = loadHandoff().HandoffError;
    const world = await makeWorld({
      sendPrompt: async () => {
        throw new failure('unauthorized', 'handoff_target_auth');
      },
    });
    const begun = await world.service.begin({
      threadId: world.thread.threadId,
      sourceParticipantId: world.participantA,
      targetParticipantId: world.participantB,
      entries: CONTEXT_ENTRIES,
    });
    await world.service.attach({ handoffId: begun.handoffId });
    await world.service.prepare({ handoffId: begun.handoffId, prompt: PROMPT });
    await expect(world.service.deliver({ handoffId: begun.handoffId })).rejects.toMatchObject({ code: 'unauthorized' });

    const recovery = loadRecovery();
    const first = recovery.recoverHandoff({ service: world.service, threads: world.threads, handoffId: begun.handoffId });
    expect(first.action).toBe('rollback');
    expect(first.restoredParticipantId).toBe(world.participantA);
    expect(world.threads.active(world.thread.threadId)?.participantId).toBe(world.participantA);
    const revision = world.threads.get(world.thread.threadId).revision;
    // A second rollback is idempotent: the selection is already the original one.
    const second = recovery.recoverHandoff({ service: world.service, threads: world.threads, handoffId: begun.handoffId });
    expect(second.action).toBe('rollback');
    expect(second.restoredParticipantId).toBe(world.participantA);
    expect(world.threads.get(world.thread.threadId).revision).toBe(revision);
    expect(world.service.handoff(begun.handoffId).state).toBe('failed');
    expect(world.calls.sendPrompt()).toBe(1);
  });

  it('a restart between prepare and deliver stops at reconcile with no resend', async () => {
    const world = await makeWorld();
    const begun = await world.service.begin({
      threadId: world.thread.threadId,
      sourceParticipantId: world.participantA,
      targetParticipantId: world.participantB,
      entries: CONTEXT_ENTRIES,
    });
    await world.service.attach({ handoffId: begun.handoffId });
    await world.service.prepare({ handoffId: begun.handoffId, prompt: PROMPT });
    // The process dies here: the prepared send never reached a native ack.
    const recovery = loadRecovery();
    const outcome = recovery.recoverHandoff({ service: world.service, threads: world.threads, handoffId: begun.handoffId });
    expect(outcome.action).toBe('reconcile');
    expect(outcome.sendAttempted).toBe(false);
    expect(world.service.handoff(begun.handoffId).state).toBe('reconcile');
    expect(world.service.handoff(begun.handoffId).active).toBe(false);
    expect(world.calls.sendPrompt()).toBe(0);
    expect(world.threads.active(world.thread.threadId)?.participantId).toBe(world.participantA);
    // Recovery itself never dispatches the prompt.
    expect(world.service.state.sends).toBe(0);
  });

  it('a restart after delivered-without-observed stops at reconcile with the send count unchanged', async () => {
    const world = await makeWorld();
    const begun = await world.service.begin({
      threadId: world.thread.threadId,
      sourceParticipantId: world.participantA,
      targetParticipantId: world.participantB,
      entries: CONTEXT_ENTRIES,
    });
    await world.service.attach({ handoffId: begun.handoffId });
    await world.service.prepare({ handoffId: begun.handoffId, prompt: PROMPT });
    await world.service.deliver({ handoffId: begun.handoffId });
    expect(world.calls.sendPrompt()).toBe(1);
    // The process dies after the native ack but before any native observation.
    const recovery = loadRecovery();
    const outcome = recovery.recoverHandoff({ service: world.service, threads: world.threads, handoffId: begun.handoffId });
    expect(outcome.action).toBe('reconcile');
    expect(outcome.sendAttempted).toBe(true);
    expect(world.service.handoff(begun.handoffId).state).toBe('reconcile');
    // The prompt is never re-sent and the handoff is never marked successful.
    expect(world.calls.sendPrompt()).toBe(1);
    expect(world.service.handoff(begun.handoffId).active).toBe(false);
    expect(world.threads.active(world.thread.threadId)?.participantId).toBe(world.participantA);
  });

  it('an active handoff recovers as complete and a fresh one as resumable', async () => {
    const world = await makeWorld();
    const begun = await world.service.begin({
      threadId: world.thread.threadId,
      sourceParticipantId: world.participantA,
      targetParticipantId: world.participantB,
      entries: CONTEXT_ENTRIES,
    });
    await world.service.attach({ handoffId: begun.handoffId });
    const resumable = loadRecovery().recoverHandoff({ service: world.service, threads: world.threads, handoffId: begun.handoffId });
    expect(resumable.action).toBe('resumable');
    expect(world.service.handoff(begun.handoffId).state).toBe('attached');
    await world.service.prepare({ handoffId: begun.handoffId, prompt: PROMPT });
    await world.service.deliver({ handoffId: begun.handoffId });
    await world.service.observe({ handoffId: begun.handoffId, nativeEventId: 'evt-acp-6' });
    const complete = loadRecovery().recoverHandoff({ service: world.service, threads: world.threads, handoffId: begun.handoffId });
    expect(complete.action).toBe('complete');
    expect(complete.observed).toBe(true);
    expect(world.threads.active(world.thread.threadId)?.participantId).toBe(world.participantB);
  });
});

/* ------------------------------------------------------------------ rejections */

describe('handoff rejections carry explicit codes', () => {
  it('rejects unknown ids, a self target, an empty prompt and illegal rungs', async () => {
    const world = await makeWorld();
    const begun = await world.service.begin({
      threadId: world.thread.threadId,
      sourceParticipantId: world.participantA,
      targetParticipantId: world.participantB,
      entries: CONTEXT_ENTRIES,
    });
    expect(rejectionOf(() => world.service.handoff('99999999-9999-4999-8999-999999999999'))).toEqual({
      code: 'invalid_request',
      field: 'handoff_unknown',
    });
    await expect(
      world.service.begin({
        threadId: world.thread.threadId,
        sourceParticipantId: world.participantA,
        targetParticipantId: world.participantA,
        entries: CONTEXT_ENTRIES,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request', field: 'handoff_target' });
    await expect(
      world.service.begin({
        threadId: world.thread.threadId,
        sourceParticipantId: world.participantA,
        targetParticipantId: '99999999-9999-4999-8999-999999999999',
        entries: CONTEXT_ENTRIES,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request', field: 'handoff_participant' });
    await expect(
      world.service.begin({
        threadId: '99999999-9999-4999-8999-999999999999',
        sourceParticipantId: world.participantA,
        targetParticipantId: world.participantB,
        entries: CONTEXT_ENTRIES,
      }),
    ).rejects.toMatchObject({ code: 'invalid_request', field: 'thread_unknown' });
    await expect(
      world.service.begin({
        threadId: world.thread.threadId,
        sourceParticipantId: world.participantA,
        targetParticipantId: world.participantB,
        entries: [],
      }),
    ).rejects.toMatchObject({ code: 'invalid_request', field: 'handoff_entries' });
    // Rung order is enforced: prepare before attach is refused. An observation is only held once
    // THIS handoff's send intent is committed (deliver in flight); one that predates the send
    // proves nothing about the prompt and is refused.
    await expect(world.service.prepare({ handoffId: begun.handoffId, prompt: PROMPT })).rejects.toMatchObject({
      code: 'conflict',
      field: 'handoff_state',
    });
    await expect(world.service.observe({ handoffId: begun.handoffId, nativeEventId: 'evt-early' })).rejects.toMatchObject({
      code: 'conflict',
      field: 'handoff_state',
    });
    await expect(world.service.attach({ handoffId: begun.handoffId })).resolves.toMatchObject({ state: 'attached' });
    await expect(world.service.prepare({ handoffId: begun.handoffId, prompt: '' })).rejects.toMatchObject({
      code: 'invalid_request',
      field: 'handoff_prompt',
    });
    await expect(world.service.deliver({ handoffId: begun.handoffId })).rejects.toMatchObject({
      code: 'conflict',
      field: 'handoff_state',
    });
  });

  it('refuses work after close', async () => {
    const world = await makeWorld();
    const begun = await world.service.begin({
      threadId: world.thread.threadId,
      sourceParticipantId: world.participantA,
      targetParticipantId: world.participantB,
      entries: CONTEXT_ENTRIES,
    });
    world.service.close();
    expect(world.service.state.closed).toBe(true);
    await expect(world.service.attach({ handoffId: begun.handoffId })).rejects.toMatchObject({
      code: 'cancelled',
      field: 'handoff_closed',
    });
  });
});

/* ------------------------------------------------------------------ review findings */

function gate(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

async function beginOne(world: HarnessFixture, handoffId?: string): Promise<HandoffView> {
  return world.service.begin({
    threadId: world.thread.threadId,
    sourceParticipantId: world.participantA,
    targetParticipantId: world.participantB,
    entries: CONTEXT_ENTRIES,
    ...(handoffId === undefined ? {} : { handoffId }),
  });
}

describe('concurrent begin of one handoffId', () => {
  it('serializes the duplicate check across the cancel await so the record survives', async () => {
    const pause = gate();
    const world = await makeWorld({
      sourceBusy: true,
      cancelSource: async () => { await pause.promise; },
    });
    const handoffId = '99999999-9999-4999-8999-999999999999';
    const input = {
      threadId: world.thread.threadId,
      sourceParticipantId: world.participantA,
      targetParticipantId: world.participantB,
      handoffId,
      cancel: true,
      entries: CONTEXT_ENTRIES,
    };

    const first = world.service.begin({ ...input, at: 1 });
    const second = world.service.begin({ ...input, at: 2 });
    pause.release();
    const results = await Promise.allSettled([first, second]);

    expect(world.service.state.handoffs).toBe(1);
    expect(world.service.state.ops).toBe(1);
    expect(world.calls.cancelSource()).toBe(1);
    const view = world.service.handoff(handoffId);
    expect(view.checkpoint).not.toBeNull();
    expect(view.checkpoint?.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(0);
    expect((results[0] as PromiseFulfilledResult<HandoffView>).value.handoffId).toBe(handoffId);
    expect((results[1] as PromiseFulfilledResult<HandoffView>).value.handoffId).toBe(handoffId);
  });
});

describe('a native observation that arrives before the ack', () => {
  it('holds the early observation and completes the handoff once the ack lands', async () => {
    const ack = gate();
    const world = await makeWorld({
      sendPrompt: async () => { await ack.promise; return { ackId: 'ack-late' }; },
    });
    const begun = await beginOne(world);
    await driveToPrepared(world, begun.handoffId);
    const delivering = world.service.deliver({ handoffId: begun.handoffId });

    await expect(world.service.observe({ handoffId: begun.handoffId, nativeEventId: 'ev-early' })).resolves.toMatchObject({
      observed: false,
      state: 'prepared',
    });

    ack.release();
    await delivering;
    const after = world.service.handoff(begun.handoffId);
    expect(after.state).toBe('active');
    expect(after.delivered).toBe(true);
    expect(after.deliveredBy).toBe('ack-late');
    expect(after.observed).toBe(true);
    expect(after.observedBy).toBe('ev-early');
    expect(world.threads.active(world.thread.threadId)?.participantId).toBe(world.participantB);
  });

  it('refuses an observation once the handoff already has a resolution', async () => {
    const world = await makeWorld();
    const begun = await beginOne(world);
    world.service.resolve({ handoffId: begun.handoffId, resolution: 'cancelled', code: 'test', field: 'test_field' });
    await expect(
      world.service.observe({ handoffId: begun.handoffId, nativeEventId: 'ev-1' }),
    ).rejects.toMatchObject({ code: 'conflict', field: 'handoff_state' });
  });
});

describe('a terminal resolution that lands while the send is in flight', () => {
  it('is not undone by the late ack flushing the buffered observation', async () => {
    const ack = gate();
    const world = await makeWorld({
      sendPrompt: async () => { await ack.promise; return { ackId: 'ack-late' }; },
    });
    const begun = await beginOne(world);
    await driveToPrepared(world, begun.handoffId);
    const delivering = world.service.deliver({ handoffId: begun.handoffId });
    await world.service.observe({ handoffId: begun.handoffId, nativeEventId: 'ev-early' });

    const cancelled = await world.service.cancel({ handoffId: begun.handoffId });
    expect(cancelled.state).toBe('cancelled');
    expect(world.threads.active(world.thread.threadId)?.participantId).toBe(world.participantA);

    ack.release();
    await delivering;
    const after = world.service.handoff(begun.handoffId);
    expect(after.state).toBe('cancelled');
    expect(after.observed).toBe(false);
    expect(after.observedAt).toBeNull();
    expect(world.threads.active(world.thread.threadId)?.participantId).toBe(world.participantA);
    expect(world.calls.sendPrompt()).toBe(1);
  });

  it('refuses an observation that predates the committed send', async () => {
    const world = await makeWorld();
    const begun = await beginOne(world);
    await expect(world.service.observe({ handoffId: begun.handoffId, nativeEventId: 'old-event', at: 2 }))
      .rejects.toMatchObject({ code: 'conflict', field: 'handoff_state' });

    await driveToPrepared(world, begun.handoffId);
    const delivered = await world.service.deliver({ handoffId: begun.handoffId });
    // The prompt was delivered, but a pre-send event cannot prove the sent prompt was handled.
    expect(delivered.state).toBe('delivered');
    expect(delivered.delivered).toBe(true);
    expect(delivered.observed).toBe(false);
    expect(delivered.observedAt).toBeNull();
    expect(world.threads.active(world.thread.threadId)?.participantId).toBe(world.participantA);
  });
});

describe('a transport error after the send was issued', () => {
  it('keeps reconcile_required instead of marking the handoff failed', async () => {
    const world = await makeWorld({
      sendPrompt: async () => { throw new Error('ack timeout after the target applied the prompt'); },
    });
    const begun = await beginOne(world);
    await driveToPrepared(world, begun.handoffId);

    await expect(world.service.deliver({ handoffId: begun.handoffId })).rejects.toMatchObject({
      code: 'reconcile_required',
      field: 'handoff_send_ambiguous',
    });
    const after = world.service.handoff(begun.handoffId);
    expect(after.state).toBe('reconcile');
    expect(after.resolution?.code).toBe('reconcile_required');
  });

  it('still reports a pre-send refusal as a definite failure', async () => {
    const refusal = new (loadHandoff().HandoffError)('source_unavailable', 'handoff_target_gone');
    const world = await makeWorld({
      sendPrompt: async () => { throw refusal; },
    });
    const begun = await beginOne(world);
    await driveToPrepared(world, begun.handoffId);

    await expect(world.service.deliver({ handoffId: begun.handoffId })).rejects.toMatchObject({
      code: 'source_unavailable',
      field: 'handoff_target_gone',
    });
    expect(world.service.handoff(begun.handoffId).state).toBe('failed');
  });
});

describe('a busy source without a cancel capability', () => {
  it('refuses the migration instead of silently skipping the cancel', async () => {
    const threads = createThreadService({
      resolveSession: async () => ({ session: SESSION_A, archived: false, parentSession: null }),
    });
    const thread = await threads.bind({ session: SESSION_A, repo: REPO });
    const joined = await threads.join({ threadId: thread.threadId, session: SESSION_B, repo: REPO });
    const checkpoints = loadCheckpoints().createCheckpointService();
    const service = loadHandoff().createHandoffService({
      threads,
      checkpoints,
      openTarget: async ({ target }) => ({ nativeSessionId: target.session.nativeSessionId }),
      sendPrompt: async () => ({ ackId: 'ack-1' }),
      isSourceBusy: () => true,
    });

    await expect(service.begin({
      threadId: thread.threadId,
      sourceParticipantId: thread.participants[0]!.participantId,
      targetParticipantId: joined.participantId,
      cancel: true,
      entries: CONTEXT_ENTRIES,
    })).rejects.toMatchObject({ code: 'conflict', field: 'handoff_source_busy' });
    expect(service.state.handoffs).toBe(0);
  });
});

describe('resolve marks a live record terminal', () => {
  it('maps both terminal resolutions onto their sink methods', async () => {
    for (const resolution of ['failed', 'cancelled'] as const) {
      const world = await makeWorld();
      const begun = await beginOne(world);
      const resolved = world.service.resolve({
        handoffId: begun.handoffId,
        resolution,
        code: 'test',
        field: 'test_field',
      });
      expect(resolved.state).toBe(resolution);
      expect(resolved.resolution?.resolution).toBe(resolution);
      expect(world.service.resolve({
        handoffId: begun.handoffId,
        resolution,
        code: 'test',
        field: 'test_field',
      })).toEqual(resolved);
    }
  });

  it('still refuses a second, different resolution', async () => {
    const world = await makeWorld();
    const begun = await beginOne(world);
    world.service.resolve({ handoffId: begun.handoffId, resolution: 'cancelled', code: 'test', field: 'test_field' });
    expect(rejectionOf(() => world.service.resolve({
      handoffId: begun.handoffId,
      resolution: 'failed',
      code: 'test',
      field: 'test_field',
    }))).toMatchObject({ code: 'conflict', field: 'handoff_state' });
  });
});

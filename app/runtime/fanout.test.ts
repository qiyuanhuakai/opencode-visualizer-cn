// @vitest-environment node
//
// Task 38 — partial-failure-recoverable fan-out (one prompt, a frozen target list, a per-recipient
// child operation each, per-recipient status + individual cancel, same-session dedup, and an overall
// operation DERIVED from each recipient's real outcome).
//
// Product under test:
//   bridge/runtime/collaboration/fanoutService.js   (create / dispatch / cancel / reconcile / retry)
//   bridge/runtime/collaboration/fanoutRecovery.js  (planFanoutRetry — the recovery planner)
//
// The two bridge modules under test are loaded through createRequire rather than a static import:
// this task's grant is exactly three new paths and none of them is a declaration file. A static
// import of a .d.ts-less bridge module is TS7016 under the repo's strict vue-tsc gate — the same
// reason task 37's collaborationCoordinator.test.ts uses the require boundary for coordinator.js.
// The contracts below are therefore declared here, in the test, and the require boundary is the
// only untyped edge. shared/runtime/collaboration.js and shared/runtime/identity.js DO ship sibling
// declaration files and are imported statically, so their contracts are checked by vue-tsc itself.
import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';
import { CollaborationError } from '../../shared/runtime/collaboration.js';
import { parseEnvironmentId, parseHarnessInstanceId } from '../../shared/runtime/identity.js';
import type { SessionRef } from '../../shared/runtime/identity.js';

/* ------------------------------------------------------------------ contracts */

interface FanoutLimits {
  readonly maxTargets: number;
  readonly maxPromptChars: number;
  readonly maxAttachmentPathChars: number;
}
interface FanoutTargetInput {
  readonly participantId: string;
  readonly session: SessionRef;
  readonly attachmentPath?: string | null;
}
interface RecipientResolution {
  readonly code: string;
  readonly field: string;
}
type RecipientOutcome = 'pending' | 'sent' | 'failed' | 'ambiguous' | 'cancelled';
type FanoutState = 'pending' | 'running' | 'succeeded' | 'partial' | 'failed' | 'cancelled' | 'ambiguous';
interface RecipientView {
  readonly recipientId: string;
  readonly participantId: string;
  readonly session: SessionRef;
  readonly sessionKey: string;
  readonly attachmentPath: string | null;
  readonly dispatched: boolean;
  readonly sendCount: number;
  readonly outcome: RecipientOutcome;
  readonly ackId: string | null;
  readonly resolution: RecipientResolution | null;
  readonly retryable: boolean;
  readonly createdAt: number;
  readonly updatedAt: number;
}
interface FanoutStats {
  readonly total: number;
  readonly sent: number;
  readonly failed: number;
  readonly ambiguous: number;
  readonly cancelled: number;
  readonly pending: number;
}
interface FanoutView {
  readonly fanoutId: string;
  readonly prompt: string;
  readonly state: FanoutState;
  readonly targets: readonly RecipientView[];
  readonly deduped: number;
  readonly stats: FanoutStats;
  readonly createdAt: number;
  readonly updatedAt: number;
}
interface FanoutDeliverInput {
  readonly recipientId: string;
  readonly participantId: string;
  readonly session: SessionRef;
  readonly attachmentPath: string | null;
  readonly prompt: string;
}
interface SendSpec {
  readonly recipientId: string;
  readonly participantId: string;
  readonly session: SessionRef;
  readonly attachmentPath: string | null;
}
interface RetainedRecipient {
  readonly recipientId: string;
  readonly outcome: string;
  readonly reason: string;
}
interface RetryPlan {
  readonly retryable: readonly SendSpec[];
  readonly retained: readonly RetainedRecipient[];
}
interface FanoutServiceModule {
  readonly FANOUT_LIMITS: FanoutLimits;
  readonly FANOUT_STATES: readonly string[];
  readonly RECIPIENT_OUTCOMES: readonly string[];
  deriveFanoutState(recipients: readonly { readonly outcome: string }[]): FanoutState;
  createFanoutService(options: {
    readonly deliver: (input: FanoutDeliverInput) => Promise<{ readonly ackId: string } | undefined>;
  }): FanoutService;
}
interface FanoutRecoveryModule {
  planFanoutRetry(view: FanoutView): RetryPlan;
}
interface FanoutService {
  createFanout(input: { readonly prompt: string; readonly targets: readonly FanoutTargetInput[]; readonly at?: number }): FanoutView;
  fanout(fanoutId: string): FanoutView;
  fanouts(): readonly FanoutView[];
  dispatch(input: { readonly fanoutId: string; readonly recipientIds?: readonly string[]; readonly at?: number }): Promise<FanoutView>;
  cancelRecipient(input: { readonly fanoutId: string; readonly recipientId: string; readonly at?: number }): FanoutView;
  reconcile(input: { readonly fanoutId: string; readonly at?: number }): FanoutView;
  retry(input: { readonly fanoutId: string; readonly recipientIds: readonly string[]; readonly at?: number }): Promise<FanoutView>;
  state(): Readonly<Record<string, number | boolean>>;
  close(): void;
}

/* ------------------------------------------------------------------ fixtures */

const require_ = createRequire(import.meta.url);

let fanoutModule: FanoutServiceModule;
let recoveryModule: FanoutRecoveryModule;

beforeAll(() => {
  // If either module is missing (the TDD RED state) this throws and every test in the file is
  // reported failed, which is exactly the RED we capture before implementing.
  fanoutModule = require_('../../bridge/runtime/collaboration/fanoutService.js') as FanoutServiceModule;
  recoveryModule = require_('../../bridge/runtime/collaboration/fanoutRecovery.js') as FanoutRecoveryModule;
});

const ENV = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const HARNESS_A = parseHarnessInstanceId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
const HARNESS_B = parseHarnessInstanceId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
const HARNESS_C = parseHarnessInstanceId('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
const HARNESS_D = parseHarnessInstanceId('dddddddd-dddd-4ddd-8ddd-dddddddddddd');
const HARNESS_E = parseHarnessInstanceId('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');

const SESSION_A: SessionRef = { environmentId: ENV, harnessInstanceId: HARNESS_A, nativeSessionId: 'native:codex-1' };
const SESSION_B: SessionRef = { environmentId: ENV, harnessInstanceId: HARNESS_B, nativeSessionId: 'native:acp-1' };
const SESSION_C: SessionRef = { environmentId: ENV, harnessInstanceId: HARNESS_C, nativeSessionId: 'native:kimi-1' };
const SESSION_D: SessionRef = { environmentId: ENV, harnessInstanceId: HARNESS_D, nativeSessionId: 'native:dsh-1' };
const SESSION_E: SessionRef = { environmentId: ENV, harnessInstanceId: HARNESS_E, nativeSessionId: 'native:opencode-1' };

const PARTICIPANTS: readonly string[] = Object.freeze([
  '15151515-1515-4515-8515-151515151511',
  '15151515-1515-4515-8515-151515151512',
  '15151515-1515-4515-8515-151515151513',
  '15151515-1515-4515-8515-151515151514',
  '15151515-1515-4515-8515-151515151515',
]);
const SESSIONS: readonly SessionRef[] = Object.freeze([SESSION_A, SESSION_B, SESSION_C, SESSION_D, SESSION_E]);

const P1 = PARTICIPANTS[0] as string;
const P2 = PARTICIPANTS[1] as string;
const P3 = PARTICIPANTS[2] as string;

const T0 = 1700000000000;
const PROMPT = 'review the repository and report findings';

function target(participantId: string, session: SessionRef, attachmentPath?: string): FanoutTargetInput {
  return attachmentPath === undefined ? { participantId, session } : { participantId, session, attachmentPath };
}

function makeService(deliver: (input: FanoutDeliverInput) => Promise<{ readonly ackId: string } | undefined>): FanoutService {
  return fanoutModule.createFanoutService({ deliver });
}

const ackAll: (input: FanoutDeliverInput) => Promise<{ readonly ackId: string }> =
  async (input) => ({ ackId: `ack-${input.recipientId}` });

function recipientFor(view: FanoutView, participantId: string): RecipientView {
  const found = view.targets.find((entry) => entry.participantId === participantId);
  if (found === undefined) throw new Error(`no recipient for participant ${participantId}`);
  return found;
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

/* ------------------------------------------------------------------ the frozen contract */

describe('fanout contract', () => {
  it('freezes one shared limits object with the plan bounds', () => {
    expect(fanoutModule.FANOUT_LIMITS).toEqual({
      maxTargets: 32,
      maxPromptChars: 65536,
      maxAttachmentPathChars: 1024,
    });
    expect(Object.isFrozen(fanoutModule.FANOUT_LIMITS)).toBe(true);
    expect(Object.isFrozen(fanoutModule.FANOUT_STATES)).toBe(true);
    expect(Object.isFrozen(fanoutModule.RECIPIENT_OUTCOMES)).toBe(true);
  });

  it('gives every rejection an explicit code and field, never a bare throw', () => {
    const service = makeService(ackAll);
    const emptyPrompt = rejectionOf(() => service.createFanout({ prompt: '', targets: [target(P1, SESSION_A)], at: T0 }));
    expect(emptyPrompt.code).toBe('invalid_request');
    expect(emptyPrompt.field).toBe('fanout_prompt');
    const noTargets = rejectionOf(() => service.createFanout({ prompt: PROMPT, targets: [], at: T0 }));
    expect(noTargets.code).toBe('invalid_request');
    expect(noTargets.field).toBe('fanout_targets');
    const badSession = rejectionOf(() => service.createFanout({
      prompt: PROMPT,
      targets: [{ participantId: P1, session: { environmentId: 'nope' } as unknown as SessionRef }],
      at: T0,
    }));
    expect(badSession.code).toBe('invalid_request');
    expect(badSession.field).toBe('fanout_target');
    const missingFanout = rejectionOf(() => service.fanout('22222222-2222-4222-8222-222222222222'));
    expect(missingFanout.code).toBe('invalid_request');
    expect(missingFanout.field).toBe('fanout_unknown');
    const malformedFanout = rejectionOf(() => service.fanout('nope'));
    expect(malformedFanout.code).toBe('invalid_request');
    expect(malformedFanout.field).toBe('fanout_id');
  });

  it('returns frozen read models from every accessor', () => {
    const service = makeService(ackAll);
    const fanout = service.createFanout({ prompt: PROMPT, targets: [target(P1, SESSION_A), target(P2, SESSION_B)], at: T0 });
    expect(Object.isFrozen(fanout)).toBe(true);
    expect(Object.isFrozen(fanout.targets)).toBe(true);
    expect(Object.isFrozen(fanout.targets[0])).toBe(true);
    expect(Object.isFrozen(fanout.targets[0]?.session)).toBe(true);
    expect(Object.isFrozen(service.fanout(fanout.fanoutId))).toBe(true);
    expect(Object.isFrozen(service.fanouts())).toBe(true);
  });
});

/* ------------------------------------------------------------------ creation, dedup, validation */

describe('fan-out creation, dedup, and attachment validation', () => {
  it('de-duplicates duplicate participants to the same session, keeping first-seen order', () => {
    const service = makeService(ackAll);
    const fanout = service.createFanout({
      prompt: PROMPT,
      targets: [
        target(P1, SESSION_A),
        target(P2, SESSION_B),
        target(P1, SESSION_A), // exact duplicate of the first target
      ],
      at: T0,
    });
    expect(fanout.targets.length).toBe(2);
    expect(fanout.deduped).toBe(1);
    expect(fanout.targets.map((entry) => entry.participantId)).toEqual([P1, P2]);
    expect(fanout.stats.total).toBe(2);
  });

  it('keeps the same participant across DIFFERENT sessions as distinct recipients', () => {
    const service = makeService(ackAll);
    const fanout = service.createFanout({
      prompt: PROMPT,
      targets: [target(P1, SESSION_A), target(P1, SESSION_B)],
      at: T0,
    });
    expect(fanout.targets.length).toBe(2);
    expect(fanout.deduped).toBe(0);
  });

  it('validates the attachment target and refuses a malformed path with an explicit code', () => {
    const service = makeService(ackAll);
    const traversal = rejectionOf(() => service.createFanout({
      prompt: PROMPT,
      targets: [target(P1, SESSION_A, '/repo/../etc/passwd')],
      at: T0,
    }));
    expect(traversal.code).toBe('invalid_request');
    expect(traversal.field).toBe('fanout_attachment');
    const empty = rejectionOf(() => service.createFanout({
      prompt: PROMPT,
      targets: [target(P1, SESSION_A, '')],
      at: T0,
    }));
    expect(empty.field).toBe('fanout_attachment');
    const nul = rejectionOf(() => service.createFanout({
      prompt: PROMPT,
      targets: [target(P1, SESSION_A, '/repo/a\u0000b.txt')],
      at: T0,
    }));
    expect(nul.field).toBe('fanout_attachment');
  });

  it('refuses a target list over the frozen quota', () => {
    const service = makeService(ackAll);
    const raw: FanoutTargetInput[] = [];
    for (let index = 0; index < 33; index += 1) {
      const slot = index % PARTICIPANTS.length;
      raw.push(target(PARTICIPANTS[slot] as string, SESSIONS[slot] as SessionRef));
    }
    const over = rejectionOf(() => service.createFanout({ prompt: PROMPT, targets: raw, at: T0 }));
    expect(over.code).toBe('invalid_request');
    expect(over.field).toBe('fanout_targets');
  });
});

/* ------------------------------------------------------------------ AC1: a failure never revokes the running */

describe('concurrent dispatch isolation', () => {
  it('does NOT revoke already-running recipients when a concurrent send fails', async () => {
    const calls: string[] = [];
    const deliver = async (input: FanoutDeliverInput): Promise<{ ackId: string }> => {
      calls.push(input.recipientId);
      if (input.participantId === P2) {
        throw new CollaborationError('source_unavailable', 'fanout_send');
      }
      return { ackId: `ack-${input.recipientId}` };
    };
    const service = makeService(deliver);
    const fanout = service.createFanout({
      prompt: PROMPT,
      targets: [target(P1, SESSION_A), target(P2, SESSION_B), target(P3, SESSION_C)],
      at: T0,
    });
    const after = await service.dispatch({ fanoutId: fanout.fanoutId, at: T0 });

    // The second recipient's send failed...
    expect(recipientFor(after, P2).outcome).toBe('failed');
    expect(recipientFor(after, P2).resolution?.code).toBe('source_unavailable');
    // ...but the two already-running recipients are NOT revoked: still sent, never cancelled, never re-sent.
    expect(recipientFor(after, P1).outcome).toBe('sent');
    expect(recipientFor(after, P3).outcome).toBe('sent');
    expect(recipientFor(after, P1).outcome).not.toBe('cancelled');
    expect(recipientFor(after, P3).outcome).not.toBe('cancelled');
    expect(recipientFor(after, P1).sendCount).toBe(1);
    expect(recipientFor(after, P3).sendCount).toBe(1);
    // All three sends were actually attempted concurrently; each recipient observed exactly once.
    expect(calls.length).toBe(3);
    // The overall state is derived from the real per-recipient outcomes (2 sent, 1 failed).
    expect(after.state).toBe('partial');
    expect(after.stats).toEqual({ total: 3, sent: 2, failed: 1, ambiguous: 0, cancelled: 0, pending: 0 });
  });
});

/* ------------------------------------------------------------------ status + individual cancel + partial */

describe('per-recipient status, individual cancel, and partial dispatch', () => {
  it('exposes each recipient real outcome and cancels ONE recipient individually', async () => {
    const service = makeService(ackAll);
    const fanout = service.createFanout({
      prompt: PROMPT,
      targets: [target(P1, SESSION_A), target(P2, SESSION_B), target(P3, SESSION_C)],
      at: T0,
    });
    const dispatched = await service.dispatch({ fanoutId: fanout.fanoutId, at: T0 });
    expect(dispatched.targets.every((entry) => entry.outcome === 'sent')).toBe(true);

    const afterCancel = service.cancelRecipient({ fanoutId: fanout.fanoutId, recipientId: fanout.targets[1]?.recipientId as string, at: T0 });
    expect(recipientFor(afterCancel, P2).outcome).toBe('cancelled');
    expect(recipientFor(afterCancel, P2).resolution?.code).toBe('cancelled');
    // The other two recipients are untouched by the individual cancel.
    expect(recipientFor(afterCancel, P1).outcome).toBe('sent');
    expect(recipientFor(afterCancel, P3).outcome).toBe('sent');
    expect(afterCancel.state).toBe('partial');
  });

  it('dispatches only the requested subset and leaves the rest unsent', async () => {
    const service = makeService(ackAll);
    const fanout = service.createFanout({
      prompt: PROMPT,
      targets: [target(P1, SESSION_A), target(P2, SESSION_B), target(P3, SESSION_C)],
      at: T0,
    });
    const ids = fanout.targets.map((entry) => entry.recipientId);
    const after = await service.dispatch({ fanoutId: fanout.fanoutId, recipientIds: [ids[0] as string, ids[2] as string], at: T0 });
    expect(recipientFor(after, P1).outcome).toBe('sent');
    expect(recipientFor(after, P3).outcome).toBe('sent');
    expect(recipientFor(after, P2).outcome).toBe('pending');
    expect(recipientFor(after, P2).dispatched).toBe(false);
    expect(recipientFor(after, P2).sendCount).toBe(0);
  });
});

/* ------------------------------------------------------------------ AC3: each target keeps its own attachment path */

describe('attachment path isolation', () => {
  it('delivers each recipient its OWN attachment path and never another target path', async () => {
    const seen: Array<{ recipientId: string; attachmentPath: string | null }> = [];
    const deliver = async (input: FanoutDeliverInput): Promise<{ ackId: string }> => {
      seen.push({ recipientId: input.recipientId, attachmentPath: input.attachmentPath });
      return { ackId: `ack-${input.recipientId}` };
    };
    const service = makeService(deliver);
    const fanout = service.createFanout({
      prompt: PROMPT,
      targets: [
        target(P1, SESSION_A, '/repo/alpha.txt'),
        target(P2, SESSION_B, '/repo/beta.txt'),
        target(P3, SESSION_C),
      ],
      at: T0,
    });
    await service.dispatch({ fanoutId: fanout.fanoutId, at: T0 });

    const ids = fanout.targets.map((entry) => entry.recipientId);
    const forR1 = seen.find((entry) => entry.recipientId === ids[0]);
    const forR2 = seen.find((entry) => entry.recipientId === ids[1]);
    const forR3 = seen.find((entry) => entry.recipientId === ids[2]);
    expect(forR1?.attachmentPath).toBe('/repo/alpha.txt');
    expect(forR2?.attachmentPath).toBe('/repo/beta.txt');
    expect(forR3?.attachmentPath).toBeNull();
    // Neither target received the other's path.
    expect(forR1?.attachmentPath).not.toBe('/repo/beta.txt');
    expect(forR2?.attachmentPath).not.toBe('/repo/alpha.txt');
  });
});

/* ------------------------------------------------------------------ AC2: retry only explicitly-safe unsent; ambiguous never re-sent */

describe('recovery: retry only explicitly-safe unsent recipients', () => {
  it('retries ONLY explicitly-safe unsent recipients and NEVER re-sends an ambiguous one', async () => {
    const calls: string[] = [];
    const deliver = async (input: FanoutDeliverInput): Promise<{ ackId: string } | undefined> => {
      calls.push(input.recipientId);
      if (input.participantId === P2) return undefined; // no ackId -> ambiguous
      return { ackId: `ack-${input.recipientId}` };
    };
    const service = makeService(deliver);
    const fanout = service.createFanout({
      prompt: PROMPT,
      targets: [target(P1, SESSION_A), target(P2, SESSION_B), target(P3, SESSION_C)],
      at: T0,
    });
    const ids = fanout.targets.map((entry) => entry.recipientId);

    // First dispatch: P1 (sent) and P2 (ambiguous) only; P3 stays unsent.
    const first = await service.dispatch({ fanoutId: fanout.fanoutId, recipientIds: [ids[0] as string, ids[1] as string], at: T0 });
    expect(recipientFor(first, P1).outcome).toBe('sent');
    expect(recipientFor(first, P2).outcome).toBe('ambiguous');
    expect(recipientFor(first, P3).outcome).toBe('pending');
    expect(recipientFor(first, P3).dispatched).toBe(false);

    const plan = recoveryModule.planFanoutRetry(first);
    expect(plan.retryable.map((spec) => spec.recipientId)).toEqual([ids[2]]);
    expect(plan.retained.map((entry) => entry.recipientId).sort()).toEqual([ids[0], ids[1]].sort());

    const before = service.fanout(fanout.fanoutId);
    const ambiguousSendsBefore = recipientFor(before, P2).sendCount;
    const sentSendsBefore = recipientFor(before, P1).sendCount;
    expect(ambiguousSendsBefore).toBe(1);

    const callsBeforeRetry = calls.length;
    const afterRetry = await service.retry({ fanoutId: fanout.fanoutId, recipientIds: plan.retryable.map((spec) => spec.recipientId), at: T0 });

    // The unsent recipient is retried and now sent...
    expect(recipientFor(afterRetry, P3).outcome).toBe('sent');
    // ...the ambiguous recipient shows ZERO re-sends (its product send counter is unchanged)...
    expect(recipientFor(afterRetry, P2).sendCount).toBe(ambiguousSendsBefore);
    // ...and the already-sent recipient is not re-sent either.
    expect(recipientFor(afterRetry, P1).sendCount).toBe(sentSendsBefore);
    // The observed deliver calls during retry are exactly the unsent recipient, never the ambiguous one.
    const retryCalls = calls.slice(callsBeforeRetry);
    expect(retryCalls).toEqual([ids[2]]);
    expect(retryCalls).not.toContain(ids[1]);
  });

  it('plans a retry whose retryable set structurally excludes every already-dispatched recipient', async () => {
    const deliver = async (input: FanoutDeliverInput): Promise<{ ackId: string } | undefined> => {
      if (input.participantId === P2) return undefined; // ambiguous
      return { ackId: `ack-${input.recipientId}` };
    };
    const service = makeService(deliver);
    const fanout = service.createFanout({
      prompt: PROMPT,
      targets: [target(P1, SESSION_A), target(P2, SESSION_B), target(P3, SESSION_C)],
      at: T0,
    });
    const ids = fanout.targets.map((entry) => entry.recipientId);
    await service.dispatch({ fanoutId: fanout.fanoutId, recipientIds: [ids[0] as string, ids[1] as string], at: T0 });

    const plan = recoveryModule.planFanoutRetry(service.fanout(fanout.fanoutId));
    // Every retryable spec belongs to a recipient that was NEVER dispatched.
    for (const spec of plan.retryable) {
      const view = recipientFor(service.fanout(fanout.fanoutId), spec.participantId);
      expect(view.dispatched).toBe(false);
    }
    expect(plan.retryable.map((spec) => spec.participantId)).toEqual([P3]);
    // Every dispatched recipient (sent or ambiguous) is retained, never retryable.
    expect(plan.retained.map((entry) => entry.recipientId).sort()).toEqual([ids[0], ids[1]].sort());
  });

  it('refuses to re-send an already-dispatched recipient even when its id is passed to retry', async () => {
    const calls: string[] = [];
    const deliver = async (input: FanoutDeliverInput): Promise<{ ackId: string } | undefined> => {
      calls.push(input.recipientId);
      if (input.participantId === P2) return undefined; // ambiguous
      return { ackId: `ack-${input.recipientId}` };
    };
    const service = makeService(deliver);
    const fanout = service.createFanout({
      prompt: PROMPT,
      targets: [target(P1, SESSION_A), target(P2, SESSION_B)],
      at: T0,
    });
    const ids = fanout.targets.map((entry) => entry.recipientId);
    await service.dispatch({ fanoutId: fanout.fanoutId, recipientIds: [ids[0] as string, ids[1] as string], at: T0 });
    // P1 sent, P2 ambiguous. The dispatch layer is the SECOND, independent gate.
    const ambiguousSendsBefore = recipientFor(service.fanout(fanout.fanoutId), P2).sendCount;
    const callsBefore = calls.length;
    // Force a retry that explicitly names the ambiguous recipient's id.
    await service.retry({ fanoutId: fanout.fanoutId, recipientIds: [ids[1] as string], at: T0 });
    const after = service.fanout(fanout.fanoutId);
    expect(recipientFor(after, P2).sendCount).toBe(ambiguousSendsBefore);
    expect(calls.slice(callsBefore)).not.toContain(ids[1]);
  });
});

/* ------------------------------------------------------------------ reconcile after a manager kill mid-batch */

describe('reconcile after a manager kill mid-batch', () => {
  it('marks an in-flight send ambiguous after a kill, ignores the late ack, and never re-sends it', async () => {
    const gate: { release?: () => void } = {};
    const deliver = (input: FanoutDeliverInput): Promise<{ ackId: string }> => {
      if (input.participantId === P1) {
        return new Promise<{ ackId: string }>((resolve) => {
          gate.release = () => resolve({ ackId: 'ack-1' });
        });
      }
      return Promise.resolve({ ackId: `ack-${input.recipientId}` });
    };
    const service = makeService(deliver);
    const fanout = service.createFanout({
      prompt: PROMPT,
      targets: [target(P1, SESSION_A), target(P2, SESSION_B)],
      at: T0,
    });
    const ids = fanout.targets.map((entry) => entry.recipientId);

    // P2 succeeds and settles first (terminal 'sent').
    await service.dispatch({ fanoutId: fanout.fanoutId, recipientIds: [ids[1] as string], at: T0 });
    // P1's send hangs in flight.
    const inFlight = service.dispatch({ fanoutId: fanout.fanoutId, recipientIds: [ids[0] as string], at: T0 });

    // The manager is killed mid-batch: reconcile marks the in-flight P1 ambiguous, P2 untouched.
    const killed = service.reconcile({ fanoutId: fanout.fanoutId, at: T0 });
    expect(recipientFor(killed, P1).outcome).toBe('ambiguous');
    expect(recipientFor(killed, P2).outcome).toBe('sent');

    // The hung send finally resolves, but P1 stays ambiguous (the late ack is ignored).
    gate.release?.();
    await inFlight;
    const after = service.fanout(fanout.fanoutId);
    expect(recipientFor(after, P1).outcome).toBe('ambiguous');
    expect(recipientFor(after, P1).sendCount).toBe(1);

    // A retry plan never re-sends the now-ambiguous P1.
    const plan = recoveryModule.planFanoutRetry(after);
    expect(plan.retryable.map((spec) => spec.recipientId)).not.toContain(ids[0]);
  });
});

/* ------------------------------------------------------------------ AC4: overall derived from real per-recipient outcomes */

describe('overall state is derived from per-recipient outcomes', () => {
  it('derives the overall state from the OBSERVED per-recipient outcomes, not a synthetic value', async () => {
    const service = makeService(ackAll);
    const fanout = service.createFanout({
      prompt: PROMPT,
      targets: [target(P1, SESSION_A), target(P2, SESSION_B), target(P3, SESSION_C)],
      at: T0,
    });

    // Nothing dispatched yet -> pending, and it equals the pure derivation of the observed outcomes.
    let view = service.fanout(fanout.fanoutId);
    expect(view.state).toBe('pending');
    expect(view.state).toBe(fanoutModule.deriveFanoutState(view.targets));

    // All recipients sent -> succeeded, again equal to the derivation.
    view = await service.dispatch({ fanoutId: fanout.fanoutId, at: T0 });
    expect(view.state).toBe('succeeded');
    expect(view.state).toBe(fanoutModule.deriveFanoutState(view.targets));

    // Cancel one individually -> the overall state re-derives to 'partial' from the observed mix.
    view = service.cancelRecipient({ fanoutId: fanout.fanoutId, recipientId: fanout.targets[1]?.recipientId as string, at: T0 });
    expect(view.state).toBe('partial');
    expect(view.state).toBe(fanoutModule.deriveFanoutState(view.targets));
    // The derivation is a pure function of the per-recipient outcomes we can read back.
    expect(view.targets.map((entry) => entry.outcome)).toEqual(['sent', 'cancelled', 'sent']);
  });
});

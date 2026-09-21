import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { KimiWebError } from '../../utils/kimiWeb';
import type {
  KimiWebAnswerApprovalInput,
  KimiWebApproval,
  KimiWebQuestion,
} from '../../utils/kimiWeb';
import type { KimiWebWsAck, KimiWebWsFrame } from '../../utils/kimiWebWs';
import {
  KIMI_WEB_APPROVAL_REQUEST_PREFIX,
  KIMI_WEB_QUESTION_REQUEST_PREFIX,
  answerKimiWebApproval,
  answerKimiWebQuestion,
  attachKimiWebInteractions,
  createKimiWebInteractionStore,
  dismissKimiWebQuestion,
  kimiWebApprovalAnswerFromReply,
  kimiWebApprovalRequestId,
  kimiWebApprovalToPermissionRequest,
  kimiWebQuestionAnswersFromLabels,
  kimiWebQuestionRequestId,
  kimiWebQuestionToQuestionRequest,
  kimiWebSessionOpNeedsReconcile,
  parseKimiWebApprovalRequestId,
  parseKimiWebQuestionRequestId,
  reconcileKimiWebInteractions,
  type KimiWebInteractionClient,
  type KimiWebSessionDeclaringOp,
} from './interactions';

const SESSION_ID = 'session_e0158012-f869-4d98-b4d4-5921a8686e24';
const OTHER_SESSION_ID = 'session_5bd03fc9-0077-4e87-a8fd-1d4e1f716acd';
const APPROVAL_A = 'approval_01M30ZPT0000000000000000';
const APPROVAL_B = 'approval_01M30ZPT0000000000000001';
const QUESTION_A = 'question_01M30ZPT1111111111111111';
const QUESTION_B = 'question_01M30ZPT2222222222222222';

const FIXTURES_DIR = [
  join(process.cwd(), 'app', 'backends', 'kimiWeb', 'fixtures'),
  join(process.cwd(), 'backends', 'kimiWeb', 'fixtures'),
].find((directory) => existsSync(directory)) ?? join(process.cwd(), 'app', 'backends', 'kimiWeb', 'fixtures');

function fixtureFrames(name: string): KimiWebWsFrame[] {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line): KimiWebWsFrame => JSON.parse(line));
}

const derivedFrames = fixtureFrames('wire-spec-derived.jsonl');

function frame(type: string): KimiWebWsFrame {
  const found = derivedFrames.find((entry) => entry.type === type);
  if (!found) throw new Error(`Missing fixture frame: ${type}`);
  return found;
}

/** Re-address a real fixture frame to another interaction id / session. */
function cloneFrame(base: KimiWebWsFrame, patch: Record<string, unknown> = {}): KimiWebWsFrame {
  const { payload, ...rest } = patch as { payload?: Record<string, unknown> };
  const basePayload = (base.payload ?? {}) as Record<string, unknown>;
  return {
    ...base,
    ...rest,
    payload: payload ? { ...basePayload, ...payload } : base.payload,
  } as KimiWebWsFrame;
}

const approvalRequested = frame('event.approval.requested');
const approvalResolved = frame('event.approval.resolved');
const questionRequested = frame('event.question.requested');
const questionAnswered = frame('event.question.answered');
const questionDismissed = frame('event.question.dismissed');

function approvalRequestedAs(id: string, sessionId = SESSION_ID): KimiWebWsFrame {
  return cloneFrame(approvalRequested, {
    session_id: sessionId,
    payload: { approval_id: id, session_id: sessionId, sessionId },
  });
}

function approvalResolvedAs(id: string, sessionId = SESSION_ID): KimiWebWsFrame {
  return cloneFrame(approvalResolved, {
    session_id: sessionId,
    payload: { approval_id: id, session_id: sessionId, sessionId },
  });
}

function questionRequestedAs(id: string, sessionId = SESSION_ID): KimiWebWsFrame {
  return cloneFrame(questionRequested, {
    session_id: sessionId,
    payload: { question_id: id, session_id: sessionId, sessionId },
  });
}

function questionTerminalAs(base: KimiWebWsFrame, id: string, sessionId = SESSION_ID): KimiWebWsFrame {
  return cloneFrame(base, {
    session_id: sessionId,
    payload: { question_id: id, session_id: sessionId, sessionId },
  });
}

function restApproval(id: string, overrides: Partial<KimiWebApproval> = {}): KimiWebApproval {
  return {
    approval_id: id,
    session_id: SESSION_ID,
    turn_id: 1,
    tool_call_id: 'tool_LLLyHODIa03gVnx5RCNr8z20',
    tool_name: 'Read',
    action: 'read_file(/tmp/note.txt)',
    created_at: '2026-09-21T03:30:00.300Z',
    ...overrides,
  };
}

function restQuestion(id: string, overrides: Partial<KimiWebQuestion> = {}): KimiWebQuestion {
  return {
    question_id: id,
    session_id: SESSION_ID,
    turn_id: 1,
    tool_call_id: 'tool_3ydieXPUScwcnZ3KzDPcfeDx',
    questions: [
      {
        id: 'q_0',
        question: 'Which file should I read?',
        header: 'File choice',
        options: [
          { id: 'opt_0_0', label: 'note.txt', description: 'the scratch note' },
          { id: 'opt_0_1', label: 'README.md' },
        ],
        allow_other: true,
      },
    ],
    created_at: '2026-09-21T03:30:02.000Z',
    ...overrides,
  };
}

type FakeClient = KimiWebInteractionClient & {
  calls: Array<{ method: string; path: string; body?: unknown }>;
  approvals: KimiWebApproval[];
  questions: KimiWebQuestion[];
  status: { pending_interaction?: string } | undefined;
  failAnswerWith?: unknown;
};

function createFakeClient(options: {
  approvals?: KimiWebApproval[];
  questions?: KimiWebQuestion[];
  status?: { pending_interaction?: string };
  failAnswerWith?: unknown;
  refetchApprovals?: KimiWebApproval[];
  refetchQuestions?: KimiWebQuestion[];
} = {}): FakeClient {
  const calls: FakeClient['calls'] = [];
  let approvalReads = 0;
  let questionReads = 0;
  const client: FakeClient = {
    calls,
    approvals: options.approvals ?? [],
    questions: options.questions ?? [],
    status: options.status,
    failAnswerWith: options.failAnswerWith,
    getSessionStatus: (sessionId: string) => {
      calls.push({ method: 'GET', path: `/api/v1/sessions/${sessionId}/status` });
      return Promise.resolve((options.status ?? {}) as never);
    },
    listApprovals: (sessionId: string) => {
      approvalReads += 1;
      calls.push({ method: 'GET', path: `/api/v1/sessions/${sessionId}/approvals` });
      const items =
        approvalReads > 1 && options.refetchApprovals ? options.refetchApprovals : client.approvals;
      return Promise.resolve({ items });
    },
    listQuestions: (sessionId: string) => {
      questionReads += 1;
      calls.push({ method: 'GET', path: `/api/v1/sessions/${sessionId}/questions` });
      const items =
        questionReads > 1 && options.refetchQuestions ? options.refetchQuestions : client.questions;
      return Promise.resolve({ items });
    },
    answerApproval: (sessionId: string, approvalId: string, answer: KimiWebAnswerApprovalInput) => {
      calls.push({
        method: 'POST',
        path: `/api/v1/sessions/${sessionId}/approvals/${approvalId}`,
        body: answer,
      });
      if (client.failAnswerWith) return Promise.reject(client.failAnswerWith);
      client.approvals = client.approvals.filter((entry) => entry.approval_id !== approvalId);
      return Promise.resolve({ resolved: true });
    },
    answerQuestion: (sessionId: string, questionId: string, answer) => {
      calls.push({
        method: 'POST',
        path: `/api/v1/sessions/${sessionId}/questions/${questionId}`,
        body: answer,
      });
      if (client.failAnswerWith) return Promise.reject(client.failAnswerWith);
      client.questions = client.questions.filter((entry) => entry.question_id !== questionId);
      return Promise.resolve({ resolved: true });
    },
    dismissQuestion: (sessionId: string, questionId: string) => {
      calls.push({ method: 'POST', path: `/api/v1/sessions/${sessionId}/questions/${questionId}:dismiss` });
      if (client.failAnswerWith) return Promise.reject(client.failAnswerWith);
      client.questions = client.questions.filter((entry) => entry.question_id !== questionId);
      return Promise.resolve({ resolved: true });
    },
  };
  return client;
}

class FakeFrameSource {
  private readonly frameListeners = new Set<(frame: KimiWebWsFrame) => void>();
  private readonly reconnectListeners = new Set<(ack: KimiWebWsAck) => void>();

  onFrame(listener: (frame: KimiWebWsFrame) => void) {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onReconnectReady(listener: (ack: KimiWebWsAck) => void) {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  emitFrame(value: KimiWebWsFrame) {
    for (const listener of this.frameListeners) listener(value);
  }

  emitReconnectReady() {
    const ack: KimiWebWsAck = { id: 'hello-1', code: 0, payload: { cursors: {}, resync_required: [] } };
    for (const listener of this.reconnectListeners) listener(ack);
  }
}

describe('kimi-web interaction events (wire -> event)', () => {
  it('Given a real event.approval.requested frame, When ingested, Then a pending approval event is produced', () => {
    const store = createKimiWebInteractionStore();
    const event = store.ingestFrame(approvalRequested);
    expect(event).toMatchObject({
      kind: 'approval',
      phase: 'requested',
      sessionId: SESSION_ID,
      id: APPROVAL_A,
      toolName: 'Read',
      action: 'read_file(/tmp/opencode/kimi-probe/ws-workspace/note.txt)',
      toolCallId: 'tool_LLLyHODIa03gVnx5RCNr8z20',
      turnId: 1,
    });
    expect(store.pendingKind(SESSION_ID)).toBe('approval');
  });

  it('Given a real event.question.requested frame, When ingested, Then a pending question event carries the wire items', () => {
    const store = createKimiWebInteractionStore();
    const event = store.ingestFrame(questionRequested);
    expect(event).toMatchObject({
      kind: 'question',
      phase: 'requested',
      sessionId: SESSION_ID,
      id: QUESTION_A,
    });
    expect(event?.kind === 'question' && event.questions?.[0]).toMatchObject({
      id: 'q_0',
      question: 'Which file should I read?',
      header: 'File choice',
    });
    expect(store.pendingKind(SESSION_ID)).toBe('question');
    const pending = store.pendingFor(SESSION_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: 'question', id: QUESTION_A, source: 'event' });
  });

  it('Given a non-interaction frame, When ingested, Then null is returned and nothing is tracked', () => {
    const store = createKimiWebInteractionStore();
    const turnEnded = derivedFrames.find((entry) => entry.type === 'turn.ended');
    expect(turnEnded).toBeDefined();
    expect(store.ingestFrame(turnEnded!)).toBeNull();
    expect(store.size()).toBe(0);
    expect(store.pendingKind(SESSION_ID)).toBe('none');
  });

  it('Given an approval requested frame without an id, When ingested, Then it is ignored (no fabricated interaction)', () => {
    const store = createKimiWebInteractionStore();
    const malformed = cloneFrame(approvalRequested, { payload: { approval_id: '' } });
    expect(store.ingestFrame(malformed)).toBeNull();
    expect(store.size()).toBe(0);
  });

  it('Given a question requested frame without renderable items, When ingested, Then it is ignored', () => {
    const store = createKimiWebInteractionStore();
    const malformed = cloneFrame(questionRequested, { payload: { question_id: QUESTION_A, questions: [] } });
    expect(store.ingestFrame(malformed)).toBeNull();
    expect(store.size()).toBe(0);
  });
});

describe('kimi-web interaction reconciliation (matching id only)', () => {
  it('Given two pending approvals, When A resolves, Then only A is cleared and B stays pending', () => {
    const store = createKimiWebInteractionStore();
    store.ingestFrame(approvalRequestedAs(APPROVAL_A));
    store.ingestFrame(approvalRequestedAs(APPROVAL_B));
    expect(store.pendingFor(SESSION_ID)).toHaveLength(2);

    store.ingestFrame(approvalResolvedAs(APPROVAL_A));

    const pending = store.pendingFor(SESSION_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: 'approval', id: APPROVAL_B });
    expect(store.pendingKind(SESSION_ID)).toBe('approval');
  });

  it("Given A resolved long ago, When A's late resolved event arrives again, Then the newer B is not cleared", () => {
    const store = createKimiWebInteractionStore();
    store.ingestFrame(approvalRequestedAs(APPROVAL_A));
    store.ingestFrame(approvalResolvedAs(APPROVAL_A));
    store.ingestFrame(approvalRequestedAs(APPROVAL_B));
    expect(store.pendingFor(SESSION_ID)).toHaveLength(1);

    // Late duplicate of the already-applied resolved event for A.
    store.ingestFrame(approvalResolvedAs(APPROVAL_A));

    const pending = store.pendingFor(SESSION_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: APPROVAL_B });
  });

  it('Given a pending question, When event.question.answered arrives, Then only that id is cleared', () => {
    const store = createKimiWebInteractionStore();
    store.ingestFrame(questionRequestedAs(QUESTION_A));
    store.ingestFrame(questionRequestedAs(QUESTION_B));

    store.ingestFrame(questionTerminalAs(questionAnswered, QUESTION_A));

    const pending = store.pendingFor(SESSION_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: 'question', id: QUESTION_B });
  });

  it('Given a pending question, When event.question.dismissed arrives, Then only that id is cleared', () => {
    const store = createKimiWebInteractionStore();
    store.ingestFrame(questionRequestedAs(QUESTION_A));
    store.ingestFrame(questionRequestedAs(QUESTION_B));

    store.ingestFrame(questionTerminalAs(questionDismissed, QUESTION_A));

    const pending = store.pendingFor(SESSION_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: QUESTION_B });
  });

  it('Given a resolved event for an unknown id, When ingested, Then the pending set is untouched', () => {
    const store = createKimiWebInteractionStore();
    store.ingestFrame(approvalRequestedAs(APPROVAL_B));
    store.ingestFrame(approvalResolvedAs(APPROVAL_A));
    expect(store.pendingFor(SESSION_ID)).toHaveLength(1);
    expect(store.pendingFor(SESSION_ID)[0]).toMatchObject({ id: APPROVAL_B });
  });

  it('Given a turn.ended frame, When ingested, Then a still-pending approval is never cleared', () => {
    const store = createKimiWebInteractionStore();
    store.ingestFrame(approvalRequestedAs(APPROVAL_A));
    const turnEnded = derivedFrames.find((entry) => entry.type === 'turn.ended');
    expect(turnEnded).toBeDefined();

    store.ingestFrame(turnEnded!);

    expect(store.pendingFor(SESSION_ID)).toHaveLength(1);
    expect(store.pendingKind(SESSION_ID)).toBe('approval');
  });

  it('Given pending items in two sessions, When the other session reconciles, Then its slice only is rebuilt', () => {
    const store = createKimiWebInteractionStore();
    store.ingestFrame(approvalRequestedAs(APPROVAL_A, SESSION_ID));
    store.ingestFrame(approvalRequestedAs(APPROVAL_B, OTHER_SESSION_ID));

    store.applyAuthoritative({ sessionId: SESSION_ID, approvals: [], questions: [] });

    expect(store.pendingFor(SESSION_ID)).toHaveLength(0);
    expect(store.pendingFor(OTHER_SESSION_ID)).toHaveLength(1);
  });

  it('Given an event ingested while the authoritative fetch is in flight, When the list is applied, Then the newer item survives', () => {
    const store = createKimiWebInteractionStore();
    // A is pending when the reconcile starts.
    store.ingestFrame(approvalRequestedAs(APPROVAL_A));
    const since = store.revision();
    // A brand-new approval arrives while listApprovals/listQuestions are running.
    store.ingestFrame(approvalRequestedAs(APPROVAL_B));

    // Another client answered A, so the authoritative list no longer has it.
    store.applyAuthoritative({ sessionId: SESSION_ID, approvals: [], questions: [], sinceRevision: since });

    const pending = store.pendingFor(SESSION_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: APPROVAL_B });
  });

  it('Given the authoritative lists, When applied, Then REST payloads replace event payloads for the same id', () => {
    const store = createKimiWebInteractionStore();
    store.ingestFrame(approvalRequestedAs(APPROVAL_A));

    store.applyAuthoritative({ sessionId: SESSION_ID, approvals: [restApproval(APPROVAL_A)], questions: [] });

    const pending = store.pendingFor(SESSION_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: 'approval', id: APPROVAL_A, source: 'rest' });
  });
});

describe('kimi-web interaction UI shapes', () => {
  it('Given a pending approval, When mapped, Then the shared PermissionRequest carries tool/action and the prefixed id', () => {
    const store = createKimiWebInteractionStore();
    store.ingestFrame(approvalRequestedAs(APPROVAL_A));
    const pending = store.pendingFor(SESSION_ID)[0];
    if (pending.kind !== 'approval') throw new Error('expected an approval');

    const request = kimiWebApprovalToPermissionRequest(pending);
    expect(request.id).toBe(kimiWebApprovalRequestId(APPROVAL_A));
    expect(request.id.startsWith(KIMI_WEB_APPROVAL_REQUEST_PREFIX)).toBe(true);
    expect(request.sessionID).toBe(SESSION_ID);
    expect(request.permission).toBe('Read');
    expect(request.patterns).toEqual(['read_file(/tmp/opencode/kimi-probe/ws-workspace/note.txt)']);
    expect(request.always).toEqual(['read_file(/tmp/opencode/kimi-probe/ws-workspace/note.txt)']);
    expect(parseKimiWebApprovalRequestId(request.id)).toBe(APPROVAL_A);
    expect(parseKimiWebQuestionRequestId(request.id)).toBeNull();
  });

  it('Given a pending question, When mapped, Then the shared QuestionRequest carries options and the prefixed id', () => {
    const store = createKimiWebInteractionStore();
    store.ingestFrame(questionRequestedAs(QUESTION_A));
    const pending = store.pendingFor(SESSION_ID)[0];
    if (pending.kind !== 'question') throw new Error('expected a question');

    const request = kimiWebQuestionToQuestionRequest(pending);
    expect(request.id).toBe(kimiWebQuestionRequestId(QUESTION_A));
    expect(request.id.startsWith(KIMI_WEB_QUESTION_REQUEST_PREFIX)).toBe(true);
    expect(request.sessionID).toBe(SESSION_ID);
    expect(request.questions).toHaveLength(1);
    expect(request.questions[0]).toMatchObject({
      question: 'Which file should I read?',
      header: 'File choice',
      multiple: false,
      custom: true,
    });
    expect(request.questions[0].options).toEqual([
      { label: 'note.txt', description: 'the scratch note' },
      { label: 'README.md', description: '' },
    ]);
    expect(parseKimiWebQuestionRequestId(request.id)).toBe(QUESTION_A);
    expect(parseKimiWebApprovalRequestId(request.id)).toBeNull();
  });
});

describe('kimi-web answer payloads', () => {
  it('Given the shared permission replies, When mapped, Then once/always/reject become the wire decisions', () => {
    expect(kimiWebApprovalAnswerFromReply('once')).toEqual({ decision: 'approved' });
    expect(kimiWebApprovalAnswerFromReply('always')).toEqual({ decision: 'approved', scope: 'session' });
    expect(kimiWebApprovalAnswerFromReply('reject')).toEqual({ decision: 'rejected' });
    expect(kimiWebApprovalAnswerFromReply('nonsense')).toBeNull();
  });

  it('Given label answers for a single-select question, When mapped, Then option ids are resolved', () => {
    const store = createKimiWebInteractionStore();
    store.ingestFrame(questionRequestedAs(QUESTION_A));
    const pending = store.pendingFor(SESSION_ID)[0];
    if (pending.kind !== 'question') throw new Error('expected a question');

    expect(kimiWebQuestionAnswersFromLabels(pending, [['note.txt']])).toEqual({
      answers: { q_0: { kind: 'single', option_id: 'opt_0_0' } },
    });
  });

  it('Given a custom answer, When mapped, Then it becomes an other-text answer', () => {
    const store = createKimiWebInteractionStore();
    store.ingestFrame(questionRequestedAs(QUESTION_A));
    const pending = store.pendingFor(SESSION_ID)[0];
    if (pending.kind !== 'question') throw new Error('expected a question');

    expect(kimiWebQuestionAnswersFromLabels(pending, [['something else']])).toEqual({
      answers: { q_0: { kind: 'other', text: 'something else' } },
    });
  });

  it('Given empty label answers, When mapped, Then null is returned (no malformed POST)', () => {
    const store = createKimiWebInteractionStore();
    store.ingestFrame(questionRequestedAs(QUESTION_A));
    const pending = store.pendingFor(SESSION_ID)[0];
    if (pending.kind !== 'question') throw new Error('expected a question');

    expect(kimiWebQuestionAnswersFromLabels(pending, [[]])).toBeNull();
    expect(kimiWebQuestionAnswersFromLabels(pending, [])).toBeNull();
  });
});

describe('kimi-web answer/dismiss endpoints', () => {
  it('Given a pending approval, When answered once, Then the endpoint receives the exact payload and the item is dropped', async () => {
    const client = createFakeClient();
    const store = createKimiWebInteractionStore();
    store.ingestFrame(approvalRequestedAs(APPROVAL_A));

    const outcome = await answerKimiWebApproval({
      client,
      store,
      sessionId: SESSION_ID,
      approvalId: APPROVAL_A,
      answer: { decision: 'approved' },
    });

    expect(outcome).toEqual({ kind: 'answered' });
    expect(client.calls).toEqual([
      {
        method: 'POST',
        path: `/api/v1/sessions/${SESSION_ID}/approvals/${APPROVAL_A}`,
        body: { decision: 'approved' },
      },
    ]);
    expect(store.pendingFor(SESSION_ID)).toHaveLength(0);
  });

  it('Given a malformed approval answer (no decision), When answering, Then no endpoint call happens', async () => {
    const client = createFakeClient();
    const store = createKimiWebInteractionStore();
    store.ingestFrame(approvalRequestedAs(APPROVAL_A));

    const outcome = await answerKimiWebApproval({
      client,
      store,
      sessionId: SESSION_ID,
      approvalId: APPROVAL_A,
      answer: {} as KimiWebAnswerApprovalInput,
    });

    expect(outcome.kind).toBe('failed');
    expect(client.calls).toEqual([]);
    expect(store.pendingFor(SESSION_ID)).toHaveLength(1);
  });

  it('Given another client already answered, When answering returns 40401, Then the authoritative rebuild converges', async () => {
    const client = createFakeClient({ approvals: [], questions: [] });
    client.failAnswerWith = new KimiWebError(40401, 'approval not found');
    const store = createKimiWebInteractionStore();
    store.ingestFrame(approvalRequestedAs(APPROVAL_A));

    const outcome = await answerKimiWebApproval({
      client,
      store,
      sessionId: SESSION_ID,
      approvalId: APPROVAL_A,
      answer: { decision: 'approved' },
    });

    expect(outcome.kind).toBe('failed');
    if (outcome.kind !== 'failed') throw new Error('expected failure');
    expect(outcome.error).toBeInstanceOf(KimiWebError);
    // The authoritative lists were consulted after the failure.
    expect(client.calls.map((call) => call.path)).toEqual([
      `/api/v1/sessions/${SESSION_ID}/approvals/${APPROVAL_A}`,
      `/api/v1/sessions/${SESSION_ID}/status`,
      `/api/v1/sessions/${SESSION_ID}/approvals`,
      `/api/v1/sessions/${SESSION_ID}/questions`,
    ]);
    expect(store.pendingFor(SESSION_ID)).toHaveLength(0);
  });

  it('Given a network failure while answering, When the reconcile also fails, Then the item stays pending', async () => {
    const client = createFakeClient();
    client.failAnswerWith = new Error('socket closed');
    client.listApprovals = () => Promise.reject(new Error('socket closed'));
    client.listQuestions = () => Promise.reject(new Error('socket closed'));
    const store = createKimiWebInteractionStore();
    store.ingestFrame(approvalRequestedAs(APPROVAL_A));

    const outcome = await answerKimiWebApproval({
      client,
      store,
      sessionId: SESSION_ID,
      approvalId: APPROVAL_A,
      answer: { decision: 'rejected' },
    });

    expect(outcome.kind).toBe('failed');
    expect(store.pendingFor(SESSION_ID)).toHaveLength(1);
  });

  it('Given a pending question, When answered, Then the endpoint receives the mapped answers and the item is dropped', async () => {
    const client = createFakeClient();
    const store = createKimiWebInteractionStore();
    store.ingestFrame(questionRequestedAs(QUESTION_A));

    const outcome = await answerKimiWebQuestion({
      client,
      store,
      sessionId: SESSION_ID,
      questionId: QUESTION_A,
      answer: { answers: { q_0: { kind: 'single', option_id: 'opt_0_0' } } },
    });

    expect(outcome).toEqual({ kind: 'answered' });
    expect(client.calls).toEqual([
      {
        method: 'POST',
        path: `/api/v1/sessions/${SESSION_ID}/questions/${QUESTION_A}`,
        body: { answers: { q_0: { kind: 'single', option_id: 'opt_0_0' } } },
      },
    ]);
    expect(store.pendingFor(SESSION_ID)).toHaveLength(0);
  });

  it('Given a pending question, When dismissed, Then the :dismiss endpoint is called and the item is dropped', async () => {
    const client = createFakeClient();
    const store = createKimiWebInteractionStore();
    store.ingestFrame(questionRequestedAs(QUESTION_A));

    const outcome = await dismissKimiWebQuestion({
      client,
      store,
      sessionId: SESSION_ID,
      questionId: QUESTION_A,
    });

    expect(outcome).toEqual({ kind: 'answered' });
    expect(client.calls).toEqual([
      { method: 'POST', path: `/api/v1/sessions/${SESSION_ID}/questions/${QUESTION_A}:dismiss` },
    ]);
    expect(store.pendingFor(SESSION_ID)).toHaveLength(0);
  });

  it('Given a malformed question answer, When answering, Then no endpoint call happens', async () => {
    const client = createFakeClient();
    const store = createKimiWebInteractionStore();
    store.ingestFrame(questionRequestedAs(QUESTION_A));

    const outcome = await answerKimiWebQuestion({
      client,
      store,
      sessionId: SESSION_ID,
      questionId: QUESTION_A,
      answer: { answers: {} },
    });

    expect(outcome.kind).toBe('failed');
    expect(client.calls).toEqual([]);
    expect(store.pendingFor(SESSION_ID)).toHaveLength(1);
  });
});

describe('kimi-web authoritative reconcile', () => {
  it('Given pending interactions on the server, When reconciling, Then both lists are fetched and the pending set is rebuilt', async () => {
    const client = createFakeClient({
      approvals: [restApproval(APPROVAL_A)],
      questions: [restQuestion(QUESTION_A)],
    });
    const store = createKimiWebInteractionStore();

    const result = await reconcileKimiWebInteractions({ client, store, sessionId: SESSION_ID });

    expect(result.ok).toBe(true);
    expect(client.calls.map((call) => call.path)).toEqual([
      `/api/v1/sessions/${SESSION_ID}/status`,
      `/api/v1/sessions/${SESSION_ID}/approvals`,
      `/api/v1/sessions/${SESSION_ID}/questions`,
    ]);
    const pending = store.pendingFor(SESSION_ID);
    expect(pending).toHaveLength(2);
    expect(pending[0]).toMatchObject({ kind: 'approval', id: APPROVAL_A, source: 'rest' });
    expect(pending[1]).toMatchObject({ kind: 'question', id: QUESTION_A, source: 'rest' });
  });

  it('Given the session declares an approval the first list read missed, When reconciling, Then the lists are refetched once', async () => {
    const client = createFakeClient({
      approvals: [],
      questions: [],
      status: { pending_interaction: 'approval' },
      refetchApprovals: [restApproval(APPROVAL_A)],
    });
    const store = createKimiWebInteractionStore();

    const result = await reconcileKimiWebInteractions({ client, store, sessionId: SESSION_ID });

    expect(result).toMatchObject({ ok: true, refetched: true });
    expect(store.pendingFor(SESSION_ID)).toHaveLength(1);
    expect(store.pendingFor(SESSION_ID)[0]).toMatchObject({ kind: 'approval', id: APPROVAL_A });
  });

  it('Given a stale selection, When the reconcile returns, Then the store is not mutated', async () => {
    const client = createFakeClient({ approvals: [restApproval(APPROVAL_A)] });
    const store = createKimiWebInteractionStore();
    store.ingestFrame(approvalRequestedAs(APPROVAL_B));

    const result = await reconcileKimiWebInteractions({
      client,
      store,
      sessionId: SESSION_ID,
      isCurrent: () => false,
    });

    expect(result.ok).toBe(true);
    const pending = store.pendingFor(SESSION_ID);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ id: APPROVAL_B });
  });

  it('Given the list endpoint fails, When reconciling, Then the local pending set is preserved (never blanked)', async () => {
    const client = createFakeClient();
    client.listApprovals = () => Promise.reject(new KimiWebError(50000, 'boom'));
    const store = createKimiWebInteractionStore();
    store.ingestFrame(approvalRequestedAs(APPROVAL_A));

    const result = await reconcileKimiWebInteractions({ client, store, sessionId: SESSION_ID });

    expect(result.ok).toBe(false);
    expect(store.pendingFor(SESSION_ID)).toHaveLength(1);
  });
});

describe('kimi-web session pending_interaction reconcile trigger', () => {
  function sessionOp(patch: Partial<KimiWebSessionDeclaringOp> = {}): KimiWebSessionDeclaringOp {
    return {
      kind: 'session',
      phase: 'work-changed',
      sessionId: SESSION_ID,
      ...patch,
    } as KimiWebSessionDeclaringOp;
  }

  it('Given an empty local set, When the session declares an approval, Then a reconcile is requested', () => {
    const store = createKimiWebInteractionStore();
    expect(kimiWebSessionOpNeedsReconcile(sessionOp({ pendingInteraction: 'approval' }), store)).toBe(true);
    expect(kimiWebSessionOpNeedsReconcile(sessionOp({ pendingInteraction: 'question' }), store)).toBe(true);
  });

  it('Given the item is already pending, When the same kind is declared, Then no reconcile is requested', () => {
    const store = createKimiWebInteractionStore();
    store.ingestFrame(approvalRequestedAs(APPROVAL_A));
    expect(kimiWebSessionOpNeedsReconcile(sessionOp({ pendingInteraction: 'approval' }), store)).toBe(false);
    expect(kimiWebSessionOpNeedsReconcile(sessionOp({ pendingInteraction: 'question' }), store)).toBe(true);
  });

  it('Given a stale local item, When the session declares none, Then a reconcile is requested (lists still decide)', () => {
    const store = createKimiWebInteractionStore();
    store.ingestFrame(approvalRequestedAs(APPROVAL_A));
    expect(kimiWebSessionOpNeedsReconcile(sessionOp({ pendingInteraction: 'none' }), store)).toBe(true);
  });

  it('Given an empty local set, When the session declares none, Then no reconcile is requested', () => {
    const store = createKimiWebInteractionStore();
    expect(kimiWebSessionOpNeedsReconcile(sessionOp({ pendingInteraction: 'none' }), store)).toBe(false);
  });

  it('Given the op carries no declaration, When evaluated, Then no reconcile is requested', () => {
    const store = createKimiWebInteractionStore();
    expect(kimiWebSessionOpNeedsReconcile(sessionOp(), store)).toBe(false);
    expect(kimiWebSessionOpNeedsReconcile(sessionOp({ pendingInteraction: 'bogus' }), store)).toBe(false);
  });

  it('Given the declared session is not the one with a stale item, When evaluated, Then only that session slice is considered', () => {
    const store = createKimiWebInteractionStore();
    store.ingestFrame(approvalRequestedAs(APPROVAL_A, OTHER_SESSION_ID));
    expect(
      kimiWebSessionOpNeedsReconcile(
        sessionOp({ sessionId: SESSION_ID, pendingInteraction: 'none' }),
        store,
      ),
    ).toBe(false);
    expect(
      kimiWebSessionOpNeedsReconcile(
        sessionOp({ sessionId: OTHER_SESSION_ID, pendingInteraction: 'none' }),
        store,
      ),
    ).toBe(true);
  });

  it('Given a declared approval with no local item, When the trigger fires and reconcile runs, Then the authoritative list converges', async () => {
    const client = createFakeClient({ approvals: [restApproval(APPROVAL_A)] });
    const store = createKimiWebInteractionStore();
    const op = sessionOp({ pendingInteraction: 'approval' });

    expect(kimiWebSessionOpNeedsReconcile(op, store)).toBe(true);
    await reconcileKimiWebInteractions({ client, store, sessionId: op.sessionId });

    expect(store.pendingFor(SESSION_ID)).toHaveLength(1);
    expect(store.pendingFor(SESSION_ID)[0]).toMatchObject({ kind: 'approval', id: APPROVAL_A });
    expect(kimiWebSessionOpNeedsReconcile(op, store)).toBe(false);
  });
});

describe('kimi-web interaction frame attachment', () => {
  it('Given an attached store, When interaction frames arrive, Then the change callback fires per event', () => {
    const source = new FakeFrameSource();
    const store = createKimiWebInteractionStore();
    let changes = 0;
    let reconnects = 0;
    const detach = attachKimiWebInteractions({
      client: source,
      store,
      onInteractionsChanged: () => {
        changes += 1;
      },
      onReconnected: () => {
        reconnects += 1;
      },
    });

    source.emitFrame(approvalRequestedAs(APPROVAL_A));
    expect(changes).toBe(1);
    expect(store.pendingFor(SESSION_ID)).toHaveLength(1);

    // Non-interaction frames do not notify.
    const turnEnded = derivedFrames.find((entry) => entry.type === 'turn.ended');
    source.emitFrame(turnEnded!);
    expect(changes).toBe(1);

    source.emitReconnectReady();
    expect(reconnects).toBe(1);

    detach();
    source.emitFrame(approvalResolvedAs(APPROVAL_A));
    source.emitReconnectReady();
    expect(changes).toBe(1);
    expect(reconnects).toBe(1);
    expect(store.pendingFor(SESSION_ID)).toHaveLength(1);
  });
});

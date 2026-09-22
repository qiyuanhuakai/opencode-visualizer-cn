import { createApp, computed, defineComponent, h, nextTick, ref, watch, type App } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { KimiWebError } from '../utils/kimiWeb';
import type {
  KimiWebAnswerApprovalInput,
  KimiWebAnswerQuestionInput,
  KimiWebApproval,
  KimiWebQuestion,
} from '../utils/kimiWeb';
import type { KimiWebWsAck, KimiWebWsFrame } from '../utils/kimiWebWs';
import type { BackendKind } from '../backends/types';
import FloatingWindow from '../components/FloatingWindow.vue';
import {
  KIMI_WEB_APPROVAL_REQUEST_PREFIX,
  KIMI_WEB_QUESTION_REQUEST_PREFIX,
  answerKimiWebApproval,
  answerKimiWebQuestion,
  attachKimiWebInteractions,
  createKimiWebInteractionStore,
  dismissKimiWebQuestion,
  kimiWebApprovalAnswerFromReply,
  kimiWebApprovalToPermissionRequest,
  kimiWebQuestionAnswersFromLabels,
  kimiWebQuestionToQuestionRequest,
  parseKimiWebApprovalRequestId,
  parseKimiWebQuestionRequestId,
  reconcileKimiWebInteractions,
  type KimiWebInteractionClient,
  type KimiWebPendingInteraction,
} from '../backends/kimiWeb/interactions';
import { useFloatingWindows } from './useFloatingWindows';
import { usePermissions, type PermissionReply } from './usePermissions';
import { useQuestions } from './useQuestions';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
vi.mock('../utils/workerRenderer', async (importOriginal) => {
  const original = await importOriginal<typeof import('../utils/workerRenderer')>();
  return {
    ...original,
    startRenderWorkerHtml: (request: { code: string }) => ({
      promise: Promise.resolve(`<p>${request.code}</p>`),
      cancel: () => undefined,
    }),
  };
});
vi.mock('../components/MessageViewer.vue', () => ({
  default: defineComponent(() => () => h('div', { class: 'message-viewer-stub' })),
}));

/**
 * Kimi Web approvals/questions integration (Todo 19).
 *
 * Mirrors the App.vue kimi-web interaction block the same way
 * `useKimiWebPopups.integration.test.ts` mirrors the popup block: the mounted
 * chain is client (real fixture frames) -> interaction store -> the shared
 * `usePermissions` / `useQuestions` composables -> the real
 * `useFloatingWindows` -> the real `FloatingWindow` component. Answers travel
 * through the same `sendReply` / `sendReject` seams App.vue passes in, so the
 * endpoint + payload assertions exercise the production wiring shape.
 */

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
const questionDismissed = frame('event.question.dismissed');
const turnEnded = frame('turn.ended');

function approvalRequestedAs(id: string, sessionId = SESSION_ID): KimiWebWsFrame {
  return cloneFrame(approvalRequested, { session_id: sessionId, payload: { approval_id: id, session_id: sessionId, sessionId } });
}

function approvalResolvedAs(id: string, sessionId = SESSION_ID): KimiWebWsFrame {
  return cloneFrame(approvalResolved, { session_id: sessionId, payload: { approval_id: id, session_id: sessionId, sessionId } });
}

function questionRequestedAs(id: string, sessionId = SESSION_ID): KimiWebWsFrame {
  return cloneFrame(questionRequested, { session_id: sessionId, payload: { question_id: id, session_id: sessionId, sessionId } });
}

function questionDismissedAs(id: string, sessionId = SESSION_ID): KimiWebWsFrame {
  return cloneFrame(questionDismissed, { session_id: sessionId, payload: { question_id: id, session_id: sessionId, sessionId } });
}

class FakeSource {
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

type RecordedCall = { method: string; path: string; body?: unknown };

function restApproval(id: string, overrides: Partial<KimiWebApproval> = {}): KimiWebApproval {
  return {
    approval_id: id,
    session_id: SESSION_ID,
    turn_id: 1,
    tool_call_id: 'tool_LLLyHODIa03gVnx5RCNr8z20',
    tool_name: 'Read',
    action: 'read_file(/tmp/note.txt)',
    ...overrides,
  };
}

function restQuestion(id: string): KimiWebQuestion {
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
  };
}

function createFakeClient(options: {
  approvals?: KimiWebApproval[];
  questions?: KimiWebQuestion[];
  answerRejection?: unknown;
} = {}) {
  const calls: RecordedCall[] = [];
  const state = {
    approvals: options.approvals ?? [],
    questions: options.questions ?? [],
  };
  const client: KimiWebInteractionClient = {
    getSessionStatus: (sessionId: string) => {
      calls.push({ method: 'GET', path: `/api/v1/sessions/${sessionId}/status` });
      return Promise.resolve({ busy: false } as never);
    },
    listApprovals: (sessionId: string) => {
      calls.push({ method: 'GET', path: `/api/v1/sessions/${sessionId}/approvals` });
      return Promise.resolve({ items: state.approvals });
    },
    listQuestions: (sessionId: string) => {
      calls.push({ method: 'GET', path: `/api/v1/sessions/${sessionId}/questions` });
      return Promise.resolve({ items: state.questions });
    },
    answerApproval: (sessionId: string, approvalId: string, answer: KimiWebAnswerApprovalInput) => {
      calls.push({ method: 'POST', path: `/api/v1/sessions/${sessionId}/approvals/${approvalId}`, body: answer });
      if (options.answerRejection) return Promise.reject(options.answerRejection);
      state.approvals = state.approvals.filter((entry) => entry.approval_id !== approvalId);
      return Promise.resolve({ resolved: true });
    },
    answerQuestion: (sessionId: string, questionId: string, answer: KimiWebAnswerQuestionInput) => {
      calls.push({ method: 'POST', path: `/api/v1/sessions/${sessionId}/questions/${questionId}`, body: answer });
      if (options.answerRejection) return Promise.reject(options.answerRejection);
      state.questions = state.questions.filter((entry) => entry.question_id !== questionId);
      return Promise.resolve({ resolved: true });
    },
    dismissQuestion: (sessionId: string, questionId: string) => {
      calls.push({ method: 'POST', path: `/api/v1/sessions/${sessionId}/questions/${questionId}:dismiss` });
      if (options.answerRejection) return Promise.reject(options.answerRejection);
      state.questions = state.questions.filter((entry) => entry.question_id !== questionId);
      return Promise.resolve({ resolved: true });
    },
  };
  return { client, calls, state };
}

async function flushUi() {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

type InteractionChain = {
  source: FakeSource;
  windows: ReturnType<typeof useFloatingWindows>;
  permissions: ReturnType<typeof usePermissions>;
  questions: ReturnType<typeof useQuestions>;
  calls: RecordedCall[];
  state: { approvals: KimiWebApproval[]; questions: KimiWebQuestion[] };
  selectedSessionId: ReturnType<typeof ref<string>>;
  activeBackendKind: ReturnType<typeof ref<BackendKind>>;
  reconcile: () => Promise<void>;
  windowKeys: () => string[];
  target: HTMLDivElement;
};

const apps: App[] = [];

afterEach(() => {
  apps.splice(0).forEach((app) => app.unmount());
});

// allow: SIZE_OK — one end-to-end fixture keeps the wire, store, shared dialog composables and real components connected.
async function mountInteractionChain(options: {
  approvals?: KimiWebApproval[];
  questions?: KimiWebQuestion[];
  answerRejection?: unknown;
  sessionId?: string;
} = {}): Promise<InteractionChain> {
  const source = new FakeSource();
  const selectedSessionId = ref(options.sessionId ?? SESSION_ID);
  const activeBackendKind = ref<BackendKind>('kimi-web');
  const { client, calls, state } = createFakeClient(options);
  const target = document.createElement('div');
  document.body.append(target);

  let windows: ReturnType<typeof useFloatingWindows> | undefined;
  let permissions: ReturnType<typeof usePermissions> | undefined;
  let questions: ReturnType<typeof useQuestions> | undefined;
  let reconcile: (() => Promise<void>) | undefined;

  const app = createApp(defineComponent({
    setup() {
      const fw = useFloatingWindows();
      const activeDirectory = ref('');

      // ----- App.vue mirror: kimi-web interaction wiring (Todo 19) -----
      const kimiWebInteractions = createKimiWebInteractionStore();
      const kimiWebPendingInteractions = ref<KimiWebPendingInteraction[]>([]);
      let lastKimiWebPendingSignature = '';
      const kimiWebReconcileInFlight = new Set<string>();

      function refreshKimiWebPendingInteractions() {
        const sessionId = activeBackendKind.value === 'kimi-web' ? selectedSessionId.value : '';
        const items = sessionId ? kimiWebInteractions.pendingFor(sessionId) : [];
        const signature = items.map((item) => `${item.kind}:${item.id}`).join('|');
        if (signature === lastKimiWebPendingSignature) return;
        lastKimiWebPendingSignature = signature;
        kimiWebPendingInteractions.value = items;
      }

      async function reconcileKimiWebSelectedSession() {
        if (activeBackendKind.value !== 'kimi-web') return;
        const sessionId = selectedSessionId.value;
        if (!sessionId) return;
        if (kimiWebReconcileInFlight.has(sessionId)) return;
        kimiWebReconcileInFlight.add(sessionId);
        try {
          await reconcileKimiWebInteractions({
            client,
            store: kimiWebInteractions,
            sessionId,
            isCurrent: () =>
              activeBackendKind.value === 'kimi-web' && selectedSessionId.value === sessionId,
          });
        } finally {
          kimiWebReconcileInFlight.delete(sessionId);
        }
        refreshKimiWebPendingInteractions();
      }

      attachKimiWebInteractions({
        client: source,
        store: kimiWebInteractions,
        onInteractionsChanged: refreshKimiWebPendingInteractions,
        onReconnected: () => {
          void reconcileKimiWebSelectedSession();
        },
      });

      async function replyKimiWebApproval(approvalId: string, reply: PermissionReply) {
        const pending = kimiWebInteractions.findById(approvalId);
        const answer = kimiWebApprovalAnswerFromReply(reply);
        if (!pending || pending.kind !== 'approval' || !answer) {
          throw new Error('Kimi Web approval request is no longer available.');
        }
        const outcome = await answerKimiWebApproval({
          client,
          store: kimiWebInteractions,
          sessionId: pending.sessionId,
          approvalId,
          answer,
        });
        refreshKimiWebPendingInteractions();
        if (outcome.kind === 'failed') {
          throw outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
        }
      }

      async function replyKimiWebQuestion(questionId: string, labelAnswers: string[][]) {
        const pending = kimiWebInteractions.findById(questionId);
        if (!pending || pending.kind !== 'question') {
          throw new Error('Kimi Web question request is no longer available.');
        }
        const answer = kimiWebQuestionAnswersFromLabels(pending, labelAnswers);
        if (!answer) throw new Error('Kimi Web question answer is empty.');
        const outcome = await answerKimiWebQuestion({
          client,
          store: kimiWebInteractions,
          sessionId: pending.sessionId,
          questionId,
          answer,
        });
        refreshKimiWebPendingInteractions();
        if (outcome.kind === 'failed') {
          throw outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
        }
      }

      async function dismissKimiWebQuestionRequest(questionId: string) {
        const pending = kimiWebInteractions.findById(questionId);
        if (!pending || pending.kind !== 'question') {
          throw new Error('Kimi Web question request is no longer available.');
        }
        const outcome = await dismissKimiWebQuestion({
          client,
          store: kimiWebInteractions,
          sessionId: pending.sessionId,
          questionId,
        });
        refreshKimiWebPendingInteractions();
        if (outcome.kind === 'failed') {
          throw outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error));
        }
      }

      const permissionEntries = usePermissions({
        fw,
        allowedSessionIds: computed(() => new Set([selectedSessionId.value])),
        activeDirectory,
        ensureConnectionReady: () => true,
        sendReply: async (requestId, reply) => {
          if (activeBackendKind.value === 'kimi-web') {
            const approvalId = parseKimiWebApprovalRequestId(requestId);
            if (approvalId) {
              await replyKimiWebApproval(approvalId, reply as PermissionReply);
              return;
            }
          }
          throw new Error(`Unsupported permission request: ${requestId}`);
        },
      });

      const questionEntries = useQuestions({
        fw,
        allowedSessionIds: computed(() => new Set([selectedSessionId.value])),
        activeDirectory,
        ensureConnectionReady: () => true,
        getTextContent: () => '',
        sendReply: async (requestId, answers) => {
          if (activeBackendKind.value === 'kimi-web') {
            const questionId = parseKimiWebQuestionRequestId(requestId);
            if (questionId) {
              await replyKimiWebQuestion(questionId, answers as string[][]);
              return;
            }
          }
          throw new Error(`Unsupported question request: ${requestId}`);
        },
        sendReject: async (requestId) => {
          if (activeBackendKind.value === 'kimi-web') {
            const questionId = parseKimiWebQuestionRequestId(requestId);
            if (questionId) {
              await dismissKimiWebQuestionRequest(questionId);
              return;
            }
          }
          throw new Error(`Unsupported question request: ${requestId}`);
        },
      });

      const kimiWebApprovalDialogIds = ref<Set<string>>(new Set());
      const kimiWebQuestionDialogIds = ref<Set<string>>(new Set());

      watch(kimiWebPendingInteractions, (items) => {
        if (activeBackendKind.value !== 'kimi-web') return;
        const approvalIds = new Set<string>();
        const questionIds = new Set<string>();
        for (const item of items) {
          if (item.kind === 'approval') {
            const request = kimiWebApprovalToPermissionRequest(item);
            approvalIds.add(request.id);
            permissionEntries.upsertPermissionEntry(request);
          } else {
            const request = kimiWebQuestionToQuestionRequest(item);
            questionIds.add(request.id);
            questionEntries.upsertQuestionEntry(request);
          }
        }
        kimiWebApprovalDialogIds.value.forEach((id) => {
          if (!approvalIds.has(id)) permissionEntries.removePermissionEntry(id);
        });
        kimiWebQuestionDialogIds.value.forEach((id) => {
          if (!questionIds.has(id)) questionEntries.removeQuestionEntry(id);
        });
        kimiWebApprovalDialogIds.value = approvalIds;
        kimiWebQuestionDialogIds.value = questionIds;
      });

      watch(selectedSessionId, (nextId, previousId) => {
        if (activeBackendKind.value !== 'kimi-web') return;
        if (previousId && previousId !== nextId) kimiWebInteractions.clearSession(previousId);
        refreshKimiWebPendingInteractions();
        void reconcileKimiWebSelectedSession();
      });
      // ----- end App.vue mirror -----

      windows = fw;
      permissions = permissionEntries;
      questions = questionEntries;
      reconcile = reconcileKimiWebSelectedSession;
      return () =>
        h('main', fw.entries.value.map((entry) => h(FloatingWindow, { entry, manager: fw })));
    },
  }));
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en: {} } }));
  app.mount(target);
  apps.push(app);
  if (!windows || !permissions || !questions || !reconcile) {
    throw new Error('Interaction chain did not mount');
  }
  return {
    source,
    windows,
    permissions,
    questions,
    calls,
    state,
    selectedSessionId,
    activeBackendKind,
    reconcile,
    windowKeys: () => windows!.entries.value.map((entry) => entry.key),
    target,
  };
}

describe('kimi-web interaction UI wiring', () => {
  let chain: InteractionChain;

  beforeEach(async () => {
    chain = await mountInteractionChain();
  });

  it('Given a live event.approval.requested frame, When it arrives, Then the shared permission window opens', async () => {
    chain.source.emitFrame(approvalRequestedAs(APPROVAL_A));
    await flushUi();

    const key = `permission:${KIMI_WEB_APPROVAL_REQUEST_PREFIX}${APPROVAL_A}`;
    expect(chain.windowKeys()).toContain(key);
    const entry = chain.windows.entries.value.find((item) => item.key === key);
    expect(entry?.props?.request).toMatchObject({
      sessionID: SESSION_ID,
      permission: 'Read',
      patterns: ['read_file(/tmp/opencode/kimi-probe/ws-workspace/note.txt)'],
    });
  });

  it('Given a live event.question.requested frame, When it arrives, Then the shared question window opens', async () => {
    chain.source.emitFrame(questionRequestedAs(QUESTION_A));
    await flushUi();

    const key = `question:${KIMI_WEB_QUESTION_REQUEST_PREFIX}${QUESTION_A}`;
    expect(chain.windowKeys()).toContain(key);
    const entry = chain.windows.entries.value.find((item) => item.key === key);
    expect(entry?.props?.request).toMatchObject({
      sessionID: SESSION_ID,
      questions: [{ question: 'Which file should I read?', header: 'File choice', multiple: false, custom: true }],
    });
  });

  it('Given an open permission window, When the user approves once, Then POST approvals receives {decision:approved}', async () => {
    chain.source.emitFrame(approvalRequestedAs(APPROVAL_A));
    await flushUi();
    const requestId = `${KIMI_WEB_APPROVAL_REQUEST_PREFIX}${APPROVAL_A}`;

    await chain.permissions.handlePermissionReply({ requestId, reply: 'once' });
    await flushUi();

    expect(chain.calls).toEqual([
      {
        method: 'POST',
        path: `/api/v1/sessions/${SESSION_ID}/approvals/${APPROVAL_A}`,
        body: { decision: 'approved' },
      },
    ]);
    expect(chain.windowKeys()).not.toContain(`permission:${requestId}`);
  });

  it('Given an open permission window, When the user always-approves, Then the session scope is sent', async () => {
    chain.source.emitFrame(approvalRequestedAs(APPROVAL_A));
    await flushUi();
    const requestId = `${KIMI_WEB_APPROVAL_REQUEST_PREFIX}${APPROVAL_A}`;

    await chain.permissions.handlePermissionReply({ requestId, reply: 'always' });
    await flushUi();

    expect(chain.calls).toEqual([
      {
        method: 'POST',
        path: `/api/v1/sessions/${SESSION_ID}/approvals/${APPROVAL_A}`,
        body: { decision: 'approved', scope: 'session' },
      },
    ]);
    expect(chain.windowKeys()).not.toContain(`permission:${requestId}`);
  });

  it('Given an open permission window, When the user rejects, Then POST approvals receives {decision:rejected}', async () => {
    chain.source.emitFrame(approvalRequestedAs(APPROVAL_A));
    await flushUi();
    const requestId = `${KIMI_WEB_APPROVAL_REQUEST_PREFIX}${APPROVAL_A}`;

    await chain.permissions.handlePermissionReply({ requestId, reply: 'reject' });
    await flushUi();

    expect(chain.calls).toEqual([
      {
        method: 'POST',
        path: `/api/v1/sessions/${SESSION_ID}/approvals/${APPROVAL_A}`,
        body: { decision: 'rejected' },
      },
    ]);
    expect(chain.windowKeys()).not.toContain(`permission:${requestId}`);
  });

  it('Given an open question window, When the user answers, Then POST questions receives the mapped option id', async () => {
    chain.source.emitFrame(questionRequestedAs(QUESTION_A));
    await flushUi();
    const requestId = `${KIMI_WEB_QUESTION_REQUEST_PREFIX}${QUESTION_A}`;

    await chain.questions.handleQuestionReply({ requestId, answers: [['note.txt']] });
    await flushUi();

    expect(chain.calls).toEqual([
      {
        method: 'POST',
        path: `/api/v1/sessions/${SESSION_ID}/questions/${QUESTION_A}`,
        body: { answers: { q_0: { kind: 'single', option_id: 'opt_0_0' } } },
      },
    ]);
    expect(chain.windowKeys()).not.toContain(`question:${requestId}`);
  });

  it('Given an open question window, When the user dismisses, Then the :dismiss endpoint is called', async () => {
    chain.source.emitFrame(questionRequestedAs(QUESTION_A));
    await flushUi();
    const requestId = `${KIMI_WEB_QUESTION_REQUEST_PREFIX}${QUESTION_A}`;

    await chain.questions.handleQuestionReject(requestId);
    await flushUi();

    expect(chain.calls).toEqual([
      { method: 'POST', path: `/api/v1/sessions/${SESSION_ID}/questions/${QUESTION_A}:dismiss` },
    ]);
    expect(chain.windowKeys()).not.toContain(`question:${requestId}`);
  });

  it('Given two pending approvals, When A resolves, Then only A window closes and B stays open', async () => {
    chain.source.emitFrame(approvalRequestedAs(APPROVAL_A));
    chain.source.emitFrame(approvalRequestedAs(APPROVAL_B));
    await flushUi();
    expect(chain.windowKeys()).toHaveLength(2);

    chain.source.emitFrame(approvalResolvedAs(APPROVAL_A));
    await flushUi();

    expect(chain.windowKeys()).toEqual([`permission:${KIMI_WEB_APPROVAL_REQUEST_PREFIX}${APPROVAL_B}`]);
  });

  it("Given A resolved earlier, When A's late resolved event arrives again, Then the newer B window stays open", async () => {
    chain.source.emitFrame(approvalRequestedAs(APPROVAL_A));
    chain.source.emitFrame(approvalResolvedAs(APPROVAL_A));
    chain.source.emitFrame(approvalRequestedAs(APPROVAL_B));
    await flushUi();
    expect(chain.windowKeys()).toEqual([`permission:${KIMI_WEB_APPROVAL_REQUEST_PREFIX}${APPROVAL_B}`]);

    chain.source.emitFrame(approvalResolvedAs(APPROVAL_A));
    await flushUi();

    expect(chain.windowKeys()).toEqual([`permission:${KIMI_WEB_APPROVAL_REQUEST_PREFIX}${APPROVAL_B}`]);
  });

  it('Given two pending questions, When A is dismissed by event, Then only the A window closes', async () => {
    chain.source.emitFrame(questionRequestedAs(QUESTION_A));
    chain.source.emitFrame(questionRequestedAs(QUESTION_B));
    await flushUi();
    expect(chain.windowKeys()).toHaveLength(2);

    chain.source.emitFrame(questionDismissedAs(QUESTION_A));
    await flushUi();

    expect(chain.windowKeys()).toEqual([`question:${KIMI_WEB_QUESTION_REQUEST_PREFIX}${QUESTION_B}`]);
  });

  it('Given a pending approval, When turn.ended arrives, Then the permission window stays open', async () => {
    chain.source.emitFrame(approvalRequestedAs(APPROVAL_A));
    await flushUi();

    chain.source.emitFrame(turnEnded);
    await flushUi();

    expect(chain.windowKeys()).toEqual([`permission:${KIMI_WEB_APPROVAL_REQUEST_PREFIX}${APPROVAL_A}`]);
  });

  it('Given a failed answer with the server still listing the approval, When it settles, Then the window stays open', async () => {
    const failedChain = await mountInteractionChain({
      approvals: [restApproval(APPROVAL_A)],
      answerRejection: new Error('socket closed'),
    });
    failedChain.source.emitFrame(approvalRequestedAs(APPROVAL_A));
    await flushUi();
    const requestId = `${KIMI_WEB_APPROVAL_REQUEST_PREFIX}${APPROVAL_A}`;

    await failedChain.permissions.handlePermissionReply({ requestId, reply: 'once' });
    await flushUi();

    const key = `permission:${requestId}`;
    expect(failedChain.windowKeys()).toContain(key);
    const entry = failedChain.windows.entries.value.find((item) => item.key === key);
    expect(String(entry?.props?.error ?? '')).toContain('socket closed');
  });

  it('Given a pending interaction on the server at connect time, When the reconcile runs without any event, Then both windows render', async () => {
    const initial = await mountInteractionChain({
      approvals: [restApproval(APPROVAL_A)],
      questions: [restQuestion(QUESTION_A)],
    });

    await initial.reconcile();
    await flushUi();

    expect(initial.windowKeys()).toEqual([
      `permission:${KIMI_WEB_APPROVAL_REQUEST_PREFIX}${APPROVAL_A}`,
      `question:${KIMI_WEB_QUESTION_REQUEST_PREFIX}${QUESTION_A}`,
    ]);
    expect(initial.calls.map((call) => call.path)).toEqual([
      `/api/v1/sessions/${SESSION_ID}/status`,
      `/api/v1/sessions/${SESSION_ID}/approvals`,
      `/api/v1/sessions/${SESSION_ID}/questions`,
    ]);
  });

  it('Given a reconnect, When the replay boundary ack arrives, Then the pending set is rebuilt from the server', async () => {
    const reconnected = await mountInteractionChain({
      approvals: [restApproval(APPROVAL_A)],
    });

    reconnected.source.emitReconnectReady();
    await flushUi();

    expect(reconnected.windowKeys()).toEqual([
      `permission:${KIMI_WEB_APPROVAL_REQUEST_PREFIX}${APPROVAL_A}`,
    ]);
  });

  it('Given a pending approval, When the user switches sessions, Then the window closes and the old slice is dropped', async () => {
    chain.source.emitFrame(approvalRequestedAs(APPROVAL_A));
    await flushUi();
    expect(chain.windowKeys()).toHaveLength(1);

    chain.selectedSessionId.value = OTHER_SESSION_ID;
    await flushUi();

    expect(chain.windowKeys()).toEqual([]);
  });

  it('Given another active backend, When interaction frames arrive, Then no window opens', async () => {
    chain.activeBackendKind.value = 'codex';
    chain.source.emitFrame(approvalRequestedAs(APPROVAL_A));
    await flushUi();

    expect(chain.windowKeys()).toEqual([]);
  });
});

describe('kimi-web two-client convergence', () => {
  it('Given the other client already resolved the approval, When answering returns 40401, Then the item converges away', async () => {
    const chain = await mountInteractionChain({
      approvals: [],
      answerRejection: new KimiWebError(40401, 'approval not found'),
    });
    chain.source.emitFrame(approvalRequestedAs(APPROVAL_A));
    await flushUi();
    const requestId = `${KIMI_WEB_APPROVAL_REQUEST_PREFIX}${APPROVAL_A}`;

    await chain.permissions.handlePermissionReply({ requestId, reply: 'once' });
    await flushUi();

    expect(chain.calls.map((call) => call.path)).toEqual([
      `/api/v1/sessions/${SESSION_ID}/approvals/${APPROVAL_A}`,
      `/api/v1/sessions/${SESSION_ID}/status`,
      `/api/v1/sessions/${SESSION_ID}/approvals`,
      `/api/v1/sessions/${SESSION_ID}/questions`,
    ]);
    expect(chain.windowKeys()).not.toContain(`permission:${requestId}`);
  });
});

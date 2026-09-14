import { vi } from 'vitest';
import type { CodexAdapter, CodexPromptResult } from '../backends/codex/codexAdapter';
import type { CodexJsonRpcId, CodexJsonRpcNotification } from '../backends/codex/jsonRpcClient';

export function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

export function createAdapterMock() {
  let notificationHandler: ((notification: CodexJsonRpcNotification) => void) | null = null;
  let serverRequestHandler:
    | ((request: { id: CodexJsonRpcId; method: string; params?: unknown }) => void)
    | null = null;
  const adapter = {
    initialize: vi.fn().mockResolvedValue({ userAgent: 'codex-test' }),
    disconnect: vi.fn(),
    onNotification: vi.fn((handler: (notification: CodexJsonRpcNotification) => void) => {
      notificationHandler = handler;
      return vi.fn(() => {
        notificationHandler = null;
      });
    }),
    onServerRequest: vi.fn(
      (handler: (request: { id: CodexJsonRpcId; method: string; params?: unknown }) => void) => {
        serverRequestHandler = handler;
        return vi.fn(() => {
          serverRequestHandler = null;
        });
      },
    ),
    listThreads: vi.fn().mockResolvedValue({
      data: [{ id: 'thr_existing', preview: 'Existing thread' }],
      nextCursor: null,
    }),
    startThread: vi.fn().mockResolvedValue({ thread: { id: 'thr_new', preview: '' } }),
    listThreadTurns: vi.fn().mockResolvedValue({ data: [], nextCursor: null }),
    readThread: vi.fn((params: { threadId: string }) =>
      Promise.resolve({
        thread: {
          id: params.threadId,
          name: params.threadId === 'thr_fork' ? 'Forked thread' : 'Existing named thread',
          turns: [
            {
              id: 'turn_old',
              items: [
                {
                  type: 'userMessage',
                  id: 'u1',
                  content: [{ type: 'text', text: `${params.threadId} prompt` }],
                },
                {
                  type: 'agentMessage',
                  id: 'a1',
                  text: `${params.threadId} answer`,
                },
              ],
            },
          ],
        },
      }),
    ),
    resumeThread: vi.fn().mockResolvedValue({
      thread: { id: 'thr_existing', name: 'Existing named thread' },
    }),
    setThreadName: vi.fn().mockResolvedValue({}),
    archiveThread: vi.fn().mockResolvedValue({}),
    unsubscribeThread: vi.fn().mockResolvedValue({}),
    interruptTurn: vi.fn().mockResolvedValue({}),
    forkThread: vi.fn().mockResolvedValue({ thread: { id: 'thr_fork', preview: '' } }),
    rollbackThread: vi.fn().mockResolvedValue({
      thread: { id: 'thr_existing', name: 'Existing named thread' },
    }),
    revertThread: vi.fn().mockResolvedValue({
      thread: { id: 'thr_existing', historyMode: 'paginated' },
      turnsBackwardsCursor: null,
      itemsBackwardsCursor: null,
    }),
    readDirectory: vi.fn().mockResolvedValue({ entries: [{ name: 'file.txt', type: 'file' }] }),
    readFile: vi.fn().mockResolvedValue({ dataBase64: 'aGVsbG8=' }),
    listCollaborationModes: vi.fn().mockResolvedValue({ data: [] }),
    getThreadGoal: vi.fn().mockResolvedValue({ goal: null }),
    setThreadGoal: vi.fn(),
    clearThreadGoal: vi.fn(),
    readAccountUsage: vi.fn().mockResolvedValue({
      summary: {
        lifetimeTokens: null,
        peakDailyTokens: null,
        longestRunningTurnSec: null,
        currentStreakDays: null,
        longestStreakDays: null,
      },
      dailyUsageBuckets: null,
    }),
    readModelProviderCapabilities: vi.fn().mockResolvedValue({
      namespaceTools: false,
      imageGeneration: false,
      webSearch: false,
    }),
    listPermissionProfiles: vi.fn().mockResolvedValue({ data: [], nextCursor: null }),
    listLoadedThreads: vi.fn().mockResolvedValue({ data: ['thr_existing'] }),
    respondToServerRequest: vi.fn(),
    sendPrompt: vi.fn().mockResolvedValue({
      threadId: 'thr_existing',
      turn: { id: 'turn_1', status: 'inProgress' },
    } satisfies CodexPromptResult),
  };

  return {
    adapter: adapter as unknown as CodexAdapter,
    captureNotificationHandler() {
      return notificationHandler;
    },
    emit(notification: CodexJsonRpcNotification) {
      notificationHandler?.(notification);
    },
    emitServerRequest(request: { id: CodexJsonRpcId; method: string; params?: unknown }) {
      serverRequestHandler?.(request);
    },
  };
}

export function resetCodexApiTestState(): void {
  vi.clearAllMocks();
  localStorage.clear();
}

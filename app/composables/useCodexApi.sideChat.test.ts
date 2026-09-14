import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCodexApi } from './useCodexApi';
import { createAdapterMock, resetCodexApiTestState } from './useCodexApi.test-helpers';

describe('Codex side chat routing', () => {
  beforeEach(resetCodexApiTestState);
  it('keeps a busy parent intact when fork starts before its response and side events stream', async () => {
    const mock = createAdapterMock();
    Object.assign(mock.adapter, { startTurn: vi.fn(async () => ({ turn: { id: 'side-turn', status: 'inProgress' } })) });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    api.activeTurn.value = { id: 'parent-turn', status: 'inProgress' };
    api.pending.value = true;
    const previousTranscript = JSON.stringify(api.transcript.value);
    const previousHistory = JSON.stringify(api.canonicalHistory.value);
    vi.mocked(mock.adapter.forkThread).mockImplementation(async () => {
      mock.emit({ method: 'thread/started', params: { thread: { id: 'side', ephemeral: true } } });
      return { thread: { id: 'side' } };
    });
    await api.startSideChat('extra question');
    mock.emit({ method: 'item/agentMessage/delta', params: { threadId: 'side', turnId: 'side-turn', itemId: 'answer', delta: 'answer' } });
    mock.emit({ method: 'turn/completed', params: { threadId: 'side', turn: { id: 'side-turn', status: 'completed' } } });
    expect(api.activeThreadId.value).toBe('thr_existing');
    expect(api.activeTurn.value?.id).toBe('parent-turn');
    expect(api.pending.value).toBe(true);
    expect(JSON.stringify(api.transcript.value)).toBe(previousTranscript);
    expect(JSON.stringify(api.canonicalHistory.value)).toBe(previousHistory);
    expect(api.threads.value.some((thread) => thread.id === 'side')).toBe(false);
    expect(api.sideChat.value?.messages.at(-1)?.text).toBe('answer');
    expect(api.sideChat.value?.pending).toBe(false);
  });
});

it('keeps side approval and questions visible across main turns, routes replies, and clears on close', async () => {
  resetCodexApiTestState();
  const mock = createAdapterMock();
  Object.assign(mock.adapter, { startTurn: vi.fn(async () => ({ turn: { id: 'side-turn', status: 'inProgress' } })) });
  const api = useCodexApi({ adapterFactory: () => mock.adapter });
  await api.connect();
  await api.startSideChat('question');
  mock.emitServerRequest({ id: 'side-approval', method: 'item/commandExecution/requestApproval', params: {
    threadId: 'thr_fork', turnId: 'side-turn', itemId: 'cmd', command: 'pwd', availableDecisions: ['accept', 'decline'],
  } });
  mock.emitServerRequest({ id: 'side-question', method: 'item/tool/requestUserInput', params: {
    threadId: 'thr_fork', turnId: 'side-turn', itemId: 'question', questions: [{ id: 'target', header: 'Target', question: 'Which?', isOther: true, isSecret: false, options: [] }],
  } });
  mock.emitServerRequest({ id: 'side-permission', method: 'item/permissions/requestApproval', params: {
    threadId: 'thr_fork', turnId: 'side-turn', itemId: 'permission', cwd: '/repo', permissions: { network: { enabled: true } },
  } });
  mock.emit({ method: 'turn/started', params: { threadId: 'thr_existing', turn: { id: 'next-main', status: 'inProgress' } } });
  expect(api.serverRequests.value[0]?.threadId).toBe('thr_fork');
  expect(api.toolUserInputRequests.value[0]?.threadId).toBe('thr_fork');
  expect(api.permissionRequests.value[0]?.sessionID).toBe('thr_fork');
  expect(mock.adapter.respondToServerRequest).not.toHaveBeenCalled();
  api.resolveServerRequest('side-approval', 'accept');
  expect(mock.adapter.respondToServerRequest).toHaveBeenCalledWith('side-approval', { decision: 'accept' });
  mock.emit({ method: 'serverRequest/resolved', params: { threadId: 'thr_fork', requestId: 'side-permission' } });
  expect(api.permissionRequests.value).toHaveLength(0);
  await api.closeSideChat();
  expect(api.toolUserInputRequests.value).toHaveLength(0);
  expect(api.activeTurn.value?.id).toBe('next-main');
});

it('includes selected permissions on the first new-thread send before clearing the old selection', async () => {
  resetCodexApiTestState();
  const mock = createAdapterMock();
  Object.assign(mock.adapter, { readConfigRequirements: vi.fn(async () => ({ requirements: null })) });
  const api = useCodexApi({ adapterFactory: () => mock.adapter });
  await api.connect();
  api.activeThreadId.value = '';
  await api.setPermissionMode('read-only');
  await api.sendPrompt('new task');
  expect(mock.adapter.sendPrompt).toHaveBeenCalledWith(expect.objectContaining({
    approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false },
    thread: { approvalPolicy: 'on-request', sandbox: 'read-only' },
  }));
  expect(api.selectedPermissionMode.value).toBe('');
});

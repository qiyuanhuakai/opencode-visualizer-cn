import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCodexApi } from './useCodexApi';
import { createAdapterMock, deferred, resetCodexApiTestState } from './useCodexApi.test-helpers';

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

it.each(['same parent', 'other parent', 'delayed fork'])('keeps creation permissions for side prompts after changing main controls: %s', async (scenario) => {
  // Given a side fork created with read-only permissions.
  resetCodexApiTestState();
  const mock = createAdapterMock();
  const startTurn = vi.fn(async () => ({ turn: { id: 'side-turn', status: 'completed' } }));
  Object.assign(mock.adapter, { startTurn, readConfigRequirements: vi.fn(async () => ({ requirements: null })) });
  const api = useCodexApi({ adapterFactory: () => mock.adapter });
  await api.connect();
  await api.setPermissionMode('read-only');
  const fork = deferred<{ thread: { id: string } }>();
  if (scenario === 'delayed fork') vi.mocked(mock.adapter.forkThread).mockReturnValue(fork.promise);
  const opening = api.startSideChat('first question');
  if (scenario !== 'delayed fork') await opening;
  // When main controls change, including navigation while the fork is unresolved.
  if (scenario !== 'same parent') await api.selectThread('thread-B');
  await api.setPermissionMode('full-access');
  fork.resolve({ thread: { id: 'thr_fork' } });
  await opening;
  await api.sendSidePrompt('follow-up');
  // Then every side turn retains the parent settings captured at creation.
  expect(startTurn).toHaveBeenCalledTimes(2);
  for (const call of [1, 2]) {
    expect(startTurn).toHaveBeenNthCalledWith(call, expect.objectContaining({
      threadId: 'thr_fork', approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false },
    }));
  }
});

it('retains side permissions after a failed turn and captures new permissions after reopening', async () => {
  // Given a read-only side chat and a failed first turn.
  resetCodexApiTestState();
  const mock = createAdapterMock();
  const startTurn = vi.fn().mockRejectedValueOnce(new Error('Unavailable')).mockResolvedValue({ turn: { id: 'side-turn', status: 'completed' } });
  Object.assign(mock.adapter, { startTurn, readConfigRequirements: vi.fn(async () => ({ requirements: null })) });
  const api = useCodexApi({ adapterFactory: () => mock.adapter });
  await api.connect();
  await api.setPermissionMode('read-only');
  await expect(api.startSideChat('first')).rejects.toThrow('Unavailable');
  await api.setPermissionMode('full-access');
  // When retrying the failed side turn, then explicitly opening a fresh side chat.
  await api.sendSidePrompt('retry');
  await api.closeSideChat();
  await api.startSideChat('fresh');
  // Then only the new side chat gets the newly selected permissions.
  expect(startTurn).toHaveBeenNthCalledWith(2, expect.objectContaining({ approvalPolicy: 'on-request', sandboxPolicy: { type: 'readOnly', networkAccess: false } }));
  expect(startTurn).toHaveBeenNthCalledWith(3, expect.objectContaining({ approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } }));
});

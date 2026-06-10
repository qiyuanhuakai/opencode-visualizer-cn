import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCodexApi } from './useCodexApi';
import type { CodexAdapter, CodexPromptResult } from '../backends/codex/codexAdapter';
import type { CodexJsonRpcNotification } from '../backends/codex/jsonRpcClient';

function createAdapterMock() {
  let notificationHandler: ((notification: CodexJsonRpcNotification) => void) | null = null;
  let serverRequestHandler: ((request: { id: string; method: string; params?: unknown }) => void) | null = null;
  const adapter = {
    initialize: vi.fn().mockResolvedValue({ userAgent: 'codex-test' }),
    disconnect: vi.fn(),
    onNotification: vi.fn((handler: (notification: CodexJsonRpcNotification) => void) => {
      notificationHandler = handler;
      return vi.fn(() => {
        notificationHandler = null;
      });
    }),
    onServerRequest: vi.fn((handler: (request: { id: string; method: string; params?: unknown }) => void) => {
      serverRequestHandler = handler;
      return vi.fn(() => {
        serverRequestHandler = null;
      });
    }),
    listThreads: vi.fn().mockResolvedValue({
      data: [{ id: 'thr_existing', preview: 'Existing thread' }],
      nextCursor: null,
    }),
    startThread: vi.fn().mockResolvedValue({ thread: { id: 'thr_new', preview: '' } }),
    readThread: vi.fn((params: { threadId: string }) => Promise.resolve({
      thread: {
        id: params.threadId,
        name: params.threadId === 'thr_fork' ? 'Forked thread' : 'Existing named thread',
        turns: [
          {
            id: 'turn_old',
            items: [
              { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: `${params.threadId} prompt` }] },
              { type: 'agentMessage', id: 'a1', text: `${params.threadId} answer` },
            ],
          },
        ],
      },
    })),
    resumeThread: vi.fn().mockResolvedValue({ thread: { id: 'thr_existing', name: 'Existing named thread' } }),
    setThreadName: vi.fn().mockResolvedValue({}),
    archiveThread: vi.fn().mockResolvedValue({}),
    unarchiveThread: vi.fn().mockResolvedValue({ thread: { id: 'thr_existing', name: 'Existing named thread' } }),
    unsubscribeThread: vi.fn().mockResolvedValue({}),
    interruptTurn: vi.fn().mockResolvedValue({}),
    forkThread: vi.fn().mockResolvedValue({ thread: { id: 'thr_fork', preview: '' } }),
    rollbackThread: vi.fn().mockResolvedValue({ thread: { id: 'thr_existing', name: 'Existing named thread' } }),
    readDirectory: vi.fn().mockResolvedValue({ entries: [{ name: 'file.txt', type: 'file' }] }),
    readFile: vi.fn().mockResolvedValue({ dataBase64: 'aGVsbG8=' }),
    listCollaborationModes: vi.fn().mockResolvedValue({ data: [] }),
    respondToServerRequest: vi.fn(),
    sendPrompt: vi.fn().mockResolvedValue({
      threadId: 'thr_existing',
      turn: { id: 'turn_1', status: 'inProgress' },
    } satisfies CodexPromptResult),
  };

  return {
    adapter: adapter as unknown as CodexAdapter,
    emit(notification: CodexJsonRpcNotification) {
      notificationHandler?.(notification);
    },
    emitServerRequest(request: { id: string; method: string; params?: unknown }) {
      serverRequestHandler?.(request);
    },
  };
}

describe('useCodexApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('connects through a Codex adapter and loads threads', async () => {
    const mock = createAdapterMock();
    const phases: string[] = [];
    const api = useCodexApi({
      url: 'ws://localhost:23004/codex',
      bridgeToken: 'local-token',
      adapterFactory: (options) => {
        expect(options.url).toBe('ws://localhost:23004/codex?token=local-token');
        return mock.adapter;
      },
    });

    await api.connect(undefined, (phase) => phases.push(phase));

    expect(api.status.value).toBe('connected');
    expect(api.initialized.value).toBe(true);
    expect(api.threads.value).toEqual([{ id: 'thr_existing', preview: 'Existing thread' }]);
    expect(api.activeThreadId.value).toBe('thr_existing');
    expect(phases).toEqual(['home', 'handshake', 'threads', 'workspace', 'panelData']);
  });

  it('sends Codex image input items without degrading them to file text', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();

    await api.sendPrompt('', {
      threadId: 'thr_existing',
      input: [{ type: 'image', url: 'data:image/png;base64,AA==' }],
    });

    expect(mock.adapter.sendPrompt).toHaveBeenLastCalledWith({
      text: '',
      threadId: 'thr_existing',
      input: [{ type: 'image', url: 'data:image/png;base64,AA==' }],
    });
  });

  it('sends only the Codex model id when the selected UI key includes a provider', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();

    api.selectModel('omniroute/mimo/mimo-v2.5');
    await api.sendPrompt('Hello custom model.', { threadId: 'thr_existing' });

    expect(mock.adapter.sendPrompt).toHaveBeenLastCalledWith({
      text: 'Hello custom model.',
      threadId: 'thr_existing',
      model: 'mimo/mimo-v2.5',
    });
  });

  it('keeps slash-containing explicit Codex model ids intact', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();

    api.selectModel('omniroute/mimo/mimo-v2.5');
    await api.sendPrompt('Hello explicit custom model.', {
      threadId: 'thr_existing',
      model: 'mimo/mimo-v2.5',
    });

    expect(mock.adapter.sendPrompt).toHaveBeenLastCalledWith({
      text: 'Hello explicit custom model.',
      threadId: 'thr_existing',
      model: 'mimo/mimo-v2.5',
    });
  });

  it('lists archived threads without replacing the active thread list', async () => {
    const mock = createAdapterMock();
    mock.adapter.listThreads = vi.fn()
      .mockResolvedValueOnce({
        data: [{ id: 'thr_active', preview: 'Active thread' }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        data: [{ id: 'thr_archived', preview: 'Archived thread' }],
        nextCursor: null,
      });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    const archived = await api.listThreads({ archived: true });

    expect(archived.map((thread) => thread.id)).toEqual(['thr_archived']);
    expect(api.threads.value.map((thread) => thread.id)).toEqual(['thr_active']);
    expect(mock.adapter.listThreads).toHaveBeenNthCalledWith(2, {
      limit: 50,
      sortKey: 'updated_at',
      modelProviders: null,
      archived: true,
    });
  });

  it('requests all Codex model providers when refreshing threads', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.refreshThreads();

    expect(mock.adapter.listThreads).toHaveBeenLastCalledWith({
      limit: 50,
      sortKey: 'updated_at',
      modelProviders: null,
    });
  });

  it('merges explicit provider thread lists when custom providers are configured', async () => {
    const mock = createAdapterMock();
    mock.adapter.readConfig = vi.fn().mockResolvedValue({
      config: {
        model_provider: 'omniroute',
        model_providers: { omniroute: { name: 'OmniRoute' } },
      },
    });
    mock.adapter.listThreads = vi.fn()
      .mockResolvedValueOnce({ data: [{ id: 'custom-null', preview: 'Null custom', modelProvider: 'omniroute', updatedAt: 2 }], nextCursor: null })
      .mockResolvedValueOnce({ data: [{ id: 'official', preview: 'OpenAI', modelProvider: 'openai', updatedAt: 3 }], nextCursor: null })
      .mockResolvedValueOnce({ data: [{ id: 'custom-explicit', preview: 'Custom', modelProvider: 'omniroute', updatedAt: 1 }], nextCursor: null });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();

    expect(api.threads.value.map((thread) => thread.id)).toEqual(['official', 'custom-null', 'custom-explicit']);
    expect(mock.adapter.listThreads).toHaveBeenNthCalledWith(1, {
      limit: 50,
      sortKey: 'updated_at',
      modelProviders: null,
    });
    expect(mock.adapter.listThreads).toHaveBeenNthCalledWith(2, {
      limit: 50,
      sortKey: 'updated_at',
      modelProviders: ['openai'],
    });
    expect(mock.adapter.listThreads).toHaveBeenNthCalledWith(3, {
      limit: 50,
      sortKey: 'updated_at',
      modelProviders: ['omniroute'],
    });
  });

  it('strips raw git remote URLs from loaded thread metadata', async () => {
    const mock = createAdapterMock();
    mock.adapter.listThreads = vi.fn().mockResolvedValue({
      data: [{
        id: 'thr_repo',
        preview: 'Repo',
        cwd: '/repo',
        gitInfo: {
          root: '/repo',
          branch: 'main',
          originUrl: 'https://token@example.com/org/repo.git',
        },
      }],
      nextCursor: null,
    });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();

    expect(api.threads.value[0]?.gitInfo).toEqual({ root: '/repo', branch: 'main' });
  });

  it('expands tilde cwd values loaded from Codex threads', async () => {
    const mock = createAdapterMock();
    mock.adapter.listThreads = vi.fn().mockResolvedValue({
      data: [
        { id: 'thr_home', preview: 'Home', cwd: '~' },
        { id: 'thr_repo', preview: 'Repo', cwd: '~/repo' },
      ],
      nextCursor: null,
    });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    api.homeDir.value = '/home/codex';

    await api.connect();

    expect(api.threads.value.map((thread) => thread.cwd)).toEqual(['/home/codex', '/home/codex/repo']);
  });

  it('falls back to reading unmaterialized threads without turns', async () => {
    const mock = createAdapterMock();
    mock.adapter.readThread = vi.fn()
      .mockRejectedValueOnce(new Error('thread thr_empty is not materialized yet; includeTurns is unavailable before first user message'))
      .mockResolvedValueOnce({ thread: { id: 'thr_empty', preview: 'Empty thread' } });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.selectThread('thr_empty');

    expect(mock.adapter.readThread).toHaveBeenNthCalledWith(1, { threadId: 'thr_empty', includeTurns: true });
    expect(mock.adapter.readThread).toHaveBeenNthCalledWith(2, { threadId: 'thr_empty', includeTurns: false });
    expect(api.activeThreadId.value).toBe('thr_empty');
    expect(api.canonicalHistory.value).toEqual([]);
    expect(api.errorMessage.value).toBe('');
  });

  it('keeps the requested cwd when a newly started thread omits cwd', async () => {
    const mock = createAdapterMock();
    mock.adapter.startThread = vi.fn().mockResolvedValue({ thread: { id: 'thr_new', preview: '' } });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    api.homeDir.value = '/home/codex';

    await api.connect();
    const thread = await api.startThread('~/repo');

    expect(mock.adapter.startThread).toHaveBeenCalledWith({ cwd: '/home/codex/repo' });
    expect(thread.cwd).toBe('/home/codex/repo');
    expect(api.threads.value.find((item) => item.id === 'thr_new')?.cwd).toBe('/home/codex/repo');
  });

  it('starts threads with the bare Codex model id from the selected UI key', async () => {
    const mock = createAdapterMock();
    mock.adapter.startThread = vi.fn().mockResolvedValue({ thread: { id: 'thr_new', preview: '' } });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    api.homeDir.value = '/home/codex';

    await api.connect();
    api.selectModel('omniroute/mimo/mimo-v2.5');
    await api.startThread('~/repo');

    expect(mock.adapter.startThread).toHaveBeenCalledWith({
      cwd: '/home/codex/repo',
      model: 'mimo/mimo-v2.5',
    });
  });

  it('preserves known cwd and git info when later thread reads omit them', async () => {
    const mock = createAdapterMock();
    mock.adapter.startThread = vi.fn().mockResolvedValue({ thread: { id: 'thr_new', preview: '' } });
    mock.adapter.getVcsInfo = vi.fn().mockResolvedValue({ root: '/repo', branch: 'main' });
    mock.adapter.readThread = vi.fn().mockResolvedValue({
      thread: {
        id: 'thr_new',
        name: 'Existing named thread',
        turns: [{ id: 'turn_old', items: [] }],
      },
    });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    api.homeDir.value = '/home/codex';

    await api.connect();
    await api.startThread('/repo/subdir');
    await api.selectThread('thr_new');

    const thread = api.threads.value.find((item) => item.id === 'thr_new');
    expect(thread?.cwd).toBe('/repo/subdir');
    expect(thread?.gitInfo).toEqual({ root: '/repo', branch: 'main' });
  });

  it('preserves known cwd when refreshThreads returns a thinner thread payload', async () => {
    const mock = createAdapterMock();
    mock.adapter.listThreads = vi.fn()
      .mockResolvedValueOnce({ data: [{ id: 'thr_existing', preview: 'Existing thread', cwd: '/repo/subdir' }], nextCursor: null })
      .mockResolvedValueOnce({ data: [{ id: 'thr_existing', preview: 'Existing thread' }], nextCursor: null });
    mock.adapter.getVcsInfo = vi.fn().mockResolvedValue({ root: '/repo', branch: 'main' });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.refreshThreads();

    const thread = api.threads.value.find((item) => item.id === 'thr_existing');
    expect(thread?.cwd).toBe('/repo/subdir');
    expect(thread?.gitInfo).toEqual({ root: '/repo', branch: 'main' });
  });

  it('enriches newly started threads with git root metadata', async () => {
    const mock = createAdapterMock();
    mock.adapter.startThread = vi.fn().mockResolvedValue({ thread: { id: 'thr_new', cwd: '/repo/subdir', preview: '' } });
    mock.adapter.getVcsInfo = vi.fn().mockResolvedValue({ root: '/repo', branch: 'main' });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    const thread = await api.startThread('/repo/subdir');

    expect(mock.adapter.getVcsInfo).toHaveBeenCalledWith('/repo/subdir');
    expect(thread.gitInfo).toEqual({ root: '/repo', branch: 'main' });
    expect(api.threads.value.find((item) => item.id === 'thr_new')?.gitInfo).toEqual({ root: '/repo', branch: 'main' });
  });

  it('waits for git metadata before inserting thread-started notifications', async () => {
    const mock = createAdapterMock();
    mock.adapter.getVcsInfo = vi.fn().mockResolvedValue({ root: '/repo', branch: 'main' });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    mock.emit({
      method: 'thread/started',
      params: { thread: { id: 'thr_notify', cwd: '/repo/subdir', preview: '' } },
    });

    expect(api.threads.value.find((item) => item.id === 'thr_notify')).toBeUndefined();
    await vi.waitFor(() => {
      expect(api.threads.value.find((item) => item.id === 'thr_notify')?.gitInfo).toEqual({ root: '/repo', branch: 'main' });
    });
  });

  it('sends prompts to the active thread and records user transcript entries', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    const result = await api.sendPrompt('  Summarize this repo.  ');

    expect(mock.adapter.sendPrompt).toHaveBeenCalledWith({
      threadId: 'thr_existing',
      text: 'Summarize this repo.',
    });
    expect(result?.threadId).toBe('thr_existing');
    expect(api.transcript.value).toEqual([
      expect.objectContaining({ role: 'user', text: 'Summarize this repo.' }),
    ]);
  });

  it('sends prompts with the selected thread and cwd snapshot', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    api.homeDir.value = '/home/codex';

    await api.connect();
    await api.sendPrompt('Continue here.', { threadId: 'thr_existing', cwd: '~/repo' });

    expect(mock.adapter.sendPrompt).toHaveBeenLastCalledWith({
      threadId: 'thr_existing',
      text: 'Continue here.',
      cwd: '/home/codex/repo',
    });
  });

  it('can force a new thread instead of resuming the active thread', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();

    await api.sendPrompt('Start on the selected provider.', {
      threadId: 'thr_existing',
      forceNewThread: true,
      model: 'mimo/mimo-v2.5',
      cwd: '/repo',
    });

    expect(mock.adapter.sendPrompt).toHaveBeenLastCalledWith({
      text: 'Start on the selected provider.',
      model: 'mimo/mimo-v2.5',
      cwd: '/repo',
    });
  });

  it('preserves a newly materialized active thread when list refresh is temporarily stale', async () => {
    const mock = createAdapterMock();
    mock.adapter.sendPrompt = vi.fn().mockResolvedValue({
      threadId: 'thr_materialized',
      thread: { id: 'thr_materialized', preview: 'New prompt', cwd: '/repo' },
      turn: { id: 'turn_2', status: 'inProgress' },
    } satisfies CodexPromptResult);
    mock.adapter.listThreads = vi.fn()
      .mockResolvedValueOnce({
        data: [{ id: 'thr_existing', preview: 'Existing thread', cwd: '/repo' }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        data: [{ id: 'thr_existing', preview: 'Existing thread', cwd: '/repo' }],
        nextCursor: null,
      });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('First prompt.', { threadId: 'thr_empty', cwd: '/repo' });
    await api.refreshThreads();

    expect(api.activeThreadId.value).toBe('thr_materialized');
    expect(api.threads.value.map((thread) => thread.id)).toContain('thr_materialized');
  });

  it('falls back to the active thread cwd when creating a sandbox thread without a selected path', async () => {
    const mock = createAdapterMock();
    mock.adapter.listThreads = vi.fn().mockResolvedValue({
      data: [{ id: 'thr_existing', preview: 'Existing thread', cwd: '/repo/' }],
      nextCursor: null,
    });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    api.sandboxPath.value = '   ';
    api.fsCwd.value = '';
    await api.createThreadInSandbox();

    expect(api.selectedSandboxCwd()).toBe('/repo');
    expect(mock.adapter.startThread).toHaveBeenLastCalledWith({ cwd: '/repo' });
  });

  it('normalizes relative sandbox paths against home before starting threads', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    api.homeDir.value = '/home/codex';

    await api.connect();
    await api.startThread('../shared/./work');

    expect(mock.adapter.startThread).toHaveBeenLastCalledWith({ cwd: '/home/shared/work' });
  });

  it('updates state from thread and agent delta notifications', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    mock.emit({ method: 'thread/started', params: { thread: { id: 'thr_stream', preview: '' } } });
    mock.emit({ method: 'item/agentMessage/delta', params: { delta: 'Hello' } });
    mock.emit({ method: 'item/agentMessage/delta', params: { delta: ', Codex.' } });

    expect(api.activeThreadId.value).toBe('thr_existing');
    await vi.waitFor(() => {
      expect(api.threads.value[0]).toEqual({ id: 'thr_stream', preview: '' });
    });
    expect(api.transcript.value).toEqual([
      expect.objectContaining({ role: 'assistant', text: 'Hello, Codex.' }),
    ]);
    expect(api.events.value.map((event) => event.method)).toEqual([
      'thread/started',
      'item/agentMessage/delta',
      'item/agentMessage/delta',
    ]);
  });

  it('loads thread history and resumes when selecting a thread', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.selectThread('thr_existing');

    expect(mock.adapter.readThread).toHaveBeenCalledWith({
      threadId: 'thr_existing',
      includeTurns: true,
    });
    expect(mock.adapter.resumeThread).toHaveBeenCalledWith({ threadId: 'thr_existing' });
    expect(api.threads.value[0]).toEqual(expect.objectContaining({
      id: 'thr_existing',
      name: 'Existing named thread',
    }));
    expect(api.transcript.value).toEqual([
      expect.objectContaining({ role: 'user', text: 'thr_existing prompt' }),
      expect.objectContaining({ role: 'assistant', text: 'thr_existing answer' }),
    ]);
    expect(api.canonicalHistory.value.map((entry) => entry.info.role)).toEqual(['user', 'assistant']);
  });

  it('keeps all turns in canonicalHistory when readThread returns multi-turn history (page refresh regression)', async () => {
    const mock = createAdapterMock();
    mock.adapter.readThread = vi.fn().mockResolvedValue({
      thread: {
        id: 'thr_multi',
        name: 'Multi-turn thread',
        turns: [
          {
            id: 'turn_1',
            items: [
              { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'First user prompt' }] },
              { type: 'agentMessage', id: 'a1', text: 'First agent answer' },
            ],
          },
          {
            id: 'turn_2',
            items: [
              { type: 'userMessage', id: 'u2', content: [{ type: 'text', text: 'Second user prompt' }] },
              { type: 'agentMessage', id: 'a2', text: 'Second agent answer' },
            ],
          },
          {
            id: 'turn_3',
            items: [
              { type: 'userMessage', id: 'u3', content: [{ type: 'text', text: 'Third user prompt' }] },
              { type: 'agentMessage', id: 'a3', text: 'Third agent answer' },
            ],
          },
        ],
      },
    });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.selectThread('thr_multi');

    expect(mock.adapter.readThread).toHaveBeenCalledWith({
      threadId: 'thr_multi',
      includeTurns: true,
    });
    expect(api.canonicalHistory.value.length).toBeGreaterThanOrEqual(6);
    expect(api.canonicalHistory.value.map((entry) => entry.info.role)).toEqual([
      'user', 'assistant',
      'user', 'assistant',
      'user', 'assistant',
    ]);
  });

  it('keeps selecting an empty thread when resume reports no rollout', async () => {
    const mock = createAdapterMock();
    mock.adapter.readThread = vi.fn().mockResolvedValue({ thread: { id: 'thr_empty', preview: 'Empty', turns: [] } });
    mock.adapter.resumeThread = vi.fn().mockRejectedValue(new Error('no rollout found for thread id thr_empty'));
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.selectThread('thr_empty');

    expect(mock.adapter.resumeThread).toHaveBeenCalledWith({ threadId: 'thr_empty' });
    expect(api.activeThreadId.value).toBe('thr_empty');
    expect(api.canonicalHistory.value).toEqual([]);
    expect(api.errorMessage.value).toBe('');
  });

  it('refreshes and updates thread names from notifications', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    mock.emit({ method: 'thread/name/updated', params: { threadId: 'thr_existing', name: 'Renamed' } });

    expect(api.threads.value[0]).toEqual(expect.objectContaining({
      id: 'thr_existing',
      name: 'Renamed',
    }));
    await vi.waitFor(() => {
      expect(mock.adapter.listThreads).toHaveBeenCalledTimes(2);
    });
  });

  it('renames, archives, unsubscribes, and interrupts active Codex threads', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.setThreadName('thr_existing', '  Renamed by user  ');
    await api.sendPrompt('Continue.');
    await api.interruptActiveTurn();
    await api.unsubscribeThread('thr_existing');
    await api.archiveThread('thr_existing');

    expect(mock.adapter.setThreadName).toHaveBeenCalledWith({ threadId: 'thr_existing', name: 'Renamed by user' });
    expect(mock.adapter.interruptTurn).toHaveBeenCalledWith({ threadId: 'thr_existing', turnId: 'turn_1' });
    expect(mock.adapter.unsubscribeThread).toHaveBeenCalledWith({ threadId: 'thr_existing' });
    expect(mock.adapter.archiveThread).toHaveBeenCalledWith({ threadId: 'thr_existing' });
    expect(api.activeThreadId.value).toBe('');
    expect(api.activeTurn.value).toBeNull();
  });

  it('hides empty no-rollout threads when archive is rejected by Codex', async () => {
    const mock = createAdapterMock();
    mock.adapter.archiveThread = vi.fn().mockRejectedValue(new Error('no rollout found for thread id thr_existing'));
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.archiveThread('thr_existing');

    expect(mock.adapter.archiveThread).toHaveBeenCalledWith({ threadId: 'thr_existing' });
    expect(api.hiddenThreadIds.value.has('thr_existing')).toBe(true);
    expect(api.visibleThreads.value).toEqual([]);
    expect(api.activeThreadId.value).toBe('');
    expect(api.errorMessage.value).toBe('');
  });

  it('tracks and resolves server-initiated approval requests', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Needs approval.');
    mock.emitServerRequest({
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_1',
        itemId: 'item_1',
        command: ['pnpm', 'test'],
        availableDecisions: ['accept', 'decline', 'unexpected'],
      },
    });

    expect(api.serverRequests.value).toEqual([
      expect.objectContaining({
        id: 'approval-1',
        method: 'item/commandExecution/requestApproval',
        threadId: 'thr_existing',
        turnId: 'turn_1',
        availableDecisions: ['accept', 'decline'],
      }),
    ]);

    api.resolveServerRequest('approval-1', 'acceptForSession');
    expect(mock.adapter.respondToServerRequest).not.toHaveBeenCalled();

    api.resolveServerRequest('approval-1', 'accept');

    expect(mock.adapter.respondToServerRequest).toHaveBeenCalledWith('approval-1', 'accept');
    expect(api.serverRequests.value).toEqual([]);
  });

  it('ignores unsupported or out-of-scope server requests', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Needs scoped approval.');
    mock.emitServerRequest({
      id: 'wrong-thread',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thr_other',
        turnId: 'turn_1',
        availableDecisions: ['accept'],
      },
    });
    mock.emitServerRequest({
      id: 'missing-decisions',
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_1',
      },
    });
    mock.emitServerRequest({
      id: 'unsupported-method',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_1',
        availableDecisions: ['accept'],
      },
    });

    expect(api.serverRequests.value).toEqual([]);
  });

  it('clears stale approvals when the active thread or turn changes', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Needs scoped approval.');
    mock.emitServerRequest({
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_1',
        availableDecisions: ['accept'],
      },
    });

    expect(api.serverRequests.value).toHaveLength(1);

    mock.emit({ method: 'turn/started', params: { turn: { id: 'turn_2', status: 'inProgress' } } });

    expect(api.serverRequests.value).toEqual([]);
    api.resolveServerRequest('approval-1', 'accept');
    expect(mock.adapter.respondToServerRequest).not.toHaveBeenCalled();

    mock.emitServerRequest({
      id: 'approval-2',
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_2',
        availableDecisions: ['decline'],
      },
    });
    expect(api.serverRequests.value).toHaveLength(1);

    await api.startThread();

    expect(api.serverRequests.value).toEqual([]);
  });

  it('forks and rolls back threads through the adapter', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.forkThread('thr_existing');
    expect(api.activeThreadId.value).toBe('thr_fork');
    expect(api.transcript.value).toEqual([
      expect.objectContaining({ role: 'user', text: 'thr_fork prompt' }),
      expect.objectContaining({ role: 'assistant', text: 'thr_fork answer' }),
    ]);

    await api.selectThread('thr_existing');
    await api.rollbackThread('thr_existing', 1);

    expect(mock.adapter.forkThread).toHaveBeenCalledWith({ threadId: 'thr_existing' });
    expect(mock.adapter.rollbackThread).toHaveBeenCalledWith({ threadId: 'thr_existing', numTurns: 1 });
    expect(api.transcript.value).toEqual([
      expect.objectContaining({ role: 'user', text: 'thr_existing prompt' }),
      expect.objectContaining({ role: 'assistant', text: 'thr_existing answer' }),
    ]);
  });

  it('locally hides and pins threads with persisted storage', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    api.hideThread('thr_existing');
    expect(api.hiddenThreadIds.value.has('thr_existing')).toBe(true);
    expect(api.visibleThreads.value.length).toBe(0);

    api.pinThread('thr_existing');
    expect(api.pinnedThreadIds.value.has('thr_existing')).toBe(true);

    api.unhideThread('thr_existing');
    expect(api.hiddenThreadIds.value.has('thr_existing')).toBe(false);
    expect(api.visibleThreads.value.length).toBe(1);

    api.unpinThread('thr_existing');
    expect(api.pinnedThreadIds.value.has('thr_existing')).toBe(false);
  });

  it('browses filesystem entries and reads file previews', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.readDirectory('/tmp');
    expect(mock.adapter.readDirectory).toHaveBeenCalledWith({ path: '/tmp' });
    expect(api.fsEntries.value).toEqual([{ name: 'file.txt', type: 'file' }]);
    expect(api.fsCwd.value).toBe('/tmp');

    await api.readFile('/tmp/file.txt');
    expect(mock.adapter.readFile).toHaveBeenCalledWith({ path: '/tmp/file.txt' });
    expect(api.previewFileContent.value).toBe('hello');
    expect(api.previewFilePath.value).toBe('/tmp/file.txt');

    api.clearPreview();
    expect(api.previewFilePath.value).toBe('');
  });

  it('pushes completed items to realtimeHistoryQueue for OutputPanel bridge', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Test realtime.');

    const userEntries = api.realtimeHistoryQueue.value.filter((e) => e.info.role === 'user');
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]?.parts[0]).toMatchObject({ type: 'text', text: 'Test realtime.' });

    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'agent-realtime-1',
          type: 'agentMessage',
          text: 'Realtime answer',
        },
      },
    });

    const assistantEntries = api.realtimeHistoryQueue.value.filter((e) => e.info.role === 'assistant');
    expect(assistantEntries.length).toBeGreaterThan(0);
    expect(assistantEntries.some((e) => e.parts.some((p) => p.type === 'text' && 'text' in p && p.text === 'Realtime answer'))).toBe(true);
  });

  it('pushes user message to realtimeHistoryQueue immediately on sendPrompt', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    expect(api.realtimeHistoryQueue.value).toEqual([]);

    await api.sendPrompt('Hello immediately.');

    const userEntries = api.realtimeHistoryQueue.value.filter((e) => e.info.role === 'user');
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]?.info.role).toBe('user');
    expect(userEntries[0]?.info.id).toContain(':user:0');
    expect(userEntries[0]?.info.id).toBe('turn_1:user:0');
    expect(userEntries.some((entry) => entry.info.id.includes('pending-turn:'))).toBe(false);
    expect(Object.keys(api.realtimeMessageAliases.value).some((key) => key.includes('pending-turn:'))).toBe(true);
    expect(Object.values(api.realtimeMessageAliases.value)).toContain('turn_1:user:0');
    expect(userEntries[0]?.parts).toHaveLength(1);
    expect(userEntries[0]?.parts[0]).toMatchObject({ type: 'text', text: 'Hello immediately.' });
  });

  it('does not reuse the previous active turn id for a new provisional user message', async () => {
    const mock = createAdapterMock();
    mock.adapter.sendPrompt = vi.fn().mockResolvedValue({
      threadId: 'thr_existing',
      turn: { id: 'turn_2', status: 'inProgress' },
    } satisfies CodexPromptResult);
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    api.activeTurn.value = { id: 'turn_old', status: 'completed' } as never;

    await api.sendPrompt('Fresh turn please.');

    expect(Object.keys(api.realtimeMessageAliases.value).some((key) => key.startsWith('turn_old:'))).toBe(false);
    expect(Object.keys(api.realtimeMessageAliases.value).some((key) => key.startsWith('pending-turn:'))).toBe(true);
    expect(api.realtimeHistoryQueue.value.find((entry) => entry.info.role === 'user')?.info.id).toBe('turn_2:user:0');
  });

  it('removes provisional realtime user history if sendPrompt fails', async () => {
    const mock = createAdapterMock();
    mock.adapter.sendPrompt = vi.fn().mockRejectedValue(new Error('send failed'));
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await expect(api.sendPrompt('Will fail.')).rejects.toThrow('send failed');

    expect(api.realtimeHistoryQueue.value).toEqual([]);
  });

  it('finalizes the provisional user entry even if another realtime entry lands before sendPrompt resolves', async () => {
    const mock = createAdapterMock();
    let resolveSend: ((result: CodexPromptResult) => void) | null = null;
    mock.adapter.sendPrompt = vi.fn().mockImplementation(() => new Promise<CodexPromptResult>((resolve) => {
      resolveSend = resolve;
    }));
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    const pendingSend = api.sendPrompt('Race test.');
    mock.emit({ method: 'item/agentMessage/delta', params: { delta: 'Early' } });
    expect(resolveSend).not.toBeNull();
    resolveSend!({
      threadId: 'thr_existing',
      turn: { id: 'turn_race', status: 'inProgress' },
    });
    await pendingSend;

    const userEntries = api.realtimeHistoryQueue.value.filter((entry) => entry.info.role === 'user');
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]?.info.id).toBe('turn_race:user:0');
    expect(userEntries[0]?.parts[0]).toMatchObject({ id: 'turn_race:user:0:text', text: 'Race test.' });
    expect(userEntries.some((entry) => entry.info.id.includes('pending-turn:'))).toBe(false);
    expect(Object.values(api.realtimeMessageAliases.value)).toContain('turn_race:user:0');
  });

  it('updates realtimeStreamingPart on agent message deltas', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Stream test.');

    expect(api.realtimeStreamingPart.value).not.toBeNull();
    expect(api.realtimeStreamingPart.value?.info.id).toContain(':assistant');
    expect(api.realtimeStreamingPart.value?.part.text).toBe('');

    mock.emit({ method: 'item/agentMessage/delta', params: { delta: 'Hello' } });
    expect(api.realtimeStreamingPart.value?.part.text).toBe('Hello');

    mock.emit({ method: 'item/agentMessage/delta', params: { delta: ', world!' } });
    expect(api.realtimeStreamingPart.value?.part.text).toBe('Hello, world!');
  });

  it('marks realtimeStreamingPart completed when agent message completes', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Complete test.');

    mock.emit({ method: 'item/agentMessage/delta', params: { delta: 'Partial' } });
    expect(api.realtimeStreamingPart.value).not.toBeNull();

    mock.emit({
      method: 'item/completed',
      params: { item: { id: 'agent-1', type: 'agentMessage', text: 'Final answer' } },
    });
    expect(api.realtimeStreamingPart.value?.part.text).toBe('Final answer');
    expect(api.realtimeStreamingPart.value?.part.time?.end).toEqual(expect.any(Number));
  });

  it('uses one canonical assistant text part across streaming and completed history', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Create a file');

    mock.emit({ method: 'item/agentMessage/delta', params: { delta: 'Hello' } });
    mock.emit({ method: 'item/agentMessage/delta', params: { delta: ', world!' } });
    mock.emit({
      method: 'item/completed',
      params: { item: { id: 'agent-1', type: 'agentMessage', text: 'Hello, world!' } },
    });

    const assistantEntries = api.realtimeHistoryQueue.value.filter((entry) => entry.info.role === 'assistant');
    expect(assistantEntries).toHaveLength(1);
    const textParts = assistantEntries[0]?.parts.filter((part) => part.type === 'text') ?? [];
    expect(textParts).toHaveLength(1);
    expect(textParts[0]?.id).toBe('turn_1:assistant:text');
    expect(textParts[0]).toMatchObject({ messageID: 'turn_1:assistant', text: 'Hello, world!' });
  });

  it('merges completed tool parts into the existing assistant entry instead of duplicating assistant history rows', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Create a file');

    mock.emit({ method: 'item/agentMessage/delta', params: { delta: 'Done' } });
    mock.emit({
      method: 'item/started',
      params: { item: { id: 'cmd-1', type: 'commandExecution', command: ['ls'], cwd: '/repo' } },
    });
    mock.emit({
      method: 'item/completed',
      params: { item: { id: 'cmd-1', type: 'commandExecution', command: ['ls'], cwd: '/repo', aggregatedOutput: 'file.txt' } },
    });
    mock.emit({
      method: 'item/completed',
      params: { item: { id: 'agent-1', type: 'agentMessage', text: 'Done' } },
    });

    const assistantEntries = api.realtimeHistoryQueue.value.filter((entry) => entry.info.role === 'assistant');
    expect(assistantEntries).toHaveLength(1);
    expect(assistantEntries[0]?.parts.some((part) => part.type === 'tool')).toBe(true);
    expect(assistantEntries[0]?.parts.some((part) => part.type === 'text' && 'text' in part && part.text === 'Done')).toBe(true);
  });

  it('updates realtimeReasoningPart on reasoning deltas', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Reasoning test.');

    mock.emit({
      method: 'item/reasoning/summaryTextDelta',
      params: { itemId: 'reasoning-1', delta: 'Thinking...' },
    });

    expect(api.realtimeReasoningPart.value).not.toBeNull();
    expect(api.realtimeReasoningPart.value?.part.type).toBe('reasoning');
    expect(api.realtimeReasoningPart.value?.part.text).toBe('Thinking...');
    expect(api.realtimeReasoningPart.value?.info.id).toContain(':assistant');

    mock.emit({
      method: 'item/reasoning/summaryTextDelta',
      params: { itemId: 'reasoning-1', delta: ' more thoughts' },
    });
    expect(api.realtimeReasoningPart.value?.part.text).toBe('Thinking... more thoughts');
  });

  it('tracks tool parts from item/started notifications', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Tool test.');

    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          command: ['pnpm', 'test'],
          cwd: '/repo',
        },
      },
    });

    expect(api.realtimeToolParts.value).toHaveLength(1);
    expect(api.realtimeToolParts.value[0]?.part.type).toBe('tool');
    expect(api.realtimeToolParts.value[0]?.part.state.status).toBe('running');
  });

  it('marks realtime tool parts completed and writes them to realtime history on item completion', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Tool completion test.');

    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          command: ['pnpm', 'test'],
          cwd: '/repo',
        },
      },
    });

    mock.emit({ method: 'command/exec/outputDelta', params: { callId: 'cmd-1', delta: 'running output' } });
    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          command: ['pnpm', 'test'],
          cwd: '/repo',
          aggregatedOutput: 'final output',
        },
      },
    });

    expect(api.realtimeToolParts.value).toHaveLength(0);
    const toolEntry = api.realtimeHistoryQueue.value.find((entry) => entry.parts.some((part) => part.id === 'cmd-1'));
    expect(toolEntry).toBeDefined();
    const toolPart = toolEntry?.parts.find((part) => part.id === 'cmd-1');
    expect(toolPart).toMatchObject({ type: 'tool', state: { status: 'completed' } });
    expect(toolPart).toMatchObject({ type: 'tool', state: { output: 'running outputfinal output' } });
  });

  it('maps failed tool completion to error state instead of leaving tool loading forever', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Search the web');

    mock.emit({
      method: 'item/started',
      params: { item: { id: 'web-1', type: 'webSearch', query: 'vite docs' } },
    });
    mock.emit({
      method: 'item/completed',
      params: { item: { id: 'web-1', type: 'webSearch', query: 'vite docs', status: 'failed' } },
    });

    const toolEntry = api.realtimeHistoryQueue.value.find((entry) => entry.parts.some((part) => part.id === 'web-1'));
    const toolPart = toolEntry?.parts.find((part) => part.id === 'web-1');
    expect(toolPart).toMatchObject({ type: 'tool', state: { status: 'error' } });
    expect(api.realtimeToolParts.value).toHaveLength(0);
  });

  it('replaces started fileChange shell parts with finalized edit metadata on completion', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Edit one file after start');

    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'edit-started-1',
          type: 'fileChange',
          changes: [{ path: 'empty.ts', diff: '' }],
        },
      },
    });

    expect(api.realtimeToolParts.value[0]?.part).toMatchObject({
      id: 'edit-started-1',
      tool: 'edit',
      state: { status: 'running' },
    });

    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'edit-started-1',
          type: 'fileChange',
          status: 'completed',
          changes: [{ path: 'empty.ts', diff: '' }],
        },
      },
    });

    const toolEntry = api.realtimeHistoryQueue.value.find((entry) => entry.parts.some((part) => part.id === 'edit-started-1'));
    const toolPart = toolEntry?.parts.find((part) => part.id === 'edit-started-1');
    expect(toolPart).toMatchObject({
      type: 'tool',
      tool: 'edit',
      state: {
        status: 'completed',
        input: { filePath: 'empty.ts', files: ['empty.ts'] },
        output: 'File changed: empty.ts',
        metadata: { filediff: { patch: 'File changed: empty.ts' } },
      },
    });
  });

  it('replaces started webSearch shell parts with finalized completed output on completion', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Search after start');

    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'web-started-1',
          type: 'webSearch',
          query: '',
        },
      },
    });

    expect(api.realtimeToolParts.value[0]?.part).toMatchObject({
      id: 'web-started-1',
      tool: 'websearch',
      state: { status: 'running' },
    });

    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'web-started-1',
          type: 'webSearch',
          status: 'completed',
          query: 'vite docs',
          action: { type: 'open', url: 'https://vite.dev' },
        },
      },
    });

    const toolEntry = api.realtimeHistoryQueue.value.find((entry) => entry.parts.some((part) => part.id === 'web-started-1'));
    const toolPart = toolEntry?.parts.find((part) => part.id === 'web-started-1');
    expect(toolPart).toMatchObject({
      type: 'tool',
      tool: 'websearch',
      state: {
        status: 'completed',
        input: { query: 'vite docs', action: 'open', url: 'https://vite.dev' },
        output: expect.stringContaining('Query: vite docs'),
      },
    });
  });

  it('maps completed single-file fileChange notifications into edit history entries', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Edit one file');

    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'edit-1',
          type: 'fileChange',
          status: 'completed',
          changes: [{ path: 'a.ts', diff: '@@ patch a' }],
        },
      },
    });

    const toolEntry = api.realtimeHistoryQueue.value.find((entry) => entry.parts.some((part) => part.id === 'edit-1'));
    const toolPart = toolEntry?.parts.find((part) => part.id === 'edit-1');
    expect(toolPart).toMatchObject({
      type: 'tool',
      tool: 'edit',
      state: {
        status: 'completed',
        input: { filePath: 'a.ts', files: ['a.ts'] },
        metadata: { filediff: { patch: '@@ patch a' } },
      },
    });
  });

  it('maps completed multi-file fileChange notifications into multiedit history entries', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Edit two files');

    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'edit-2',
          type: 'fileChange',
          status: 'completed',
          changes: [
            { path: 'a.ts', diff: '@@ patch a' },
            { path: 'b.ts', diff: '@@ patch b' },
          ],
        },
      },
    });

    const toolEntry = api.realtimeHistoryQueue.value.find((entry) => entry.parts.some((part) => part.id === 'edit-2'));
    const toolPart = toolEntry?.parts.find((part) => part.id === 'edit-2');
    expect(toolPart).toMatchObject({
      type: 'tool',
      tool: 'multiedit',
      state: {
        status: 'completed',
        input: { filePath: 'a.ts', files: ['a.ts', 'b.ts'] },
        metadata: {
          results: [
            { path: 'a.ts', filediff: { patch: '@@ patch a' } },
            { path: 'b.ts', filediff: { patch: '@@ patch b' } },
          ],
        },
      },
    });
  });

  it('clears realtimeStreamingPart and realtimeToolParts when selecting a thread', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Test.');

    mock.emit({ method: 'item/agentMessage/delta', params: { delta: 'streaming' } });
    mock.emit({
      method: 'item/started',
      params: { item: { id: 'cmd-1', type: 'commandExecution', command: 'ls' } },
    });

    expect(api.realtimeStreamingPart.value).not.toBeNull();
    expect(api.realtimeToolParts.value).toHaveLength(1);

    await api.selectThread('thr_existing');

    expect(api.realtimeStreamingPart.value).toBeNull();
    expect(api.realtimeReasoningPart.value).toBeNull();
    expect(api.realtimeToolParts.value).toEqual([]);
  });

  it('clears provisional realtime aliases and history when selecting a different thread', async () => {
    const mock = createAdapterMock();
    let resolveSend: ((result: CodexPromptResult) => void) | null = null;
    mock.adapter.sendPrompt = vi.fn().mockImplementation(() => new Promise<CodexPromptResult>((resolve) => {
      resolveSend = resolve;
    }));
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    const pendingSend = api.sendPrompt('Pending thread switch');

    expect(api.realtimeHistoryQueue.value.some((entry) => entry.info.id.includes('pending-turn:'))).toBe(true);

    await api.selectThread('thr_existing');

    expect(api.realtimeHistoryQueue.value.some((entry) => entry.info.id.includes('pending-turn:'))).toBe(false);
    expect(Object.keys(api.realtimeMessageAliases.value).some((key) => key.includes('pending-turn:'))).toBe(false);

    expect(resolveSend).not.toBeNull();
    resolveSend!({
      threadId: 'thr_existing',
      turn: { id: 'turn_after_switch', status: 'inProgress' },
    });
    await pendingSend;

    expect(api.realtimeHistoryQueue.value.some((entry) => entry.info.id === 'turn_after_switch:user:0')).toBe(false);
  });

  it('returns empty list and warns when collaborationMode/list throws (experimental API not enabled)', async () => {
    const mock = createAdapterMock();
    mock.adapter.listCollaborationModes = vi.fn().mockRejectedValue(new Error('method not found'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const result = await api.refreshCollaborationModes();
    expect(result.data).toEqual([]);
    expect(api.collaborationModes.value).toEqual([]);
    expect(api.collaborationModesLoading.value).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('normalizes non-array data to empty array when collaborationMode/list returns malformed payload', async () => {
    const mock = createAdapterMock();
    mock.adapter.listCollaborationModes = vi.fn().mockResolvedValue({ data: null });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.refreshCollaborationModes();
    expect(api.collaborationModes.value).toEqual([]);
  });

  it('preserves collaboration modes returned from a successful list call', async () => {
    const mock = createAdapterMock();
    mock.adapter.listCollaborationModes = vi.fn().mockResolvedValue({
      data: [
        { name: 'Plan', mode: 'plan', model: null, reasoningEffort: 'medium' },
        { name: 'Default', mode: 'default', model: null, reasoningEffort: null },
      ],
    });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const result = await api.refreshCollaborationModes();
    expect(api.collaborationModes.value).toEqual([
      { name: 'Plan', mode: 'plan', model: null, reasoningEffort: 'medium' },
      { name: 'Default', mode: 'default', model: null, reasoningEffort: null },
    ]);
    expect(result.data).toEqual([
      { name: 'Plan', mode: 'plan', model: null, reasoningEffort: 'medium' },
      { name: 'Default', mode: 'default', model: null, reasoningEffort: null },
    ]);
  });
});

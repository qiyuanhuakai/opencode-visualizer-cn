import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCodexApi } from './useCodexApi';
import { createAdapterMock, deferred, resetCodexApiTestState } from './useCodexApi.test-helpers';

describe('useCodexApi', () => {
  beforeEach(resetCodexApiTestState);

  it('ignores a stale home directory response when the same adapter reconnects', async () => {
    const mock = createAdapterMock();
    const staleHome = deferred<Response>();
    const originalFetch = globalThis.fetch;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => staleHome.promise)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ home: '/current-home' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    try {
      const staleConnection = api.connect();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await api.connect();
      expect(api.homeDir.value).toBe('/current-home');

      staleHome.resolve(
        new Response(JSON.stringify({ home: '/stale-home' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      await staleConnection;

      expect(api.homeDir.value).toBe('/current-home');
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('strips raw git remote URLs from loaded thread metadata', async () => {
    const mock = createAdapterMock();
    mock.adapter.listThreads = vi.fn().mockResolvedValue({
      data: [
        {
          id: 'thr_repo',
          preview: 'Repo',
          cwd: '/repo',
          gitInfo: {
            root: '/repo',
            branch: 'main',
            originUrl: 'https://token@example.com/org/repo.git',
          },
        },
      ],
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

    expect(api.threads.value.map((thread) => thread.cwd)).toEqual([
      '/home/codex',
      '/home/codex/repo',
    ]);
  });

  it('keeps the requested cwd when a newly started thread omits cwd', async () => {
    const mock = createAdapterMock();
    mock.adapter.startThread = vi
      .fn()
      .mockResolvedValue({ thread: { id: 'thr_new', preview: '' } });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    api.homeDir.value = '/home/codex';

    await api.connect();
    const thread = await api.startThread('~/repo');

    expect(mock.adapter.startThread).toHaveBeenCalledWith({ cwd: '/home/codex/repo' });
    expect(thread.cwd).toBe('/home/codex/repo');
    expect(api.threads.value.find((item) => item.id === 'thr_new')?.cwd).toBe('/home/codex/repo');
  });

  it('preserves known cwd and git info when later thread reads omit them', async () => {
    const mock = createAdapterMock();
    mock.adapter.startThread = vi
      .fn()
      .mockResolvedValue({ thread: { id: 'thr_new', preview: '' } });
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
    mock.adapter.listThreads = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: 'thr_existing', preview: 'Existing thread', cwd: '/repo/subdir' }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        data: [{ id: 'thr_existing', preview: 'Existing thread' }],
        nextCursor: null,
      });
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
    mock.adapter.startThread = vi
      .fn()
      .mockResolvedValue({ thread: { id: 'thr_new', cwd: '/repo/subdir', preview: '' } });
    mock.adapter.getVcsInfo = vi.fn().mockResolvedValue({ root: '/repo', branch: 'main' });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    const thread = await api.startThread('/repo/subdir');

    expect(mock.adapter.getVcsInfo).toHaveBeenCalledWith('/repo/subdir');
    expect(thread.gitInfo).toEqual({ root: '/repo', branch: 'main' });
    expect(api.threads.value.find((item) => item.id === 'thr_new')?.gitInfo).toEqual({
      root: '/repo',
      branch: 'main',
    });
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
      expect(api.threads.value.find((item) => item.id === 'thr_notify')?.gitInfo).toEqual({
        root: '/repo',
        branch: 'main',
      });
    });
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
});

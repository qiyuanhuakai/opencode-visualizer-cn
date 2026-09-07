import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, nextTick, ref } from 'vue';
import { createI18n } from 'vue-i18n';

const mockRunOneShotPtyCommand = vi.fn<(command: string, args?: string[]) => Promise<string>>();
const mockListFiles = vi.fn<(input: { directory: string; path: string }) => Promise<unknown[]>>();
const mockGetVcsInfo = vi.fn<(directory: string) => Promise<unknown>>();

vi.mock('../backends/registry', () => ({
  getActiveBackendAdapter: () => ({
    listFiles: mockListFiles,
    getVcsInfo: mockGetVcsInfo,
  }),
}));

vi.mock('./usePtyOneshot', () => ({
  usePtyOneshot: () => ({
    runOneShotPtyCommand: mockRunOneShotPtyCommand,
  }),
}));

function createMessages() {
  return {
    en: {
      app: {
        error: {
          treeLoadFailed: 'treeLoadFailed {message}',
        },
      },
    },
  };
}

async function flushAsyncWork() {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

function ptyScripts() {
  return mockRunOneShotPtyCommand.mock.calls.map((call) => call[1]?.at(-1) ?? '');
}

function statusRefreshCount() {
  return ptyScripts().filter((script) => script.includes('status --porcelain')).length;
}

async function mountComposable() {
  vi.resetModules();

  let api!: Awaited<typeof import('./useFileTree')>['useFileTree'] extends (
    ...args: never[]
  ) => infer T
    ? T
    : never;
  const activeDirectory = ref('/repo');
  const activeBackendKind = ref('opencode');
  const refreshEnabled = ref(true);
  const { useFileTree } = await import('./useFileTree');

  const i18n = createI18n({
    legacy: false,
    locale: 'en',
    messages: createMessages(),
  });

  const root = document.createElement('div');
  document.body.appendChild(root);

  const app = createApp(
    defineComponent({
      setup() {
        api = useFileTree({ activeDirectory, activeBackendKind, refreshEnabled });
        return () => null;
      },
    }),
  );

  app.use(i18n);
  app.mount(root);
  await flushAsyncWork();

  return {
    api,
    activeDirectory,
    activeBackendKind,
    refreshEnabled,
    async settle() {
      await flushAsyncWork();
    },
    unmount() {
      app.unmount();
      root.remove();
    },
  };
}

describe('useFileTree', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockListFiles.mockReset();
    mockGetVcsInfo.mockReset();
    mockRunOneShotPtyCommand.mockReset();

    mockGetVcsInfo.mockResolvedValue({ branch: 'main' });
    mockListFiles.mockResolvedValue([]);
    mockRunOneShotPtyCommand.mockImplementation(async (_command, args = []) => {
      const script = args.at(-1) ?? '';
      if (script.includes('status --porcelain')) {
        return [
          '## main',
          ' M src/a.ts',
          '##PREFIX',
          '',
          '##HEAD',
          'abc123',
          '##DIFFSTAT',
          ' 1 file changed, 1 insertion(+)',
          '',
          '##DIFFSTAT_CACHED',
          '',
        ].join('\0');
      }
      if (script.includes('git ls-files --others --exclude-standard -z')) {
        return '1';
      }
      if (script.includes('ls-files --cached --others --exclude-standard')) {
        return 'src/a.ts\0src/b.ts\0';
      }
      return '';
    });
  });

  afterEach(async () => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('auto-runs git status with diff stats during initial directory hydration', async () => {
    const mounted = await mountComposable();
    await mounted.settle();

    const scripts = mockRunOneShotPtyCommand.mock.calls.map((call) => call[1]?.at(-1) ?? '');
    const statusScripts = scripts.filter((script) => script.includes('status --porcelain'));
    expect(statusScripts).toHaveLength(1);
    expect(statusScripts[0]).toContain("printf '\\0##PREFIX\\0'");
    expect(statusScripts[0]).toContain("printf '\\0##HEAD\\0'");
    expect(statusScripts[0]).toContain('git diff --shortstat');
    expect(statusScripts[0]).toContain('git diff --cached --shortstat');
    expect(statusScripts[0]).not.toContain('wc -l <');
    expect(
      scripts.some((script) => script.includes('ls-files --cached --others --exclude-standard')),
    ).toBe(true);
    expect(
      scripts.some((script) => script.includes('git ls-files --others --exclude-standard -z')),
    ).toBe(true);
    expect(statusScripts[0]).toContain('-uno');
    expect(mounted.api.gitStatus.value?.files).toHaveLength(1);
    expect(mounted.api.gitStatus.value?.files.map((entry) => entry.path)).toEqual(['src/a.ts']);
    expect(mounted.api.gitStatus.value?.diffStats.unstaged.additions).toBe(1);
    expect(mounted.api.gitStatus.value?.untracked?.eligibleFileCount).toBe(1);
    expect(mounted.api.gitStatus.value?.untracked?.pending).toBe(false);

    mounted.unmount();
  });

  it('normalizes git status paths relative to the active subdirectory', async () => {
    const mounted = await mountComposable();
    mounted.activeDirectory.value = '/repo/src';
    mockRunOneShotPtyCommand.mockImplementation(async (_command, args = []) => {
      const script = args.at(-1) ?? '';
      if (script.includes('status --porcelain')) {
        return [
          '## main',
          ' M src/a.ts',
          ' M src/nested/b.ts',
          '##PREFIX',
          'src/',
          '##HEAD',
          'abc123',
          '##DIFFSTAT',
          ' 2 files changed, 3 insertions(+)',
          '',
          '##DIFFSTAT_CACHED',
          '',
        ].join('\0');
      }
      if (script.includes('git ls-files --others --exclude-standard -z')) {
        return '0';
      }
      if (script.includes('ls-files --cached --others --exclude-standard')) {
        return 'a.ts\0nested/b.ts\0';
      }
      return '';
    });

    await mounted.settle();
    await mounted.settle();

    expect(mounted.api.gitStatus.value?.files.map((entry) => entry.path)).toEqual([
      'a.ts',
      'nested/b.ts',
    ]);
    expect(Object.keys(mounted.api.gitStatusByPath.value).sort()).toEqual(['a.ts', 'nested/b.ts']);

    mounted.unmount();
  });

  it('reloads the tree when backend changes even if the directory string stays the same', async () => {
    vi.resetModules();

    const activeDirectory = ref('/repo');
    const activeBackendKind = ref('codex');
    const { useFileTree } = await import('./useFileTree');

    const i18n = createI18n({
      legacy: false,
      locale: 'en',
      messages: createMessages(),
    });

    const root = document.createElement('div');
    document.body.appendChild(root);

    const app = createApp(
      defineComponent({
        setup() {
          useFileTree({ activeDirectory, activeBackendKind });
          return () => null;
        },
      }),
    );

    app.use(i18n);
    app.mount(root);
    await flushAsyncWork();
    mockListFiles.mockClear();
    mockRunOneShotPtyCommand.mockClear();

    activeBackendKind.value = 'opencode';
    await flushAsyncWork();

    expect(mockRunOneShotPtyCommand).toHaveBeenCalled();

    app.unmount();
    root.remove();
  });

  it('skips full git file snapshot reload for content-only change events', async () => {
    const mounted = await mountComposable();
    await mounted.settle();

    mockRunOneShotPtyCommand.mockClear();
    mockListFiles.mockClear();

    mounted.api.feed({ file: '/repo/src/a.ts', event: 'change' });
    await vi.advanceTimersByTimeAsync(130);
    await mounted.settle();

    expect(mockListFiles).not.toHaveBeenCalled();
    expect(mockRunOneShotPtyCommand).toHaveBeenCalledTimes(1);
    expect(mockRunOneShotPtyCommand.mock.calls[0]?.[1]?.at(-1)).toContain('status --porcelain');
    expect(mockRunOneShotPtyCommand.mock.calls[0]?.[1]?.at(-1)).not.toContain(
      'ls-files --cached --others --exclude-standard',
    );

    mounted.unmount();
  });

  it('preserves queued content-only refreshes without upgrading to file snapshots', async () => {
    const mounted = await mountComposable();
    await mounted.settle();

    mockRunOneShotPtyCommand.mockClear();

    let releaseStatusRefresh: VoidFunction | undefined;
    let statusRefreshWaiting = false;
    mockRunOneShotPtyCommand.mockImplementation(async (_command, args = []) => {
      const script = args.at(-1) ?? '';
      if (script.includes('status --porcelain')) {
        await new Promise<void>((resolve) => {
          statusRefreshWaiting = true;
          releaseStatusRefresh = () => resolve();
        });
        return [
          '## main',
          ' M src/a.ts',
          '##PREFIX',
          '',
          '##HEAD',
          'abc123',
          '##DIFFSTAT',
          '',
          '##DIFFSTAT_CACHED',
          '',
        ].join('\0');
      }
      if (script.includes('git ls-files --others --exclude-standard -z')) {
        return '0';
      }
      if (script.includes('ls-files --cached --others --exclude-standard')) {
        return 'src/a.ts\0src/b.ts\0';
      }
      return '';
    });

    const first = mounted.api.refreshGitStatus({ includeFileSnapshot: false });
    await Promise.resolve();
    const second = mounted.api.refreshGitStatus({ includeFileSnapshot: false });
    await Promise.resolve();

    expect(mockRunOneShotPtyCommand).toHaveBeenCalledTimes(1);

    if (!statusRefreshWaiting || !releaseStatusRefresh) {
      throw new Error('expected in-flight status refresh to be waiting');
    }
    releaseStatusRefresh();
    await first;
    await second;
    await mounted.settle();

    expect(mockRunOneShotPtyCommand).toHaveBeenCalledTimes(2);
    for (const call of mockRunOneShotPtyCommand.mock.calls) {
      expect(call[1]?.at(-1)).toContain('status --porcelain');
      expect(call[1]?.at(-1)).not.toContain('ls-files --cached --others --exclude-standard');
    }

    mounted.unmount();
  });

  it('keeps expanded ignored directories loaded while reconciling additions and deletions', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    let snapshot = 0;
    mockRunOneShotPtyCommand.mockImplementation(async (_command, args = []) => {
      const script = args.at(-1) ?? '';
      if (script.includes('status --porcelain')) {
        return '## main\0##PREFIX\0\0##HEAD\0abc123\0##DIFFSTAT\0\0##DIFFSTAT_CACHED\0';
      }
      if (script.includes('git ls-files --others --exclude-standard -z')) return '0';
      if (script.includes('ls-files --cached --others --exclude-standard')) {
        return snapshot === 0 ? 'cache/tracked.ts\0src/old.ts\0' : 'cache/tracked.ts\0src/new.ts\0';
      }
      return '';
    });
    mockListFiles.mockImplementation(async ({ path }) => {
      if (path === '.') return [{ path: '/repo/cache', type: 'directory', ignored: true }];
      if (path === 'cache') {
        return snapshot === 0
          ? [
              { path: '/repo/cache/nested', type: 'directory', ignored: true },
              { path: '/repo/cache/old.log', type: 'file', ignored: true },
            ]
          : [
              { path: '/repo/cache/nested', type: 'directory', ignored: true },
              { path: '/repo/cache/new.log', type: 'file', ignored: true },
            ];
      }
      if (path === 'cache/nested') {
        return snapshot === 0
          ? [{ path: '/repo/cache/nested/old.tmp', type: 'file', ignored: true }]
          : [{ path: '/repo/cache/nested/new.tmp', type: 'file', ignored: true }];
      }
      return [];
    });

    const mounted = await mountComposable();
    await mounted.settle();
    mounted.api.toggleTreeDirectory('cache');
    await mounted.settle();
    mounted.api.toggleTreeDirectory('cache/nested');
    await mounted.settle();

    snapshot = 1;
    await vi.advanceTimersByTimeAsync(5_000);
    await mounted.settle();

    const cache = mounted.api.treeNodes.value.find((node) => node.path === 'cache');
    const nested = cache?.children?.find((node) => node.path === 'cache/nested');
    expect(mounted.api.expandedTreePaths.value).toEqual(['cache', 'cache/nested']);
    expect(cache).toMatchObject({ loaded: true, ignored: true });
    expect(cache?.children?.map((node) => node.path)).toEqual([
      'cache/nested',
      'cache/new.log',
      'cache/tracked.ts',
    ]);
    expect(nested).toMatchObject({ loaded: true, ignored: true });
    expect(nested?.children?.map((node) => node.path)).toEqual(['cache/nested/new.tmp']);
    expect(mounted.api.files.value).toEqual(['cache/tracked.ts', 'src/new.ts']);

    mounted.unmount();
  });

  it('reconciles ignored children inside an expanded tracked root directory', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    let snapshot = 0;
    mockRunOneShotPtyCommand.mockImplementation(async (_command, args = []) => {
      const script = args.at(-1) ?? '';
      if (script.includes('status --porcelain')) {
        return '## main\0##PREFIX\0\0##HEAD\0abc123\0##DIFFSTAT\0\0##DIFFSTAT_CACHED\0';
      }
      if (script.includes('git ls-files --others --exclude-standard -z')) return '0';
      if (script.includes('ls-files --cached --others --exclude-standard')) {
        return 'src/tracked.ts\0';
      }
      return '';
    });
    mockListFiles.mockImplementation(async ({ path }) => {
      if (path === '.') return [];
      if (path === 'src') {
        return snapshot === 0
          ? [
              { path: '/repo/src/cache', type: 'directory', ignored: true },
              { path: '/repo/src/old.tmp', type: 'file', ignored: true },
              { path: '/repo/src/tracked.ts', type: 'file' },
            ]
          : [
              { path: '/repo/src/cache', type: 'directory', ignored: true },
              { path: '/repo/src/new.tmp', type: 'file', ignored: true },
              { path: '/repo/src/tracked.ts', type: 'file' },
            ];
      }
      return [];
    });

    const mounted = await mountComposable();
    await mounted.settle();
    mounted.api.toggleTreeDirectory('src');
    await mounted.settle();

    snapshot = 1;
    await vi.advanceTimersByTimeAsync(5_000);
    await mounted.settle();

    const src = mounted.api.treeNodes.value.find((node) => node.path === 'src');
    expect(mounted.api.expandedTreePaths.value).toEqual(['src']);
    expect(src).toMatchObject({ loaded: true, ignored: false });
    expect(src?.children?.map((node) => node.path)).toEqual([
      'src/cache',
      'src/new.tmp',
      'src/tracked.ts',
    ]);

    mounted.unmount();
  });

  it('drops a queued snapshot refresh when refresh is disabled during an in-flight status request', async () => {
    const mounted = await mountComposable();
    await mounted.settle();
    mockRunOneShotPtyCommand.mockClear();

    let releaseStatus: VoidFunction | undefined;
    mockRunOneShotPtyCommand.mockImplementation(async (_command, args = []) => {
      const script = args.at(-1) ?? '';
      if (script.includes('status --porcelain')) {
        await new Promise<void>((resolve) => {
          releaseStatus = resolve;
        });
        return '## main\0##PREFIX\0\0##HEAD\0abc123\0##DIFFSTAT\0\0##DIFFSTAT_CACHED\0';
      }
      if (script.includes('ls-files --cached --others --exclude-standard')) return 'src/a.ts\0';
      return '0';
    });

    const first = mounted.api.refreshGitStatus({ includeFileSnapshot: false });
    await Promise.resolve();
    void mounted.api.refreshGitStatus({ includeFileSnapshot: true });
    mounted.refreshEnabled.value = false;
    await nextTick();

    if (!releaseStatus) throw new Error('expected the status refresh to be waiting');
    releaseStatus();
    await first;
    await mounted.settle();

    expect(statusRefreshCount()).toBe(1);
    expect(
      ptyScripts().filter((script) =>
        script.includes('ls-files --cached --others --exclude-standard'),
      ),
    ).toHaveLength(0);

    mounted.unmount();
  });

  it('does not retry a failed refresh after refresh is disabled', async () => {
    const mounted = await mountComposable();
    await mounted.settle();
    mockRunOneShotPtyCommand.mockClear();
    mockRunOneShotPtyCommand.mockImplementation(async (_command, args = []) => {
      const script = args.at(-1) ?? '';
      if (script.includes('status --porcelain')) throw new Error('status failed');
      return '';
    });

    const refresh = mounted.api.refreshGitStatus({ includeFileSnapshot: false });
    await Promise.resolve();
    mounted.refreshEnabled.value = false;
    await nextTick();
    await vi.advanceTimersByTimeAsync(200);
    await refresh;

    expect(statusRefreshCount()).toBe(1);

    mounted.unmount();
  });

  it('clears debounced file watcher work when refresh is disabled', async () => {
    const mounted = await mountComposable();
    await mounted.settle();
    mockListFiles.mockClear();
    mockRunOneShotPtyCommand.mockClear();

    mounted.api.feed({ file: '/repo/src/new.ts', event: 'add' });
    mounted.refreshEnabled.value = false;
    await nextTick();
    await vi.advanceTimersByTimeAsync(200);
    await mounted.settle();

    expect(mockListFiles).not.toHaveBeenCalled();
    expect(mockRunOneShotPtyCommand).not.toHaveBeenCalled();

    mounted.unmount();
  });

  it('refreshes the git tree and status from disk while the workspace is active', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const mounted = await mountComposable();
    await mounted.settle();

    mockRunOneShotPtyCommand.mockClear();
    mockListFiles.mockClear();
    mockRunOneShotPtyCommand.mockImplementation(async (_command, args = []) => {
      const script = args.at(-1) ?? '';
      if (script.includes('status --porcelain')) {
        return [
          '## main',
          '##PREFIX',
          '',
          '##HEAD',
          'def456',
          '##DIFFSTAT',
          '',
          '##DIFFSTAT_CACHED',
          '',
        ].join('\0');
      }
      if (script.includes('git ls-files --others --exclude-standard -z')) return '0';
      if (script.includes('ls-files --cached --others --exclude-standard')) {
        return 'src/a.ts\0src/after-commit.ts\0';
      }
      return '';
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await mounted.settle();

    expect(mounted.api.gitStatus.value?.branch.headShort).toBe('def456');
    expect(mounted.api.gitStatus.value?.files).toEqual([]);
    expect(mounted.api.files.value).toEqual(['src/a.ts', 'src/after-commit.ts']);
    expect(statusRefreshCount()).toBe(1);

    mounted.unmount();
  });

  it('refreshes a non-git file tree from disk while the workspace is active', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    mockGetVcsInfo.mockResolvedValue(null);
    mockListFiles.mockResolvedValue([{ path: '/repo/src', type: 'directory' }]);
    const mounted = await mountComposable();
    await mounted.settle();

    mockListFiles.mockClear();
    mockRunOneShotPtyCommand.mockClear();
    mockListFiles.mockImplementation(async ({ path }) => {
      if (path === '.') {
        return [
          { path: '/repo/src', type: 'directory' },
          { path: '/repo/new.txt', type: 'file' },
        ];
      }
      return [{ path: '/repo/src/a.ts', type: 'file' }];
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await mounted.settle();

    expect(mounted.api.files.value).toEqual(['new.txt', 'src/a.ts']);
    expect(statusRefreshCount()).toBe(1);

    mounted.unmount();
  });

  it('ignores a polling response from the previous backend', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const mounted = await mountComposable();
    await mounted.settle();

    let releasePreviousBackend: VoidFunction | undefined;
    let releaseActiveBackend: VoidFunction | undefined;
    let statusCallCount = 0;
    mockRunOneShotPtyCommand.mockImplementation(async (_command, args = []) => {
      const script = args.at(-1) ?? '';
      if (script.includes('status --porcelain')) {
        statusCallCount += 1;
        if (statusCallCount === 1) {
          await new Promise<void>((resolve) => {
            releasePreviousBackend = resolve;
          });
          return '## main\0##PREFIX\0\0##HEAD\0stale123\0##DIFFSTAT\0\0##DIFFSTAT_CACHED\0';
        }
        if (statusCallCount === 2) {
          await new Promise<void>((resolve) => {
            releaseActiveBackend = resolve;
          });
        }
        return '## main\0##PREFIX\0\0##HEAD\0fresh456\0##DIFFSTAT\0\0##DIFFSTAT_CACHED\0';
      }
      if (script.includes('git ls-files --others --exclude-standard -z')) return '0';
      if (script.includes('ls-files --cached --others --exclude-standard')) return 'src/a.ts\0';
      return '';
    });

    await vi.advanceTimersByTimeAsync(5_000);
    mounted.activeBackendKind.value = 'codex';
    await nextTick();
    if (!releasePreviousBackend) throw new Error('expected the old backend refresh to be waiting');
    releasePreviousBackend();
    await mounted.settle();
    vi.runAllTicks();
    await mounted.settle();

    expect(statusCallCount).toBe(2);
    expect(mounted.api.gitStatus.value?.branch.headShort).not.toBe('stale123');

    if (!releaseActiveBackend) throw new Error('expected the active backend refresh to be waiting');
    releaseActiveBackend();
    await vi.advanceTimersByTimeAsync(0);
    await mounted.settle();

    mounted.unmount();
  });

  it('does not let a retried file listing from the previous backend replace the active tree', async () => {
    const mounted = await mountComposable();
    await mounted.settle();

    let fileListCallCount = 0;
    mockRunOneShotPtyCommand.mockImplementation(async (_command, args = []) => {
      const script = args.at(-1) ?? '';
      if (script.includes('status --porcelain')) {
        return '## main\0##PREFIX\0\0##HEAD\0abc123\0##DIFFSTAT\0\0##DIFFSTAT_CACHED\0';
      }
      if (script.includes('git ls-files --others --exclude-standard -z')) return '0';
      if (script.includes('ls-files --cached --others --exclude-standard')) {
        fileListCallCount += 1;
        if (fileListCallCount === 1) throw new Error('previous backend disconnected');
        if (fileListCallCount === 2) return 'src/fresh.ts\0';
        return 'src/stale.ts\0';
      }
      return '';
    });

    const staleRefresh = mounted.api.refreshGitStatus({ includeFileSnapshot: true });
    await Promise.resolve();
    mounted.activeBackendKind.value = 'codex';
    await mounted.settle();
    await vi.advanceTimersByTimeAsync(200);
    await staleRefresh;
    await mounted.settle();

    expect(mounted.api.files.value).toEqual(['src/fresh.ts']);

    mounted.unmount();
  });

  it('stops polling while workspace refresh is disabled and resumes immediately', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    const mounted = await mountComposable();
    await mounted.settle();

    mockRunOneShotPtyCommand.mockClear();
    mounted.refreshEnabled.value = false;
    await nextTick();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(statusRefreshCount()).toBe(0);

    mounted.refreshEnabled.value = true;
    await nextTick();
    await vi.advanceTimersByTimeAsync(0);
    await mounted.settle();
    expect(statusRefreshCount()).toBe(1);

    mounted.unmount();
  });
});

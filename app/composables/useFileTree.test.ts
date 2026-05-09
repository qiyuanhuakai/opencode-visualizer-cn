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

async function mountComposable() {
  vi.resetModules();

  let api!: Awaited<typeof import('./useFileTree')>['useFileTree'] extends (...args: never[]) => infer T
    ? T
    : never;
  const activeDirectory = ref('/repo');
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
        api = useFileTree({ activeDirectory });
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
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
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
});

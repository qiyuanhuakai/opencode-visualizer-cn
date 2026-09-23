import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp, defineComponent, nextTick, ref } from 'vue';
import { createI18n } from 'vue-i18n';

const { runOneShotPtyCommand } = vi.hoisted(() => ({
  runOneShotPtyCommand: vi.fn<(command: string, args?: string[]) => Promise<string>>(),
}));

vi.mock('./usePtyOneshot', () => ({
  usePtyOneshot: () => ({ runOneShotPtyCommand }),
}));

const SESSION_ID = 'session_7033d53e-9de8-4f24-8f98-ab8dc23b27fb';
const SESSION_CWD = '/home/qiyuaner/apps/vis_app/vis.kimi-web-adapt';

const session = {
  id: SESSION_ID,
  workspace_id: 'wd_vis.kimi-web-adapt_a56788cba1ff',
  title: '',
  created_at: '2026-09-22T04:07:20.164Z',
  updated_at: '2026-09-22T04:07:20.164Z',
  busy: false,
  main_turn_active: false,
  pending_interaction: 'none',
  archived: false,
  metadata: { cwd: SESSION_CWD },
  agent_config: { model: '' },
  permission_rules: [],
  message_count: 0,
  last_seq: 1,
} as const;

const rootListEnvelope = {
  code: 0,
  msg: 'success',
  data: {
    items: [
      {
        path: 'app',
        name: 'app',
        kind: 'directory',
        modified_at: '2026-09-21T13:25:36.660Z',
        etag: 'muba2u50-35s-28h33',
      },
      {
        path: 'package.json',
        name: 'package.json',
        kind: 'file',
        modified_at: '2026-09-21T03:11:18.355Z',
        etag: 'muao4u37-323-28htq',
        size: 3963,
      },
    ],
    truncated: false,
  },
  request_id: '01M33MQFS_LIST_FIXTURE',
} as const;

const gitStatusEnvelope = {
  code: 0,
  msg: 'success',
  data: {
    branch: 'feat/kimi-web-adapt',
    ahead: 0,
    behind: 0,
    entries: {},
    additions: 0,
    deletions: 0,
    pullRequest: {
      number: 138,
      state: 'open',
      url: 'https://github.com/qiyuanhuakai/opencode-visualizer-cn/pull/138',
    },
  },
  request_id: '01M33MRM1070ZKWMV03868E15S',
} as const;

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function createFakeFetch(withHidden = false) {
  return vi.fn<typeof fetch>(async (input, init) => {
    const rawUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const path = new URL(rawUrl).pathname;

    if (path.endsWith('/api/v1/sessions') && init?.method === 'GET') {
      return jsonResponse({
        code: 0,
        msg: 'success',
        data: { items: [session], has_more: false },
        request_id: '01M33MR_SESSIONS_FIXTURE',
      });
    }
    if (path.endsWith(`/api/v1/sessions/${SESSION_ID}/fs:list`)) {
      const body = init?.body;
      const query: Record<string, unknown> = typeof body === 'string' ? JSON.parse(body) : {};
      if (withHidden) {
        const hidden = query.show_hidden === true && query.follow_gitignore === false;
        const names = query.path === '.'
          ? (hidden ? ['.git', '.config', '.env', 'visible.txt'] : ['visible.txt'])
          : query.path === '.git' ? ['config'] : query.path === '.config' && hidden ? ['.settings'] : [];
        return jsonResponse({ code: 0, data: { items: names.map((name) => ({
          path: query.path === '.' ? name : `${query.path}/${name}`, name,
          kind: name === '.git' || name === '.config' ? 'directory' : 'file',
          modified_at: '2026-09-22T00:00:00Z', etag: name,
        })), truncated: false } });
      }
      if (query.path === '.') return jsonResponse(rootListEnvelope);
      if (query.path === 'app') {
        return jsonResponse({
          code: 0,
          msg: 'success',
          data: { items: [], truncated: false },
          request_id: '01M33MQ_APP_LIST_FIXTURE',
        });
      }
    }
    if (path.endsWith(`/api/v1/sessions/${SESSION_ID}/fs:git_status`)) {
      expect(init?.body).toBe(JSON.stringify({}));
      return jsonResponse(gitStatusEnvelope);
    }
    return new Response('Not Found', { status: 404 });
  });
}

async function flushAsyncWork() {
  await Promise.resolve();
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

async function mountKimiFileTree(fakeFetch: ReturnType<typeof createFakeFetch>) {
  vi.resetModules();
  vi.stubGlobal('fetch', fakeFetch);
  const registry = await import('../backends/registry');
  registry.configureKimiWebBackend({
    bridgeUrl: 'ws://bridge.test/kimi-web/ws',
    bridgeToken: 'bridge-token',
  });
  registry.setActiveBackendKind('kimi-web');
  const { useFileTree } = await import('./useFileTree');
  const activeDirectory = ref(SESSION_CWD);
  const activeBackendKind = ref('kimi-web');
  const refreshEnabled = ref(false);
  let fileTree: ReturnType<typeof useFileTree> | undefined;
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = createApp(
    defineComponent({
      setup() {
        fileTree = useFileTree({ activeDirectory, activeBackendKind, refreshEnabled });
        return () => null;
      },
    }),
  );
  app.use(
    createI18n({
      legacy: false,
      locale: 'en',
      messages: { en: { app: { error: { treeLoadFailed: 'treeLoadFailed {message}' } } } },
    }),
  );
  app.mount(root);
  await vi.advanceTimersByTimeAsync(400);
  await flushAsyncWork();
  if (!fileTree) throw new Error('useFileTree did not initialize');
  return {
    fileTree,
    unmount: () => {
      app.unmount();
      root.remove();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  runOneShotPtyCommand.mockReset();
  runOneShotPtyCommand.mockRejectedValue(new Error('Kimi Web has no PTY'));
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('useFileTree with the real Kimi Web registry adapter', () => {
  it('includes dotfiles and hidden directories in the tree and searchable file cache', async () => {
    // Given / When
    const mounted = await mountKimiFileTree(createFakeFetch(true));
    // Then
    expect(mounted.fileTree.treeNodes.value.map((node) => node.name)).toEqual(['.config', '.git', '.env', 'visible.txt']);
    expect(mounted.fileTree.files.value).toEqual(['.env', 'visible.txt']);
    expect(mounted.fileTree.treeNodes.value.filter((node) => node.ignored).map((node) => node.name)).toEqual(['.config', '.git', '.env']);
    mounted.fileTree.toggleTreeDirectory('.git');
    for (let index = 0; index < 3; index++) await flushAsyncWork();
    await vi.advanceTimersByTimeAsync(100);
    expect(mounted.fileTree.treeNodes.value.find((node) => node.name === '.git')?.children).toMatchObject([{ path: '.git/config' }]);
    mounted.unmount();
  });
  it('loads cwd-relative kind-discriminated entries from session fs:list', async () => {
    const mounted = await mountKimiFileTree(createFakeFetch());

    expect(mounted.fileTree.treeError.value).toBe('');
    expect(mounted.fileTree.treeNodes.value).toMatchObject([
      { name: 'app', path: 'app', type: 'directory' },
      { name: 'package.json', path: 'package.json', type: 'file' },
    ]);
    expect(mounted.fileTree.files.value).toEqual(['package.json']);

    mounted.unmount();
  });

  it('hydrates Kimi git data and file snapshot without entering the PTY strategy', async () => {
    const mounted = await mountKimiFileTree(createFakeFetch());

    expect(runOneShotPtyCommand).not.toHaveBeenCalled();
    expect(mounted.fileTree.gitStatus.value).toMatchObject({
      branch: { branch: 'feat/kimi-web-adapt', ahead: 0, behind: 0 },
      files: [],
      untracked: { eligibleFileCount: 0, pending: false },
    });
    expect(mounted.fileTree.files.value).toEqual(['package.json']);
    expect(mounted.fileTree.treeError.value).toBe('');

    mounted.unmount();
  });
});

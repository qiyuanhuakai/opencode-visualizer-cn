import { describe, expect, it, vi } from 'vitest';

import {
  createDshAdapter,
  DSH_ADAPTER_METHODS,
  DSH_CAPABILITIES,
  DshUnsupportedError,
  mapDshSessionsToProjects,
  upsertDshSessionIntoProjects,
  type DshAdapterOptions,
  type DshBridgeFetcher,
} from './dshAdapter';
import {
  DshMissingCredentialError,
  DshRemoteRpcError,
  type DshRpcClient,
} from '../../utils/dshRpc';
import type { DshMuxClient } from '../../utils/dshMux';
import { DSH_WIRE_VERSION } from './types';
import type { DshJsonValue } from './types';

const DSH_BRIDGE_URL = 'ws://localhost:23004/dsh/ws';

// ---------------------------------------------------------------------------
// Fixtures (synthetic; the dsh wire contract is anchored in ./types.ts)
// ---------------------------------------------------------------------------

const MODEL_CATALOG = {
  providers: [
    {
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [
        {
          id: 'deepseek-flash',
          display_name: 'DeepSeek-V41-Flash',
          reasoningEfforts: ['off', 'low', 'high', 'max'],
          defaultReasoningEffort: 'high',
        },
        {
          id: 'deepseek-v4-pro',
          display_name: 'DeepSeek-V41-Pro',
          reasoningEfforts: ['off', 'low', 'high', 'max'],
          defaultReasoningEffort: 'high',
        },
      ],
    },
  ],
};

const WORKSPACE_BASELINE = {
  type: 'baseline',
  value: {
    items: [
      {
        workspaceId: 'ws-git',
        path: '/tmp/dsh/repo',
        title: 'repo',
        sessionIds: ['session-1', 'session-2', 'session-archived'],
        createdAt: '2026-09-30T00:00:00.000Z',
        updatedAt: '2026-09-30T00:01:00.000Z',
      },
      {
        workspaceId: 'ws-plain',
        path: '/tmp/dsh/notes',
        title: 'notes',
        sessionIds: ['session-3'],
        createdAt: '2026-09-30T00:00:00.000Z',
        updatedAt: '2026-09-30T00:02:00.000Z',
      },
    ],
    archivedSessionIds: ['session-archived'],
    pinnedSessionIds: ['session-2'],
  },
};

const SESSION_LIST_ITEMS = [
  { sessionId: 'session-1', workspaceId: 'ws-git', cwd: '/tmp/dsh/repo', title: 'Root session' },
  {
    sessionId: 'session-2',
    workspaceId: 'ws-git',
    cwd: '/tmp/dsh/repo',
    title: 'Forked session',
    parentSession: 'session-1',
  },
  {
    sessionId: 'session-archived',
    workspaceId: 'ws-git',
    cwd: '/tmp/dsh/repo',
    title: 'Old session',
  },
  {
    sessionId: 'session-3',
    workspaceId: 'ws-plain',
    cwd: '/tmp/dsh/notes',
    title: 'Notes session',
  },
  // Not claimed by any workspace (subagent/child sessions never ride workspace
  // sessionIds): it must still land somewhere instead of vanishing from the tree.
  { sessionId: 'session-orphan', cwd: '/tmp/dsh/orphan', title: 'Orphan session' },
];

/**
 * The follow snapshot deliberately reports a DIFFERENT model than the catalog
 * default so a test can prove the read-back (projections.modelSelection.lastUsed)
 * is the source of truth, not the write echo.
 */
const SESSION_FOLLOW_SNAPSHOT = {
  type: 'snapshot',
  header: {
    version: 4,
    id: 'session-new',
    createdAt: 1790692532388,
    cwd: '/tmp/dsh/repo',
    isSeeded: false,
    agentPreset: 'standard',
  },
  cursor: 3,
  records: [],
  hasMore: false,
  projections: {
    asOfSeq: 3,
    values: {
      title: 'New session',
      modelSelection: {
        lastUsed: {
          provider: 'deepseek-official',
          model: 'deepseek-v4-pro',
          reasoningEffort: 'high',
        },
        next: null,
      },
    },
  },
};

// ---------------------------------------------------------------------------
// Injectable fakes
// ---------------------------------------------------------------------------

type RpcCall = { namespace: string; method: string; args: Record<string, unknown> };

function fakeRpcClient(responses: Record<string, unknown>) {
  const calls: RpcCall[] = [];
  const client = {
    call: vi.fn(async (namespace: string, method: string, args: Record<string, unknown> = {}) => {
      calls.push({ namespace, method, args });
      const key = `${namespace}/${method}`;
      const response = responses[key];
      if (response === undefined) throw new Error(`unexpected dsh rpc ${key}`);
      if (response instanceof Error) throw response;
      return response as DshJsonValue;
    }),
    callMultipart: vi.fn(async () => ({ metadata: {}, bytes: [] })),
    nextRpcId: vi.fn(() => 'dsh-test-1'),
  } as unknown as DshRpcClient;
  return { client, calls };
}

function fakeMuxClient(frames: Record<string, unknown>) {
  const opened: Array<{ endpoint: string; args: Record<string, unknown> }> = [];
  const cancelled: string[] = [];
  const client = {
    connect: vi.fn(async () => undefined),
    open: vi.fn((endpoint: string, payload: { args: Record<string, unknown> }) => {
      opened.push({ endpoint, args: payload.args });
      const streamId = `stream-${opened.length}`;
      const value = frames[endpoint];
      return {
        streamId,
        promise: Promise.resolve(value === undefined ? [] : [value]),
        onItem: (listener: (value: unknown) => void) => {
          if (value !== undefined) listener(value);
          return () => undefined;
        },
        cancel: () => {
          cancelled.push(streamId);
        },
      };
    }),
    cancel: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
  } as unknown as DshMuxClient;
  return { client, opened, cancelled };
}

function bridgeResponses() {
  return {
    'session/list': { items: SESSION_LIST_ITEMS },
    'session/create': { sessionId: 'session-new', agentPreset: 'standard' },
    'session/selectModel': {
      selected: {
        provider: 'deepseek-official',
        model: 'deepseek-v4-pro',
        reasoningEffort: 'high',
      },
    },
    'session/fork': { sessionId: 'session-fork' },
    'session/cancel': { accepted: true },
    'session/modelCatalog': MODEL_CATALOG,
    'account/getState': { status: 'signed-out', attempt: null, links: {} },
    'workspaceFiles/list': {
      path: '.',
      entries: [
        { name: 'a.txt', type: 'file', size: 3 },
        { name: 'src', type: 'directory', size: 0 },
      ],
      truncated: false,
    },
    'workspaceFiles/read': {
      absolutePath: '/tmp/dsh/repo/a.txt',
      version: 1,
      bytes: 3,
      offset: 0,
      text: 'abc',
      lines: ['abc'],
      eof: true,
    },
  };
}

function bridgeFetcher() {
  return vi.fn(async (url: string, init: { method: string; body?: string }) => {
    if (url.endsWith('/command/exec')) {
      // Every git probe "fails": a non-git directory has no identity to report.
      return new Response(
        JSON.stringify({ stdout: '', stderr: 'not a git repository', exitCode: 128 }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      );
    }
    void init;
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as DshBridgeFetcher;
}

function adapterOptions(overrides: Partial<DshAdapterOptions> = {}): DshAdapterOptions {
  const rpc = fakeRpcClient(bridgeResponses());
  const mux = fakeMuxClient({
    'workspace/follow': WORKSPACE_BASELINE,
    'session/follow': SESSION_FOLLOW_SNAPSHOT,
  });
  return {
    bridgeUrl: DSH_BRIDGE_URL,
    bridgeToken: 'bridge-token',
    rpcClient: rpc.client,
    muxClient: mux.client,
    fetcher: bridgeFetcher(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DshAdapter capability matrix', () => {
  it('publishes exactly the planned capability values', () => {
    expect(DSH_CAPABILITIES).toEqual({
      projects: true,
      worktrees: false,
      sessions: true,
      sessionFork: true,
      sessionRevert: false,
      sessionRename: true,
      sessionArchive: true,
      sessionUnarchive: true,
      sessionDelete: false,
      sessionPin: true,
      sessionUnpin: true,
      sessionCompact: false,
      files: true,
      // Shell is supported but implemented through the bridge PTY surface, never
      // through dsh's own terminal endpoints (Metis #15 decision).
      terminal: true,
      permissions: true,
      questions: false,
      todos: false,
      status: true,
      providerConfig: true,
      imageAttachmentsOnly: false,
      projectPickerCreatesSession: false,
      ptyExitRequiresSyntheticEvent: false,
      ptyRefreshArtifactsOnSuccess: false,
      strictSandboxPaths: false,
      sessionManagementMode: 'standard',
    });
  });

  it('identifies itself as the dsh backend and copies the matrix onto the instance', () => {
    const adapter = createDshAdapter(adapterOptions());
    expect(adapter.kind).toBe('dsh');
    expect(adapter.label).toBe('dsh');
    expect(adapter.capabilities).toEqual(DSH_CAPABILITIES);
    // A per-instance copy: mutating one adapter must not poison the shared matrix.
    adapter.capabilities.worktrees = true;
    expect(DSH_CAPABILITIES.worktrees).toBe(false);
    expect(createDshAdapter(adapterOptions()).capabilities.worktrees).toBe(false);
  });
});

describe('DshAdapter unbound-method regression (memory #1770)', () => {
  /**
   * App.vue extracts adapter methods through `requireBackendMethod`, which
   * returns the function UNCHANGED — so every public method must survive being
   * invoked with no receiver at all. The list below is explicit (and asserted
   * to be exhaustive against the adapter's own prototype) so adding a method
   * without a bind fails here instead of in production.
   */
  const DETACHED_CALL_ARGS: Record<string, unknown[]> = {
    createSession: ['/tmp/dsh/repo'],
    forkSession: ['session-1', '7'],
    updateSession: ['session-1', { title: 'renamed' }],
    deleteSession: ['session-1'],
    revertSession: ['session-1', 'message-1'],
    unrevertSession: ['session-1'],
    listSessions: [],
    updateProject: ['ws-git', { name: 'renamed' }],
    createWorktree: ['/tmp/dsh/repo'],
    deleteWorktree: ['/tmp/dsh/repo', '/tmp/dsh/repo.wt'],
    configure: [{ authorization: 'rotated-token' }],
    disconnect: [],
    listPtys: [],
    createPty: [{ command: 'zsh' }],
    updatePtySize: ['pty-1', { rows: 24, cols: 80 }],
    deletePty: ['pty-1'],
    createPtyWebSocketUrl: ['/pty/pty-1'],
    listFiles: [{ directory: '/tmp/dsh/repo' }],
    readFileContent: [{ directory: '/tmp/dsh/repo', path: 'a.txt' }],
    readFileContentBytes: [{ directory: '/tmp/dsh/repo', path: 'a.txt' }],
    getVcsInfo: ['/tmp/dsh/repo'],
    listProviders: [],
    getGlobalConfig: [],
    updateSessionMode: ['session-1', { field: 'permissionMode', value: 'auto' }],
    syncSessionConfig: ['session-1', { model: 'deepseek-flash', mode: 'default' }],
    getSessionConfigOptions: [],
    listCommands: [],
    getSessionStatusMap: [],
    getGlobalHealth: [],
    abortSession: ['session-1'],
  };

  /**
   * Internal helpers live on the prototype too. Excluding them explicitly (and
   * asserting the excluded set is exactly this list) keeps the public-surface
   * check below total: a method added without a bind, or bound without being
   * listed, fails this test.
   */
  const INTERNAL_HELPERS = [
    'bridgeControlUrl',
    'bridgeRequest',
    'firstMuxItem',
    'workspaceBaseline',
    'workspaceItems',
    'findWorkspaceForDirectory',
    'sessionListItems',
    'listMappedSessions',
    'loadModelCatalog',
    'resolveModelProvider',
    'defaultModelSelection',
    'sessionIdForDirectory',
    'bridgeCommand',
  ];

  it('exposes exactly the enumerated method surface, every one of them bound', () => {
    const adapter = createDshAdapter(adapterOptions());
    const prototype = Object.getPrototypeOf(adapter) as Record<string, unknown>;
    const declared = Object.getOwnPropertyNames(prototype)
      .filter((name) => name !== 'constructor')
      .filter((name) => typeof prototype[name] === 'function');
    const publicSurface = declared.filter((name) => !INTERNAL_HELPERS.includes(name)).sort();
    expect(publicSurface).toEqual([...DSH_ADAPTER_METHODS].sort());
    // A renamed/removed helper must not silently widen the public bucket above.
    expect(declared.filter((name) => INTERNAL_HELPERS.includes(name)).sort()).toEqual(
      [...INTERNAL_HELPERS].sort(),
    );
    for (const name of DSH_ADAPTER_METHODS) {
      expect(Object.hasOwn(adapter, name), `${name} must be an own (bound) instance property`).toBe(
        true,
      );
    }
    expect(Object.keys(DETACHED_CALL_ARGS).sort()).toEqual([...DSH_ADAPTER_METHODS].sort());
  });

  it('invokes every public method detached from the adapter instance', async () => {
    const adapter = createDshAdapter(adapterOptions());
    const methods = adapter as unknown as Record<string, (...args: unknown[]) => unknown>;
    for (const name of DSH_ADAPTER_METHODS) {
      const method = methods[name];
      expect(typeof method, `${name} must exist`).toBe('function');
      let error: unknown;
      try {
        // Deliberately no receiver: `method(...)` — not `adapter.method(...)`.
        await method(...(DETACHED_CALL_ARGS[name] ?? []));
      } catch (thrown) {
        error = thrown;
      }
      const message = error instanceof Error ? error.message : String(error ?? '');
      expect(
        message,
        `${name} broke when detached from its instance (unbound method regression)`,
      ).not.toMatch(/Cannot read|is not a function|reading '|of undefined|of null/i);
    }
  });
});

describe('DshAdapter session and project mapping', () => {
  it('maps workspaces to projects and their sessionIds to sessions (kimi attribution rules)', async () => {
    const rpc = fakeRpcClient(bridgeResponses());
    const mux = fakeMuxClient({ 'workspace/follow': WORKSPACE_BASELINE });
    const adapter = createDshAdapter({
      bridgeUrl: DSH_BRIDGE_URL,
      bridgeToken: 'bridge-token',
      rpcClient: rpc.client,
      muxClient: mux.client,
      fetcher: bridgeFetcher(),
    });

    const sessions = (await adapter.listSessions()) as Array<Record<string, unknown>>;
    expect(sessions.map((session) => session.id).sort()).toEqual([
      'session-1',
      'session-2',
      'session-3',
      'session-archived',
      'session-orphan',
    ]);

    const projects = mapDshSessionsToProjects(sessions as never);
    // Workspaces become projects; the Git repo and the plain directory never merge.
    expect(Object.keys(projects).sort()).toEqual(['dsh:/tmp/dsh/orphan', 'ws-git', 'ws-plain']);

    const gitProject = projects['ws-git']!;
    expect(gitProject.worktree).toBe('/tmp/dsh/repo');
    expect(gitProject.name).toBe('repo');
    expect(Object.keys(gitProject.sandboxes)).toEqual(['/tmp/dsh/repo']);
    const gitSandbox = gitProject.sandboxes['/tmp/dsh/repo']!;
    expect(Object.keys(gitSandbox.sessions).sort()).toEqual([
      'session-1',
      'session-2',
      'session-archived',
    ]);
    // Only parentless sessions are roots (same rule as kimi); an archived
    // parentless session stays a root so it can be restored in place.
    expect(gitSandbox.rootSessions).toEqual(['session-1', 'session-archived']);
    expect(gitSandbox.sessions['session-2']!.parentID).toBe('session-1');

    const plainProject = projects['ws-plain']!;
    expect(plainProject.worktree).toBe('/tmp/dsh/notes');
    expect(Object.keys(plainProject.sandboxes)).toEqual(['/tmp/dsh/notes']);
    expect(Object.keys(plainProject.sandboxes['/tmp/dsh/notes']!.sessions)).toEqual(['session-3']);
  });

  it('carries archived and pinned state from the workspace baseline', async () => {
    const mux = fakeMuxClient({ 'workspace/follow': WORKSPACE_BASELINE });
    const adapter = createDshAdapter({
      bridgeUrl: DSH_BRIDGE_URL,
      bridgeToken: 'bridge-token',
      rpcClient: fakeRpcClient(bridgeResponses()).client,
      muxClient: mux.client,
      fetcher: bridgeFetcher(),
    });
    const sessions = (await adapter.listSessions()) as Array<Record<string, any>>;
    expect(
      sessions.find((session) => session.id === 'session-archived')!.time.archived,
    ).toBeGreaterThan(0);
    expect(sessions.find((session) => session.id === 'session-2')!.time.pinned).toBeGreaterThan(0);
    expect(sessions.find((session) => session.id === 'session-1')!.time.archived).toBeUndefined();
  });

  it('reads the workspace baseline and the session list through the mux/rpc clients', async () => {
    const rpc = fakeRpcClient(bridgeResponses());
    const mux = fakeMuxClient({ 'workspace/follow': WORKSPACE_BASELINE });
    const adapter = createDshAdapter({
      bridgeUrl: DSH_BRIDGE_URL,
      bridgeToken: 'bridge-token',
      rpcClient: rpc.client,
      muxClient: mux.client,
      fetcher: bridgeFetcher(),
    });
    await adapter.listSessions();
    expect(mux.opened.map((entry) => entry.endpoint)).toContain('workspace/follow');
    expect(rpc.calls).toEqual([{ namespace: 'session', method: 'list', args: { _request: {} } }]);
  });

  it('filters sessions by normalized directory', async () => {
    const adapter = createDshAdapter(
      adapterOptions({
        muxClient: fakeMuxClient({ 'workspace/follow': WORKSPACE_BASELINE }).client,
      }),
    );
    const sessions = (await adapter.listSessions({ directory: '/tmp/dsh/repo/' })) as Array<
      Record<string, unknown>
    >;
    expect(sessions.map((session) => session.id).sort()).toEqual([
      'session-1',
      'session-2',
      'session-archived',
    ]);
  });

  it('upserts a live-created session into an existing projects record', () => {
    const projects = mapDshSessionsToProjects([
      { id: 'session-1', workspaceId: 'ws-git', directory: '/tmp/dsh/repo', title: 'Root session' },
    ] as never);
    upsertDshSessionIntoProjects(projects, {
      id: 'session-new',
      workspaceId: 'ws-git',
      directory: '/tmp/dsh/repo',
      title: 'New session',
      parentID: 'session-1',
      status: 'unknown',
    } as never);
    const sandbox = projects['ws-git']!.sandboxes['/tmp/dsh/repo']!;
    expect(sandbox.sessions['session-new']!.parentID).toBe('session-1');
    expect(sandbox.rootSessions).toEqual(['session-1']);
  });
});

describe('DshAdapter session create + explicit model selection', () => {
  it('writes the model with session/selectModel and reads the projection back', async () => {
    const rpc = fakeRpcClient(bridgeResponses());
    const mux = fakeMuxClient({
      'workspace/follow': WORKSPACE_BASELINE,
      'session/follow': SESSION_FOLLOW_SNAPSHOT,
    });
    const adapter = createDshAdapter({
      bridgeUrl: DSH_BRIDGE_URL,
      bridgeToken: 'bridge-token',
      rpcClient: rpc.client,
      muxClient: mux.client,
      fetcher: bridgeFetcher(),
    });

    const created = (await adapter.createSession('/tmp/dsh/repo')) as Record<string, unknown>;

    // 1. The session is created inside the workspace that owns the directory.
    expect(rpc.calls.map((call) => `${call.namespace}/${call.method}`)).toEqual([
      'session/create',
      'session/modelCatalog',
      'session/selectModel',
    ]);
    expect(rpc.calls[0]).toEqual({
      namespace: 'session',
      method: 'create',
      args: { request: { workspaceId: 'ws-git', cwd: '/tmp/dsh/repo' } },
    });
    // 2. The model is written EXPLICITLY after creation (never assumed).
    expect(rpc.calls[2]).toEqual({
      namespace: 'session',
      method: 'selectModel',
      args: {
        request: {
          sessionId: 'session-new',
          provider: 'deepseek-official',
          model: 'deepseek-flash',
          reasoningEffort: 'high',
        },
      },
    });
    // 3. The read-back (follow snapshot projection) is the reported model, not the write echo.
    expect(mux.opened.map((entry) => entry.endpoint)).toEqual([
      'workspace/follow',
      'session/follow',
    ]);
    expect(mux.opened[1]!.args).toEqual({
      request: { address: { kind: 'session', sessionId: 'session-new' } },
    });
    expect(created.id).toBe('session-new');
    expect(created.projectID).toBe('ws-git');
    expect(created.directory).toBe('/tmp/dsh/repo');
    expect(created.model).toBe('deepseek-official/deepseek-v4-pro');
    expect(created.title).toBe('New session');
  });

  it('surfaces a typed error instead of silently skipping the model write', async () => {
    const rpc = fakeRpcClient({
      'session/create': { sessionId: 'session-new', agentPreset: 'standard' },
      'session/modelCatalog': new Error('catalog unavailable'),
    });
    const adapter = createDshAdapter({
      bridgeUrl: DSH_BRIDGE_URL,
      bridgeToken: 'bridge-token',
      rpcClient: rpc.client,
      muxClient: fakeMuxClient({ 'workspace/follow': WORKSPACE_BASELINE }).client,
      fetcher: bridgeFetcher(),
    });
    await expect(adapter.createSession('/tmp/dsh/repo')).rejects.toThrow('catalog unavailable');
  });
});

describe('DshAdapter typed RPC error passthrough', () => {
  function errorEnvelopeFetcher(code: string, message: string) {
    return vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            type: 'server-response',
            rpcId: 'dsh-1',
            result: { ok: false, error: { code, message } },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    );
  }

  it('rejects with DshMissingCredentialError for the MISSING_CREDENTIAL business code', async () => {
    // The REAL rpc client is used here: adapter → client → error envelope → typed error.
    const adapter = createDshAdapter({
      bridgeUrl: DSH_BRIDGE_URL,
      bridgeToken: 'bridge-token',
      muxClient: fakeMuxClient({ 'workspace/follow': WORKSPACE_BASELINE }).client,
      fetcher: errorEnvelopeFetcher(
        'MISSING_CREDENTIAL',
        'no session cookie',
      ) as unknown as DshBridgeFetcher,
    });
    const error = await adapter.listSessions().then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(DshMissingCredentialError);
    expect(error).toBeInstanceOf(DshRemoteRpcError);
    expect((error as DshRemoteRpcError).code).toBe('MISSING_CREDENTIAL');
  });

  it('keeps any other remote business code verbatim on DshRemoteRpcError', async () => {
    const adapter = createDshAdapter({
      bridgeUrl: DSH_BRIDGE_URL,
      bridgeToken: 'bridge-token',
      muxClient: fakeMuxClient({ 'workspace/follow': WORKSPACE_BASELINE }).client,
      fetcher: errorEnvelopeFetcher(
        'gateway/input-invalid',
        'bad request',
      ) as unknown as DshBridgeFetcher,
    });
    await expect(adapter.listSessions()).rejects.toMatchObject({
      name: 'DshRemoteRpcError',
      code: 'gateway/input-invalid',
    });
  });

  it('rejects unsupported capabilities with a typed error instead of a silent no-op', async () => {
    const adapter = createDshAdapter(adapterOptions());
    await expect(adapter.createWorktree('/tmp/dsh/repo')).rejects.toBeInstanceOf(
      DshUnsupportedError,
    );
    await expect(adapter.deleteWorktree('/tmp/dsh/repo', '/tmp/dsh/repo.wt')).rejects.toThrow(
      /worktrees/i,
    );
    await expect(adapter.deleteSession('session-1')).rejects.toThrow(/session delete/i);
    await expect(adapter.revertSession('session-1', 'message-1')).rejects.toThrow(/revert/i);
    await expect(adapter.unrevertSession('session-1')).rejects.toThrow(/unrevert/i);
    await expect(adapter.updateProject('ws-git', { name: 'x' })).rejects.toThrow(
      /project updates/i,
    );
    await expect(
      adapter.updateSessionMode('session-1', { field: 'x', value: 'y' }),
    ).rejects.toThrow(/session mode/i);
    await expect(adapter.listCommands()).rejects.toThrow(/command/i);
  });
});

describe('DshAdapter session actions', () => {
  it('renames through session/rename', async () => {
    const rpc = fakeRpcClient({
      ...bridgeResponses(),
      'session/rename': { title: 'renamed', seq: 9 },
    });
    const adapter = createDshAdapter({
      bridgeUrl: DSH_BRIDGE_URL,
      bridgeToken: 'bridge-token',
      rpcClient: rpc.client,
      muxClient: fakeMuxClient({}).client,
      fetcher: bridgeFetcher(),
    });
    await adapter.updateSession('session-1', { title: 'renamed' });
    expect(rpc.calls).toEqual([
      {
        namespace: 'session',
        method: 'rename',
        args: { request: { sessionId: 'session-1', title: 'renamed' } },
      },
    ]);
  });

  it('archives, unarchives, pins and unpins through the workspace session endpoints', async () => {
    const rpc = fakeRpcClient({
      ...bridgeResponses(),
      'workspace/archiveSession': {},
      'workspace/unarchiveSession': {},
      'workspace/pinSession': {},
      'workspace/unpinSession': {},
    });
    const adapter = createDshAdapter({
      bridgeUrl: DSH_BRIDGE_URL,
      bridgeToken: 'bridge-token',
      rpcClient: rpc.client,
      muxClient: fakeMuxClient({}).client,
      fetcher: bridgeFetcher(),
    });
    await adapter.updateSession('session-1', { time: { archived: 1 } });
    await adapter.updateSession('session-1', { time: { archived: 0 } });
    await adapter.updateSession('session-1', { time: { pinned: 1 } });
    await adapter.updateSession('session-1', { time: { pinned: 0 } });
    expect(rpc.calls.map((call) => `${call.namespace}/${call.method}`)).toEqual([
      'workspace/archiveSession',
      'workspace/unarchiveSession',
      'workspace/pinSession',
      'workspace/unpinSession',
    ]);
    for (const call of rpc.calls) {
      expect(call.args).toEqual({ request: { sessionId: 'session-1' } });
    }
  });

  it('forks through session/fork', async () => {
    const rpc = fakeRpcClient(bridgeResponses());
    const adapter = createDshAdapter({
      bridgeUrl: DSH_BRIDGE_URL,
      bridgeToken: 'bridge-token',
      rpcClient: rpc.client,
      muxClient: fakeMuxClient({}).client,
      fetcher: bridgeFetcher(),
    });
    await adapter.forkSession('session-1', '7');
    expect(rpc.calls).toEqual([
      {
        namespace: 'session',
        method: 'fork',
        args: { request: { sessionId: 'session-1', atSeq: 7 } },
      },
    ]);
  });

  it('aborts through session/cancel', async () => {
    const rpc = fakeRpcClient(bridgeResponses());
    const adapter = createDshAdapter({
      bridgeUrl: DSH_BRIDGE_URL,
      bridgeToken: 'bridge-token',
      rpcClient: rpc.client,
      muxClient: fakeMuxClient({}).client,
      fetcher: bridgeFetcher(),
    });
    await adapter.abortSession('session-1');
    expect(rpc.calls).toEqual([
      { namespace: 'session', method: 'cancel', args: { request: { sessionId: 'session-1' } } },
    ]);
  });
});

describe('DshAdapter model + provider surface', () => {
  it('builds the provider/model response from session/modelCatalog', async () => {
    const adapter = createDshAdapter(adapterOptions());
    const response = (await adapter.listProviders()) as any;
    expect(response.connected).toEqual(['deepseek-official']);
    expect(response.default).toEqual({ 'deepseek-official': 'deepseek-flash' });
    expect(Object.keys(response.all[0].models)).toEqual(['deepseek-flash', 'deepseek-v4-pro']);
    expect(response.all[0].models['deepseek-flash']).toMatchObject({
      id: 'deepseek-flash',
      name: 'DeepSeek-V41-Flash',
      providerID: 'deepseek-official',
    });
    // The reasoning-effort ladder becomes the model's variant map.
    expect(Object.keys(response.all[0].models['deepseek-flash'].variants)).toEqual([
      'off',
      'low',
      'high',
      'max',
    ]);
    expect(response.all[0].models['deepseek-flash'].variants.high.default).toBe(true);
  });

  it('reports enabled providers through getGlobalConfig', async () => {
    const adapter = createDshAdapter(adapterOptions());
    await expect(adapter.getGlobalConfig()).resolves.toEqual({
      enabled_providers: ['deepseek-official'],
      disabled_providers: [],
    });
  });

  it('exposes the thought-level select and syncs the selection through session/selectModel', async () => {
    const rpc = fakeRpcClient(bridgeResponses());
    const adapter = createDshAdapter({
      bridgeUrl: DSH_BRIDGE_URL,
      bridgeToken: 'bridge-token',
      rpcClient: rpc.client,
      muxClient: fakeMuxClient({}).client,
      fetcher: bridgeFetcher(),
    });
    const options = adapter.getSessionConfigOptions() as any[];
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({
      type: 'select',
      id: 'reasoningEffort',
      currentValue: 'high',
    });
    expect(options[0].options.map((option: any) => option.value)).toEqual([
      'off',
      'low',
      'high',
      'max',
    ]);

    await adapter.syncSessionConfig('session-1', {
      model: 'deepseek-v4-pro',
      mode: 'default',
      thoughtLevel: 'max',
    });
    expect(rpc.calls).toEqual([
      { namespace: 'session', method: 'modelCatalog', args: {} },
      {
        namespace: 'session',
        method: 'selectModel',
        args: {
          request: {
            sessionId: 'session-1',
            provider: 'deepseek-official',
            model: 'deepseek-v4-pro',
            reasoningEffort: 'max',
          },
        },
      },
    ]);
  });
});

describe('DshAdapter file surface', () => {
  it('lists workspace files through workspaceFiles/list scoped by the directory session', async () => {
    const rpc = fakeRpcClient(bridgeResponses());
    const adapter = createDshAdapter({
      bridgeUrl: DSH_BRIDGE_URL,
      bridgeToken: 'bridge-token',
      rpcClient: rpc.client,
      muxClient: fakeMuxClient({ 'workspace/follow': WORKSPACE_BASELINE }).client,
      fetcher: bridgeFetcher(),
    });
    const entries = (await adapter.listFiles({ directory: '/tmp/dsh/repo' })) as any[];
    expect(entries).toEqual([
      { name: 'a.txt', path: 'a.txt', type: 'file', ignored: false },
      { name: 'src', path: 'src', type: 'directory', ignored: false },
    ]);
    // The scope id is a SessionId whose cwd resolves to the directory root.
    const listCall = rpc.calls.find(
      (call) => call.method === 'list' && call.namespace === 'workspaceFiles',
    )!;
    expect(listCall.args).toEqual({ workspaceFileScopeId: 'session-1', path: '.' });
  });

  it('reads text content through workspaceFiles/read', async () => {
    const rpc = fakeRpcClient(bridgeResponses());
    const adapter = createDshAdapter({
      bridgeUrl: DSH_BRIDGE_URL,
      bridgeToken: 'bridge-token',
      rpcClient: rpc.client,
      muxClient: fakeMuxClient({ 'workspace/follow': WORKSPACE_BASELINE }).client,
      fetcher: bridgeFetcher(),
    });
    await expect(
      adapter.readFileContent({ directory: '/tmp/dsh/repo', path: 'a.txt' }),
    ).resolves.toEqual({
      type: 'text',
      encoding: 'utf-8',
      content: 'abc',
    });
    const readCall = rpc.calls.find(
      (call) => call.namespace === 'workspaceFiles' && call.method === 'read',
    )!;
    expect(readCall.args).toMatchObject({ workspaceFileScopeId: 'session-1', path: 'a.txt' });
  });
});

describe('DshAdapter git + health surface', () => {
  it('resolves git identity through the bridge command runner (codex precedence)', async () => {
    const fetcher = vi.fn(async (_url: string, init: { body?: string }) => {
      const payload = JSON.parse(init.body ?? '{}') as { args: string[] };
      const stdout = payload.args.includes('--show-toplevel')
        ? '/tmp/dsh/repo.feature'
        : payload.args.includes('--git-common-dir')
          ? '/tmp/dsh/repo/.git/worktrees/feature'
          : payload.args.includes('--show-current')
            ? 'feature'
            : '';
      return new Response(JSON.stringify({ stdout: `${stdout}\n`, stderr: '', exitCode: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const adapter = createDshAdapter({
      bridgeUrl: DSH_BRIDGE_URL,
      bridgeToken: 'bridge-token',
      rpcClient: fakeRpcClient(bridgeResponses()).client,
      muxClient: fakeMuxClient({}).client,
      fetcher: fetcher as unknown as DshBridgeFetcher,
    });
    // A linked worktree reports its own root but shares the repository root,
    // which is what keeps the worktree grouped with its repository.
    await expect(adapter.getVcsInfo('/tmp/dsh/repo.feature')).resolves.toEqual({
      root: '/tmp/dsh/repo.feature',
      branch: 'feature',
      commonRoot: '/tmp/dsh/repo',
      worktreeRoot: '/tmp/dsh/repo.feature',
    });
    // Every probe is a bridge control request, never a dsh RPC.
    for (const call of fetcher.mock.calls) {
      expect(call[0]).toBe('http://localhost:23004/command/exec');
    }
  });

  it('reports no identity for a non-git directory instead of failing', async () => {
    const adapter = createDshAdapter(adapterOptions());
    await expect(adapter.getVcsInfo('/tmp/dsh/notes')).resolves.toEqual({ root: '', branch: '' });
  });

  it('reports health from account/getState', async () => {
    const adapter = createDshAdapter(adapterOptions());
    await expect(adapter.getGlobalHealth()).resolves.toEqual({
      healthy: true,
      version: DSH_WIRE_VERSION,
    });
  });
});

describe('DshAdapter bridge PTY shell surface', () => {
  it('routes createPty/listPtys/resize/delete through the bridge PTY endpoints, never dsh terminal RPCs', async () => {
    const rpc = fakeRpcClient(bridgeResponses());
    const fetcher = bridgeFetcher();
    const adapter = createDshAdapter({
      bridgeUrl: DSH_BRIDGE_URL,
      bridgeToken: 'bridge-token',
      rpcClient: rpc.client,
      muxClient: fakeMuxClient({}).client,
      fetcher,
    });

    await adapter.listPtys();
    await adapter.createPty({ command: 'zsh', title: 'Shell', cwd: '/tmp/dsh/repo' });
    await adapter.updatePtySize('pty-1', { rows: 24, cols: 80 });
    await adapter.deletePty('pty-1');

    const urls = (fetcher as unknown as { mock: { calls: Array<[string, { method: string }]> } })
      .mock.calls;
    expect(urls.map(([url]) => url)).toEqual([
      'http://localhost:23004/pty',
      'http://localhost:23004/pty',
      'http://localhost:23004/pty/pty-1',
      'http://localhost:23004/pty/pty-1',
    ]);
    expect(urls.map(([, init]) => init.method)).toEqual(['GET', 'POST', 'PUT', 'DELETE']);
    // The dsh RPC surface is never touched for shell work.
    expect(rpc.calls).toEqual([]);
  });

  it('builds the PTY websocket URL against the bridge origin with the token', () => {
    const adapter = createDshAdapter(adapterOptions());
    expect(adapter.createPtyWebSocketUrl('/pty/pty-1')).toBe(
      'ws://localhost:23004/pty/pty-1?token=bridge-token',
    );
    expect(adapter.createPtyWebSocketUrl('/pty/pty-1', { rows: 24, cols: 80 })).toBe(
      'ws://localhost:23004/pty/pty-1?token=bridge-token&rows=24&cols=80',
    );
  });
});

describe('DshAdapter lifecycle', () => {
  it('disconnects the mux client and clears the slot state', () => {
    const mux = fakeMuxClient({});
    const adapter = createDshAdapter({
      bridgeUrl: DSH_BRIDGE_URL,
      bridgeToken: 'bridge-token',
      rpcClient: fakeRpcClient(bridgeResponses()).client,
      muxClient: mux.client,
      fetcher: bridgeFetcher(),
    });
    adapter.disconnect();
    expect(mux.client.disconnect).toHaveBeenCalledTimes(1);
  });

  it('rejects a bridge URL that cannot be derived into the dsh HTTP prefix', () => {
    expect(() => createDshAdapter({ bridgeUrl: 'not a url' })).toThrow();
    expect(() => createDshAdapter({ bridgeUrl: 'http://localhost:23004/dsh/ws' })).toThrow();
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { KimiWebClient, KimiWebMeta, KimiWebSession } from '../../utils/kimiWeb';
import {
  createKimiWebAdapter,
  mapKimiWebSession,
  mapKimiWebSessionsToProjects,
  upsertKimiWebSessionIntoProjects,
} from './kimiWebAdapter';

function session(overrides: Partial<KimiWebSession> = {}): KimiWebSession {
  return {
    id: 'session-1',
    workspace_id: 'workspace-1',
    title: 'Existing session',
    busy: false,
    main_turn_active: false,
    pending_interaction: 'none',
    archived: false,
    metadata: { cwd: '/work/repo' },
    agent_config: { model: 'kimi-k2' },
    last_seq: 12,
    ...overrides,
  };
}

function meta(overrides: Partial<KimiWebMeta> = {}): KimiWebMeta {
  return {
    server_version: '1',
    server_id: 'server-1',
    backend: 'kimi-web',
    capabilities: {},
    dangerous_bypass_auth: false,
    ...overrides,
  };
}

function client(
  items: KimiWebSession[] = [],
  models: string[] = [],
  serverMeta: KimiWebMeta = meta(),
) {
  return {
    getMeta: vi.fn(async () => serverMeta),
    getAuth: vi.fn(async () => ({ models_ready: true })),
    listModels: vi.fn(async () => ({
      items: models.map((model) => ({
        provider: 'managed:kimi-code',
        model,
        display_name: model,
      })),
    })),
    listSessions: vi.fn(async () => ({ items })),
    createSession: vi.fn(),
    updateProfile: vi.fn(),
    deleteSession: vi.fn(),
    archiveSession: vi.fn(),
    restoreSession: vi.fn(),
    abortSession: vi.fn(),
  } as unknown as KimiWebClient;
}

describe('KimiWebAdapter', () => {
  it('maps existing workspace sessions into selectable project state', async () => {
    const restClient = client([session()]);
    const adapter = createKimiWebAdapter({
      bridgeUrl: 'ws://localhost:23004/kimi-web/ws',
      client: restClient,
    });

    await adapter.initialize();
    const sessions = await adapter.listSessions();
    const projects = mapKimiWebSessionsToProjects(sessions);

    expect(projects['workspace-1']).toMatchObject({
      id: 'workspace-1',
      worktree: '/work/repo',
      sandboxes: {
        '/work/repo': {
          rootSessions: ['session-1'],
          sessions: {
            'session-1': { title: 'Existing session', status: 'idle' },
          },
        },
      },
    });
    expect(sessions[0]).toMatchObject({ model: 'kimi-k2', lastSeq: 12 });
  });

  it('maps an empty workspace to an empty session tree without throwing', async () => {
    const adapter = createKimiWebAdapter({
      bridgeUrl: 'ws://localhost:23004/kimi-web/ws',
      client: client(),
    });

    const sessions = await adapter.listSessions();

    expect(sessions).toEqual([]);
    expect(mapKimiWebSessionsToProjects(sessions)).toEqual({});
  });

  it('lists providers when the method is called without its adapter instance', async () => {
    const adapter = createKimiWebAdapter({
      bridgeUrl: 'ws://localhost:23004/kimi-web/ws',
      client: client([], ['kimi-k2']),
    });

    const listProviders = adapter.listProviders;

    await expect(listProviders()).resolves.toEqual({
      all: [
        {
          id: 'managed:kimi-code',
          name: 'managed:kimi-code',
          models: {
            'kimi-k2': {
              id: 'kimi-k2',
              name: 'kimi-k2',
              providerID: 'managed:kimi-code',
              limit: undefined,
              capabilities: { attachment: false, reasoning: false, toolcall: true },
            },
          },
        },
      ],
      connected: ['managed:kimi-code'],
    });
  });

  it('writes only the selected permission field', async () => {
    const restClient = client();
    const adapter = createKimiWebAdapter({
      bridgeUrl: 'ws://localhost:23004/kimi-web/ws',
      client: restClient,
    });
    expect(adapter.updateSessionMode).toBeTypeOf('function');
    const updateSessionMode = adapter.updateSessionMode;

    await updateSessionMode('session-1', { field: 'permissionMode', value: 'auto' });

    expect(restClient.updateProfile).toHaveBeenCalledOnce();
    expect(restClient.updateProfile).toHaveBeenCalledWith('session-1', {
      agent_config: { permission_mode: 'auto' },
    });
  });

  it('blocks tower enable when the experiment is unavailable', async () => {
    const restClient = client(
      [],
      [],
      meta({
        experimental_flags: { tower: false },
        features: [{ name: 'tower', state: 'Active' }],
      }),
    );
    const adapter = createKimiWebAdapter({
      bridgeUrl: 'ws://localhost:23004/kimi-web/ws',
      client: restClient,
    });
    expect(adapter.updateSessionMode).toBeTypeOf('function');

    await expect(
      adapter.updateSessionMode('session-1', { field: 'towerMode', value: true }),
    ).rejects.toMatchObject({ name: 'KimiWebTowerExperimentUnavailableError' });
    expect(restClient.updateProfile).not.toHaveBeenCalled();
  });

  it('allows permission changes while tower is unavailable', async () => {
    const restClient = client([], [], meta({ experimental_flags: { tower: false } }));
    const adapter = createKimiWebAdapter({
      bridgeUrl: 'ws://localhost:23004/kimi-web/ws',
      client: restClient,
    });
    expect(adapter.updateSessionMode).toBeTypeOf('function');

    await adapter.updateSessionMode('session-1', { field: 'permissionMode', value: 'auto' });

    expect(restClient.getMeta).not.toHaveBeenCalled();
    expect(restClient.updateProfile).toHaveBeenCalledOnce();
    expect(restClient.updateProfile).toHaveBeenCalledWith('session-1', {
      agent_config: { permission_mode: 'auto' },
    });
  });

  it('allows tower disable while the experiment is unavailable', async () => {
    const restClient = client([], [], meta({ experimental_flags: { tower: false } }));
    const adapter = createKimiWebAdapter({
      bridgeUrl: 'ws://localhost:23004/kimi-web/ws',
      client: restClient,
    });
    expect(adapter.updateSessionMode).toBeTypeOf('function');

    await adapter.updateSessionMode('session-1', { field: 'towerMode', value: false });

    expect(restClient.getMeta).not.toHaveBeenCalled();
    expect(restClient.updateProfile).toHaveBeenCalledOnce();
    expect(restClient.updateProfile).toHaveBeenCalledWith('session-1', {
      agent_config: { tower_mode: false },
    });
  });

  it('rejects an invalid permission value without calling the profile endpoint', async () => {
    const restClient = client();
    const adapter = createKimiWebAdapter({
      bridgeUrl: 'ws://localhost:23004/kimi-web/ws',
      client: restClient,
    });
    expect(adapter.updateSessionMode).toBeTypeOf('function');

    await expect(
      Reflect.apply(adapter.updateSessionMode, adapter, [
        'session-1',
        { field: 'permissionMode', value: 'invalid' },
      ]),
    ).rejects.toBeInstanceOf(TypeError);
    expect(restClient.updateProfile).not.toHaveBeenCalled();
  });

  it('preserves existing rename archive and restore behavior', async () => {
    const restClient = client();
    const adapter = createKimiWebAdapter({
      bridgeUrl: 'ws://localhost:23004/kimi-web/ws',
      client: restClient,
    });

    await adapter.updateSession('session-1', { title: 'Renamed' });
    await adapter.updateSession('session-1', { time: { archived: 1 } });
    await adapter.updateSession('session-1', { time: { archived: 0 } });

    expect(restClient.updateProfile).toHaveBeenCalledWith('session-1', { title: 'Renamed' });
    expect(restClient.archiveSession).toHaveBeenCalledWith('session-1');
    expect(restClient.restoreSession).toHaveBeenCalledWith('session-1');
  });

  it('maps archive, timestamps, workspace, and directory into shared session fields', () => {
    const mapped = mapKimiWebSession(
      session({
        archived: true,
        archived_at: '2026-09-21T00:00:00.000Z',
        created_at: '2026-09-20T00:00:00.000Z',
        updated_at: '2026-09-21T01:00:00.000Z',
      }),
    );

    expect(mapped.projectID).toBe('workspace-1');
    expect(mapped.directory).toBe('/work/repo');
    expect(mapped.time?.archived).toBe(Date.parse('2026-09-21T00:00:00.000Z'));
    expect(mapped.time?.created).toBe(Date.parse('2026-09-20T00:00:00.000Z'));
  });

  it('upserts a live-created session into an existing project without dropping siblings', () => {
    const projects = mapKimiWebSessionsToProjects([
      mapKimiWebSession(session({ id: 'session-old', title: 'Old' })),
    ]);

    upsertKimiWebSessionIntoProjects(
      projects,
      mapKimiWebSession(
        session({
          id: 'session-new',
          title: 'New',
          created_at: '2026-09-21T02:00:00.000Z',
          updated_at: '2026-09-21T03:00:00.000Z',
        }),
      ),
    );

    expect(projects['workspace-1'].sandboxes['/work/repo']).toMatchObject({
      rootSessions: ['session-old', 'session-new'],
      sessions: {
        'session-old': { title: 'Old' },
        'session-new': { title: 'New', status: 'idle' },
      },
    });
    expect(projects['workspace-1'].sandboxes['/work/repo'].sessions['session-new'].timeCreated).toBe(
      Date.parse('2026-09-21T02:00:00.000Z'),
    );
  });

  it('upsert is idempotent and creates the project/sandbox for a brand-new workspace', () => {
    const projects = mapKimiWebSessionsToProjects([]);
    const mapped = mapKimiWebSession(
      session({ id: 'session-x', workspace_id: 'workspace-2', metadata: { cwd: '/work/other' } }),
    );

    upsertKimiWebSessionIntoProjects(projects, mapped);
    upsertKimiWebSessionIntoProjects(projects, mapped);

    expect(projects['workspace-2']).toMatchObject({
      sandboxes: { '/work/other': { rootSessions: ['session-x'] } },
    });
  });

  it('upsert rejects a session without a workspace id instead of guessing a project', () => {
    const mapped = mapKimiWebSession(session({ workspace_id: '' }));
    expect(() => upsertKimiWebSessionIntoProjects({}, mapped)).toThrow(/no workspace id/);
  });
});

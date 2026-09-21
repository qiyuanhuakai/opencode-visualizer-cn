import { describe, expect, it, vi } from 'vitest';
import type { KimiWebClient, KimiWebSession } from '../../utils/kimiWeb';
import {
  createKimiWebAdapter,
  mapKimiWebSession,
  mapKimiWebSessionsToProjects,
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

function client(items: KimiWebSession[] = []) {
  return {
    getMeta: vi.fn(async () => ({ server_version: '1', capabilities: {} })),
    getAuth: vi.fn(async () => ({ models_ready: true })),
    listModels: vi.fn(async () => ({ items: [] })),
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
});

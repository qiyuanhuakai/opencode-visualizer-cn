import { describe, expect, it } from 'vitest';
import { reactive, ref } from 'vue';
import { createKimiWebClient, type KimiWebSession } from '../../utils/kimiWeb';
import { useBackendSessionTrees } from '../../composables/useBackendSessionTrees';
import {
  createKimiWebAdapter,
  mapKimiWebSession,
  mapKimiWebSessionsToProjects,
  upsertKimiWebSessionIntoProjects,
} from './kimiWebAdapter';

function session(id: string, cwd = '/repo'): KimiWebSession {
  return {
    id,
    workspace_id: 'workspace',
    title: id,
    metadata: { cwd },
    busy: false,
    main_turn_active: false,
    pending_interaction: 'none',
    archived: false,
  };
}

describe('Kimi workspace ownership', () => {
  it('stops after the result limit is met in the requested directory', async () => {
    // Given
    const requestedCursors: Array<string | null> = [];
    const client = createKimiWebClient({ baseUrl: 'http://kimi.test', fetcher: async (input) => {
      const cursor = new URL(String(input)).searchParams.get('before_id');
      requestedCursors.push(cursor);
      const pages: Record<string, KimiWebSession[]> = {
        first: [session('one', '/elsewhere')],
        one: [session('two', '/target')],
        two: [session('three', '/target')],
        three: [session('four', '/target')],
      };
      return Response.json({ code: 0, data: { items: pages[cursor ?? 'first'] ?? [], has_more: cursor !== 'three' } });
    } });
    const adapter = createKimiWebAdapter({ bridgeUrl: 'ws://kimi.test', client });
    // When
    const sessions = await adapter.listSessions({ directory: '/target', limit: 2 });
    // Then
    expect(sessions.map((item) => item.id)).toEqual(['two', 'three']);
    expect(requestedCursors).toEqual([null, 'one', 'two']);
  });
  it('keeps persisted child sessions under their parent without promoting them to roots', () => {
    // Given
    const parent = mapKimiWebSession(session('parent'));
    const child = mapKimiWebSession({ ...session('child'), metadata: {
      cwd: '/child-worktree', parent_session_id: 'parent', child_session_kind: 'child',
    } });
    // When
    const projects = mapKimiWebSessionsToProjects([child, parent]);
    // Then
    expect(child.parentID).toBe('parent');
    expect(projects.workspace.sandboxes['/repo'].rootSessions).toEqual(['parent']);
    expect(projects.workspace.sandboxes['/repo'].sessions.child.parentID).toBe('parent');
    expect(Object.values(projects.workspace.sandboxes).flatMap((sandbox) => sandbox.rootSessions)).not.toContain('child');
  });
  it('keeps workspace and directory identity when Git metadata arrives', () => {
    // Given
    const projects = reactive(mapKimiWebSessionsToProjects([mapKimiWebSession(session('one'))]));
    const gitInfoByDirectory = ref({});
    const trees = useBackendSessionTrees({
      activeBackendKind: ref('kimi-web'),
      projects,
      pinnedStore: ref({ 'workspace:one': 1 }),
      deletedSandboxStore: ref({}),
      gitInfoByDirectory,
      homePath: ref(''),
      replaceHomePrefix: (path) => path,
      resolveProjectColor: () => undefined,
    });
    const before = trees.topPanelTreeData.value[0];
    // When
    gitInfoByDirectory.value = { '/repo': { root: '/different-repository-root', branch: 'main' } };
    const after = trees.topPanelTreeData.value[0];
    // Then
    expect(before).toMatchObject({ kind: 'global', projectId: 'workspace' });
    expect(after).toMatchObject({ kind: 'sandbox', projectId: 'workspace', directory: '/different-repository-root' });
    expect(after?.sandboxes[0]).toMatchObject({ directory: '/repo', branch: 'main' });
    expect(trees.sessionTreeData.value[0]?.key).toBe(after?.key);
  });

  it('removes stale ownership when a session moves directory', () => {
    // Given
    const projects = mapKimiWebSessionsToProjects([mapKimiWebSession(session('one'))]);
    // When
    upsertKimiWebSessionIntoProjects(projects, mapKimiWebSession(session('one', '/other')));
    // Then
    const owners = Object.values(projects)
      .flatMap((project) => Object.values(project.sandboxes))
      .filter((sandbox) => sandbox.sessions.one);
    expect(owners.map((sandbox) => sandbox.directory)).toEqual(['/other']);
    expect(projects.workspace.worktree).toBe('/other');
  });

  it('chooses the same workspace root when list order changes', () => {
    // Given
    const sessions = [
      mapKimiWebSession(session('one', '/repo')),
      mapKimiWebSession(session('two', '/repo/worktree')),
    ];
    // When
    const forward = mapKimiWebSessionsToProjects(sessions);
    const backward = mapKimiWebSessionsToProjects([...sessions].reverse());
    // Then
    expect(backward.workspace.worktree).toBe(forward.workspace.worktree);
  });

  it('loads sessions beyond the first page before filtering by directory', async () => {
    // Given
    const client = createKimiWebClient({
      baseUrl: 'http://kimi.test',
      fetcher: async (input) => {
        const url = new URL(String(input));
        const second = url.searchParams.get('before_id') === 'one';
        return Response.json({
          code: 0,
          data: {
            items: [session(second ? 'two' : 'one', second ? '/other' : '/repo')],
            has_more: !second,
          },
        });
      },
    });
    const adapter = createKimiWebAdapter({ bridgeUrl: 'ws://kimi.test', client });
    // When
    const sessions = await adapter.listSessions({ directory: '/other' });
    // Then
    expect(sessions.map((item) => item.id)).toEqual(['two']);
  });
});

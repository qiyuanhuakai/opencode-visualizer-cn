import { describe, expect, it, vi } from 'vitest';
import { createSessionActionsFixture } from './useBackendSessionActions.test-helpers';
import { createKimiWebClient, KimiWebError, type KimiWebSession } from '../utils/kimiWeb';

describe('Kimi Web session actions', () => {
  it('forks a complete session and selects its server-provided workspace', async () => {
    const forkSession = vi.fn().mockResolvedValue({ id: 'forked', workspace_id: 'workspace', metadata: { cwd: '/repo' }, title: 'Copy' });
    const { actions, params } = createSessionActionsFixture({ activeBackendKind: 'kimi-web', kimiWebApi: { forkSession } });
    await actions.handleForkSession('source');
    expect(forkSession).toHaveBeenCalledWith('source');
    expect(params.switchSessionSelection).toHaveBeenCalledWith('workspace', 'forked');
    expect(params.seedForkedSessionComposerDraft).not.toHaveBeenCalled();
    expect(params.serverProjects.workspace?.sandboxes['/repo']?.sessions.forked).toBeDefined();
  });

  it('routes compaction to Kimi and preserves server failures', async () => {
    const compactSession = vi.fn().mockRejectedValue(new KimiWebError(40910, 'No messages to compact'));
    const { actions, mocks } = createSessionActionsFixture({ activeBackendKind: 'kimi-web', kimiWebApi: { compactSession } });
    await actions.handleCompactSession('source');
    expect(compactSession).toHaveBeenCalledWith('source');
    expect(mocks.setSessionError).toHaveBeenCalled();
    expect(mocks.codexApi.startThreadCompaction).not.toHaveBeenCalled();
  });

  it('selects a checkpoint branch and restores the selected prompt draft', async () => {
    const forkSessionAtMessage = vi.fn().mockResolvedValue({ id: 'forked', workspace_id: 'workspace', metadata: { cwd: '/repo' }, title: 'Checkpoint' });
    const { actions, params } = createSessionActionsFixture({ activeBackendKind: 'kimi-web', kimiWebApi: { forkSessionAtMessage } });
    const payload = { sessionId: 'source', messageId: 'message' };
    await actions.handleForkMessage(payload);
    expect(forkSessionAtMessage).toHaveBeenCalledWith('source', 'message');
    expect(params.seedForkedSessionComposerDraft).toHaveBeenCalledWith(payload, expect.objectContaining({ id: 'forked' }));
    expect(params.switchSessionSelection).toHaveBeenCalledWith('workspace', 'forked');
  });

  it('reloads undo with forceReset so removed turns disappear', async () => {
    const undoSessionFromMessage = vi.fn().mockResolvedValue(undefined);
    const { actions, params } = createSessionActionsFixture({ activeBackendKind: 'kimi-web', kimiWebApi: { undoSessionFromMessage } });
    params.selectedSessionId.value = 'source';
    await actions.handleRevertMessage({ sessionId: 'source', messageId: 'message' });
    expect(undoSessionFromMessage).toHaveBeenCalledWith('source', 'message');
    expect(params.reloadSelectedSessionState).toHaveBeenCalledWith('source', undefined, true);
  });

  it('does not select a late fork after the user switches backend', async () => {
    let finish: (value: KimiWebSession) => void = () => {};
    const forkSessionAtMessage = vi.fn(() => new Promise<KimiWebSession>(resolve => { finish = resolve; }));
    const { actions, params } = createSessionActionsFixture({ activeBackendKind: 'kimi-web', kimiWebApi: { forkSessionAtMessage } });
    const pending = actions.handleForkMessage({ sessionId: 'source', messageId: 'message' });
    params.activeBackendKind.value = 'opencode';
    finish({ id: 'forked', workspace_id: 'workspace', title: 'Fork', busy: false, main_turn_active: false, pending_interaction: 'none', archived: false });
    await pending;
    expect(params.switchSessionSelection).not.toHaveBeenCalled();
    expect(params.seedForkedSessionComposerDraft).not.toHaveBeenCalled();
  });

  it('ignores late undo errors after changing the selected session', async () => {
    let fail: (reason: Error) => void = () => {};
    const undoSessionFromMessage = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
    const { actions, params, mocks } = createSessionActionsFixture({ activeBackendKind: 'kimi-web', kimiWebApi: { undoSessionFromMessage } });
    const pending = actions.handleRevertMessage({ sessionId: 'source', messageId: 'message' });
    params.selectedSessionId.value = 'another';
    fail(new Error('late error'));
    await pending;
    expect(mocks.setSessionError).not.toHaveBeenCalled();
    expect(params.reloadSelectedSessionState).not.toHaveBeenCalled();
  });

  it('does not route unsupported message-level fork or revert to OpenCode', async () => {
    const { actions, mocks } = createSessionActionsFixture({ activeBackendKind: 'kimi-web' });
    await actions.handleForkMessage({ sessionId: 'source', messageId: 'message' });
    await actions.handleRevertMessage({ sessionId: 'source', messageId: 'message' });
    expect(mocks.openCodeApi.forkSession).not.toHaveBeenCalled();
    expect(mocks.openCodeApi.revertSession).not.toHaveBeenCalled();
    expect(mocks.setSessionError).toHaveBeenCalledTimes(2);
  });

  it('uses session action endpoints with JSON bodies and encoded session IDs', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(JSON.stringify({ code: 0, data: { id: 'forked' } })));
    const client = createKimiWebClient({ baseUrl: 'http://localhost', fetcher });
    await client.forkSession('source/id');
    await client.compactSession('source/id');
    expect(fetcher.mock.calls.map(([url]) => url)).toEqual(['http://localhost/api/v1/sessions/source%2Fid:fork', 'http://localhost/api/v1/sessions/source%2Fid:compact']);
    expect(fetcher.mock.calls[0]?.[1]?.body).toBe('{}');
  });
});

describe('Kimi Web file session selection', () => {
  it('finds an older directory on later session pages for filesystem operations', async () => {
    const { createKimiWebAdapter } = await import('../backends/kimiWeb/kimiWebAdapter');
    const paths: string[] = [];
    const client = createKimiWebClient({
      baseUrl: 'http://kimi.test',
      fetcher: async (input) => {
        const url = new URL(String(input));
        paths.push(url.pathname);
        if (url.pathname.endsWith('/fs:list')) return Response.json({ code: 0, data: { items: [], truncated: false } });
        const second = url.searchParams.get('before_id') === 'recent';
        return Response.json({ code: 0, data: { items: [{ id: second ? 'older' : 'recent', workspace_id: 'workspace', title: 'Session', metadata: { cwd: second ? '/old' : '/new' }, busy: false, archived: false }], has_more: !second } });
      },
    });
    const adapter = createKimiWebAdapter({ bridgeUrl: 'http://bridge.test', client });
    await expect(adapter.listFiles({ directory: '/old' })).resolves.toEqual([]);
    expect(paths).toContain('/api/v1/sessions/older/fs:list');
  });
});

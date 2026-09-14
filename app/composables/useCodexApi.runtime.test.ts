import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCodexApi } from './useCodexApi';
import type { CodexThreadGoal } from '../backends/codex/codexAdapter';
import { createAdapterMock, deferred, resetCodexApiTestState } from './useCodexApi.test-helpers';

describe('useCodexApi', () => {
  beforeEach(resetCodexApiTestState);

  it('loads runtime inspector data through capability-tracked composable methods', async () => {
    const mock = createAdapterMock();
    mock.adapter.getThreadGoal = vi.fn().mockResolvedValue({
      goal: {
        threadId: 'thr_existing',
        objective: 'Ship the integration',
        status: 'active',
        tokenBudget: 1000,
        tokensUsed: 50,
        timeUsedSeconds: 12,
        createdAt: 1,
        updatedAt: 2,
      },
    });
    mock.adapter.readAccountUsage = vi.fn().mockResolvedValue({
      summary: {
        lifetimeTokens: 100,
        peakDailyTokens: 20,
        longestRunningTurnSec: 12,
        currentStreakDays: 3,
        longestStreakDays: 7,
      },
      dailyUsageBuckets: [{ startDate: '2026-07-26', tokens: 20 }],
    });
    mock.adapter.readModelProviderCapabilities = vi.fn().mockResolvedValue({
      namespaceTools: true,
      imageGeneration: false,
      webSearch: true,
    });
    mock.adapter.listPermissionProfiles = vi.fn().mockResolvedValue({
      data: [{ id: 'default', description: 'Default profile' }],
      nextCursor: null,
    });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();

    await Promise.all([
      api.refreshThreadGoal('thr_existing'),
      api.refreshAccountUsage(),
      api.refreshModelProviderCapabilities(),
      api.refreshPermissionProfiles('/workspace'),
      api.refreshLoadedThreads(),
    ]);

    expect(api.threadGoal.value?.objective).toBe('Ship the integration');
    expect(api.accountUsage.value?.summary.lifetimeTokens).toBe(100);
    expect(api.modelProviderCapabilities.value).toEqual({
      namespaceTools: true,
      imageGeneration: false,
      webSearch: true,
    });
    expect(api.permissionProfiles.value).toEqual([
      { id: 'default', description: 'Default profile' },
    ]);
    expect(api.runtimeCapabilities.value).toMatchObject({
      'thread/goal/get': 'supported',
      'account/usage/read': 'supported',
      'modelProvider/capabilities/read': 'supported',
      'permissionProfile/list': 'supported',
      'thread/loaded/list': 'supported',
    });
  });

  it('keeps the selected thread goal when an older goal read resolves last', async () => {
    const mock = createAdapterMock();
    const staleGoal = deferred<{
      goal: {
        threadId: string;
        objective: string;
        status: 'active';
        tokenBudget: null;
        tokensUsed: number;
        timeUsedSeconds: number;
        createdAt: number;
        updatedAt: number;
      };
    }>();
    mock.adapter.getThreadGoal = vi.fn((params: { threadId: string }) =>
      params.threadId === 'thr_existing'
        ? staleGoal.promise
        : Promise.resolve({
            goal: {
              threadId: params.threadId,
              objective: 'Current goal',
              status: 'active' as const,
              tokenBudget: null,
              tokensUsed: 0,
              timeUsedSeconds: 0,
              createdAt: 1,
              updatedAt: 1,
            },
          }),
    );
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();

    const staleRefresh = api.refreshThreadGoal('thr_existing');
    await api.selectThread('thr_current');
    await api.refreshThreadGoal('thr_current');
    staleGoal.resolve({
      goal: {
        threadId: 'thr_existing',
        objective: 'Stale goal',
        status: 'active',
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    });
    await staleRefresh;

    expect(api.threadGoal.value).toMatchObject({
      threadId: 'thr_current',
      objective: 'Current goal',
    });
  });

  it('keeps the newest goal refresh for the selected thread', async () => {
    const mock = createAdapterMock();
    const staleGoal = deferred<{ goal: null }>();
    mock.adapter.getThreadGoal = vi
      .fn()
      .mockImplementationOnce(() => staleGoal.promise)
      .mockResolvedValueOnce({
        goal: {
          threadId: 'thr_existing',
          objective: 'Current goal',
          status: 'active',
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();

    const staleRefresh = api.refreshThreadGoal('thr_existing');
    await api.refreshThreadGoal('thr_existing');
    staleGoal.resolve({ goal: null });
    await staleRefresh;

    expect(api.threadGoal.value?.objective).toBe('Current goal');
  });

  it.each(['updated', 'cleared'])(
    'applies goal %s notifications before stale reads',
    async (event) => {
      const mock = createAdapterMock();
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();
      await api.selectThread('thr_existing');
      const goal: CodexThreadGoal = {
        threadId: 'thr_existing',
        objective: 'Live goal',
        status: 'active',
        tokenBudget: null,
        tokensUsed: 8,
        timeUsedSeconds: 2,
        createdAt: 1,
        updatedAt: 2,
      };
      mock.adapter.getThreadGoal = vi.fn().mockResolvedValue({ goal });
      await api.refreshThreadGoal();
      const stale = deferred<{ goal: CodexThreadGoal | null }>();
      mock.adapter.getThreadGoal = vi.fn(() => stale.promise);
      const refresh = api.refreshThreadGoal();
      expect(api.threadGoalLoading.value).toBe(true);
      expect(api.threadGoal.value).toEqual(goal);
      expect(api.threadGoalThreadId.value).toBe('thr_existing');

      mock.emit({
        method: `thread/goal/${event}`,
        params: { threadId: 'thr_existing', goal: { ...goal, tokensUsed: 20 } },
      });
      stale.resolve({ goal: { ...goal, objective: 'Stale goal' } });
      await refresh;

      expect(api.threadGoal.value).toEqual(
        event === 'cleared' ? null : { ...goal, tokensUsed: 20 },
      );
      expect(api.threadGoalThreadId.value).toBe('thr_existing');
      expect(api.threadGoalLoading.value).toBe(false);
    },
  );

  it('ignores goal notifications belonging to other threads', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.selectThread('thr_existing');
    await api.refreshThreadGoal();

    mock.emit({ method: 'thread/goal/cleared', params: { threadId: 'thr_other' } });

    expect(api.threadGoalThreadId.value).toBe('thr_existing');
  });

  it.each(['thr_other', ''])(
    'ignores goal updates with mismatched payload ownership (%s)',
    async (threadId) => {
      const mock = createAdapterMock();
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();
      await api.selectThread('thr_existing');
      await api.refreshThreadGoal();

      mock.emit({
        method: 'thread/goal/updated',
        params: {
          threadId: 'thr_existing',
          goal: {
            threadId,
            objective: 'Wrong owner',
            status: 'active',
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 1,
            updatedAt: 1,
          },
        },
      });

      expect(api.threadGoal.value).toBeNull();
      expect(api.threadGoalThreadId.value).toBe('thr_existing');
    },
  );

  it('keeps live plans owned by their source thread', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();

    mock.emit({
      method: 'turn/plan/updated',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn-1',
        explanation: 'Implementation plan',
        plan: [{ step: 'Probe runtime', status: 'completed' }],
      },
    });

    expect(api.planItems.value).toEqual([
      {
        threadId: 'thr_existing',
        turnId: 'turn-1',
        explanation: 'Implementation plan',
        plan: [{ step: 'Probe runtime', status: 'completed' }],
      },
    ]);
  });

  it('preserves each plugin marketplace locator when flattening plugin lists', async () => {
    const mock = createAdapterMock();
    mock.adapter.listPlugins = vi.fn().mockResolvedValue({
      marketplaces: [
        {
          name: 'local-marketplace',
          path: '/repo/.agents/plugins/marketplace.json',
          plugins: [
            {
              id: 'demo',
              name: 'demo',
              isAccessible: true,
              isEnabled: false,
              source: { type: 'local', path: '/repo/plugins/demo' },
            },
          ],
        },
      ],
    });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();

    await api.refreshPlugins();

    expect(api.plugins.value).toEqual([
      expect.objectContaining({
        id: 'demo',
        marketplaceName: 'local-marketplace',
        marketplacePath: '/repo/.agents/plugins/marketplace.json',
      }),
    ]);
  });

  it('keeps the newest plugin refresh when an older request resolves last', async () => {
    const mock = createAdapterMock();
    const stalePlugins = deferred<{
      marketplaces: Array<{
        name: string;
        path: string;
        plugins: Array<{
          id: string;
          name: string;
          isAccessible: boolean;
          isEnabled: boolean;
          source: { type: 'local'; path: string };
        }>;
      }>;
    }>();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    mock.adapter.listPlugins = vi
      .fn()
      .mockImplementationOnce(() => stalePlugins.promise)
      .mockResolvedValueOnce({
        marketplaces: [
          {
            name: 'current-marketplace',
            path: '/current/marketplace.json',
            plugins: [
              {
                id: 'current',
                name: 'current',
                isAccessible: true,
                isEnabled: true,
                source: { type: 'local', path: '/current' },
              },
            ],
          },
        ],
      });

    const staleRefresh = api.refreshPlugins();
    await api.refreshPlugins();
    stalePlugins.resolve({
      marketplaces: [
        {
          name: 'stale-marketplace',
          path: '/stale/marketplace.json',
          plugins: [
            {
              id: 'stale',
              name: 'stale',
              isAccessible: true,
              isEnabled: false,
              source: { type: 'local', path: '/stale' },
            },
          ],
        },
      ],
    });
    await staleRefresh;

    expect(api.plugins.value.map((plugin) => plugin.id)).toEqual(['current']);
  });

  it('keeps the newest account refresh when an older preload resolves last', async () => {
    const mock = createAdapterMock();
    const staleAccount = deferred<{ account: null }>();
    mock.adapter.readAccount = vi
      .fn()
      .mockImplementationOnce(() => staleAccount.promise)
      .mockResolvedValueOnce({ account: { type: 'chatgpt', email: 'current@example.com' } });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await vi.waitFor(() => expect(mock.adapter.readAccount).toHaveBeenCalledTimes(1));
    await api.refreshAccount();
    staleAccount.resolve({ account: null });
    await vi.waitFor(() => expect(mock.adapter.readAccount).toHaveBeenCalledTimes(2));
    await Promise.resolve();

    expect(api.account.value).toEqual({ type: 'chatgpt', email: 'current@example.com' });
  });

  it('keeps thread-goal set and clear as distinct guarded mutations and results', async () => {
    const mock = createAdapterMock();
    const goal = {
      threadId: 'thr_existing',
      objective: 'Ship the change',
      status: 'active' as const,
      tokenBudget: null,
      tokensUsed: 1,
      timeUsedSeconds: 2,
      createdAt: 3,
      updatedAt: 4,
    };
    mock.adapter.getThreadGoal = vi.fn().mockResolvedValue({ goal });
    mock.adapter.setThreadGoal = vi.fn().mockResolvedValue({ goal });
    mock.adapter.clearThreadGoal = vi.fn().mockResolvedValue({ cleared: true });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.refreshThreadGoal();
    await expect(api.setThreadGoal({ objective: 'Ship the change' })).resolves.toEqual({ goal });
    await expect(api.clearThreadGoal()).resolves.toEqual({ cleared: true });

    expect(mock.adapter.setThreadGoal).toHaveBeenCalledWith({
      threadId: 'thr_existing',
      objective: 'Ship the change',
    });
    expect(mock.adapter.clearThreadGoal).toHaveBeenCalledWith({ threadId: 'thr_existing' });
    expect(api.threadGoal.value).toBeNull();
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
    expect(api.collaborationModesError.value).toBe('method not found');
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

  it('clears collaboration mode state when disconnected', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    mock.adapter.listCollaborationModes = vi.fn().mockResolvedValue({
      data: [{ name: 'Plan', mode: 'plan', model: null, reasoningEffort: null }],
    });
    await api.refreshCollaborationModes();

    api.disconnectTransport();

    expect(api.collaborationModes.value).toEqual([]);
    expect(api.collaborationModesLoading.value).toBe(false);
    expect(api.collaborationModesError.value).toBeNull();
  });

  it.each([false, true])(
    'ignores a late collaboration failure after a newer refresh (reconnect=%s)',
    async (reconnect) => {
      const mock = createAdapterMock();
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();
      await api.refreshCollaborationModes();
      const stale = deferred<void>();
      mock.adapter.listCollaborationModes = vi.fn(async () => {
        await stale.promise;
        throw new Error('stale failure');
      });
      const refresh = api.refreshCollaborationModes();
      const modes = [{ name: 'Plan', mode: 'plan', model: null, reasoningEffort: null }];
      mock.adapter.listCollaborationModes = vi.fn().mockResolvedValue({ data: modes });
      if (reconnect) await api.connect();
      await api.refreshCollaborationModes();

      stale.resolve();
      await refresh;

      expect(api.collaborationModes.value).toEqual(modes);
      expect(api.collaborationModesError.value).toBeNull();
    },
  );

  it('clears collaboration errors after a successful empty response', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mock.adapter.listCollaborationModes = vi.fn().mockRejectedValue(new Error('failed'));
    await api.refreshCollaborationModes();
    mock.adapter.listCollaborationModes = vi.fn().mockResolvedValue({ data: [] });

    await api.refreshCollaborationModes();

    expect(api.collaborationModes.value).toEqual([]);
    expect(api.collaborationModesError.value).toBeNull();
    warnSpy.mockRestore();
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

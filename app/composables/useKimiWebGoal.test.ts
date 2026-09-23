import { effectScope, nextTick, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { useKimiWebGoal } from './useKimiWebGoal';
import { createKimiWebClient } from '../utils/kimiWeb';
import type { KimiWebGoal } from '../backends/kimiWeb/goal';

const goal: KimiWebGoal = {
  goalId: 'goal-1',
  objective: 'Finish task',
  status: 'active',
  turnsUsed: 2,
  tokensUsed: 31,
  wallClockMs: 1000,
};
const session = {
  id: 'session-1',
  workspace_id: 'workspace',
  title: 'Session',
  busy: false,
  main_turn_active: false,
  pending_interaction: 'none' as const,
  archived: false,
};
async function settle() {
  await Promise.resolve();
  await nextTick();
}

describe('Kimi Web thread goal', () => {
  it('reads goals through the authenticated encoded endpoint and rejects malformed data', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            msg: 'success',
            data: goal,
          }),
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 0, msg: 'success', data: {} })));
    const client = createKimiWebClient({
      baseUrl: 'http://bridge/kimi-web',
      getToken: () => 'token',
      fetcher,
    });
    expect(await client.getGoal('session/a')).toEqual(goal);
    expect(fetcher).toHaveBeenCalledWith(
      'http://bridge/kimi-web/api/v1/sessions/session%2Fa/goal',
      expect.objectContaining({
        headers: { Authorization: 'Bearer token' },
      }),
    );
    await expect(client.getGoal('session/a')).rejects.toThrow('Invalid Kimi Web goal response');
  });

  it('sets, pauses, resumes and cancels using partial profile changes and server-confirmed state', async () => {
    const client = {
      getGoal: vi.fn(async (): Promise<KimiWebGoal | null> => goal),
      updateProfile: vi.fn(async () => session),
    };
    const scope = effectScope();
    const state = scope.run(() => useKimiWebGoal(() => ({ sessionId: session.id, client })));
    if (!state) throw new Error('Missing goal state');
    await settle();
    for (const change of [
      { goal_objective: 'New task' },
      { goal_control: 'pause' as const },
      { goal_control: 'resume' as const },
      { goal_control: 'cancel' as const },
    ]) {
      await state.refresh(change);
      expect(client.updateProfile).toHaveBeenLastCalledWith(session.id, { agent_config: change });
    }
    expect(state.goal.value?.status).toBe('active');
    client.getGoal.mockResolvedValueOnce(null);
    await state.refresh();
    expect(state.goal.value).toBeNull();
    expect(state.objective.value).toBe('');
    scope.stop();
  });

  it('ignores a late response after switching sessions', async () => {
    const late = Promise.withResolvers<KimiWebGoal | null>();
    const sessionId = ref('old');
    const client = {
      getGoal: vi.fn().mockReturnValueOnce(late.promise).mockResolvedValue(null),
      updateProfile: vi.fn(async () => session),
    };
    const scope = effectScope();
    const state = scope.run(() => useKimiWebGoal(() => ({ sessionId: sessionId.value, client })));
    if (!state) throw new Error('Missing goal state');
    sessionId.value = 'new';
    await settle();
    late.resolve(goal);
    await settle();
    expect(state.goal.value).toBeNull();
    expect(state.loaded.value).toBe(true);
    expect(client.getGoal).toHaveBeenLastCalledWith('new');
    scope.stop();
  });

  it('blocks duplicate writes and invalidates controls after refresh failure', async () => {
    const write = Promise.withResolvers<typeof session>();
    const client = {
      getGoal: vi.fn(async (): Promise<KimiWebGoal | null> => goal),
      updateProfile: vi.fn(() => write.promise),
    };
    const scope = effectScope();
    const state = scope.run(() => useKimiWebGoal(() => ({ sessionId: session.id, client })));
    if (!state) throw new Error('Missing goal state');
    await settle();
    const saving = state.refresh({ goal_control: 'pause' });
    await state.refresh({ goal_control: 'pause' });
    expect(client.updateProfile).toHaveBeenCalledTimes(1);
    client.getGoal.mockRejectedValueOnce(new Error('Unavailable'));
    write.resolve(session);
    await saving;
    expect(state.loaded.value).toBe(false);
    expect(state.error.value).toBe('Unavailable');
    scope.stop();
  });
});

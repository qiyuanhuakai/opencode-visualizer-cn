import { describe, expect, it, vi } from 'vitest';
import { parseEnvironmentId, parseHarnessInstanceId, parseSessionRef } from '../../shared/runtime/identity.js';
import { codexManifest } from '../../shared/runtime/native/codex/capabilities.js';
import type { HarnessManifest } from '../../shared/runtime/harnessContract.js';
import type { RuntimeClient } from './client';
import { createNativeKimiSessionClient } from './nativeKimiClient';

describe('captured Kimi session client', () => {
  it('routes goal reads and objective changes through the same qualified native session', async () => {
    const environmentId = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
    const harnessInstanceId = parseHarnessInstanceId('22222222-2222-4222-8222-222222222222');
    const session = parseSessionRef({ environmentId, harnessInstanceId, nativeSessionId: 'goal/session' });
    const goal = { goalId: 'native-goal', objective: 'Native objective', status: 'active', turnsUsed: 2, tokensUsed: 10, wallClockMs: 100 };
    const manifest: HarnessManifest = { ...codexManifest({ environmentId, harnessInstanceId }, {}), kind: 'kimi-web', extensions: ['kimi.goal', 'kimi.updateProfile'].map(name => ({ name, owner: harnessInstanceId, scope: 'session', permission: 'native', schemaVersion: 1, support: { state: 'supported' } })) };
    const request = vi.fn(async () => goal);
    const mutate = vi.fn(() => ({ accepted: Promise.resolve({ operationId: 'goal-op' }), executed: Promise.resolve({ operationId: 'goal-op', value: {} }) }));
    const client = { request, mutate, scope: () => ({ isCurrent: () => true }) } as unknown as RuntimeClient;
    const native = createNativeKimiSessionClient(client, manifest, session);
    expect(await native.getGoal('goal/session')).toMatchObject(goal);
    await native.updateProfile('goal/session', { agent_config: { goal_objective: 'Changed objective' } });
    expect(request).toHaveBeenCalledWith(environmentId, 'native.query', { harnessInstanceId, session, operation: 'kimi.goal', args: {} }, expect.any(Object));
    expect(Reflect.get(mutate.mock.calls[0]!, '2')).toEqual({ harnessInstanceId, session, operation: 'kimi.updateProfile', args: { body: { agent_config: { goal_objective: 'Changed objective' } } } });
    await expect(native.getGoal('other')).rejects.toThrow('kimi.session_scope');
    expect(request).toHaveBeenCalledTimes(1);
    expect(native.canUpdateGoalObjective).toBe(false);
    await expect(native.updateGoalObjective('goal/session', 'Unsupported')).rejects.toThrow('unsupported');
    const modern = createNativeKimiSessionClient(client, { ...manifest, extensions: [...manifest.extensions, { name: 'kimi.goal.update', owner: harnessInstanceId, scope: 'session', permission: 'native', schemaVersion: 1, support: { state: 'supported' } }] }, session);
    expect(modern.canUpdateGoalObjective).toBe(true);
    await modern.updateGoalObjective('goal/session', 'Edited native objective');
    expect(Reflect.get(mutate.mock.calls[1]!, '2')).toEqual({ harnessInstanceId, session, operation: 'kimi.goal.update', args: { body: { objective: 'Edited native objective' } } });
    await expect(modern.updateGoalObjective('other', 'Refused')).rejects.toThrow('kimi.session_scope');
    expect(mutate).toHaveBeenCalledTimes(2);
  });
  it('binds advanced actions and checkpoint reads to one qualified session and refuses foreign paths', async () => {
    const environmentId = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
    const harnessInstanceId = parseHarnessInstanceId('22222222-2222-4222-8222-222222222222');
    const session = parseSessionRef({ environmentId, harnessInstanceId, nativeSessionId: 'session/a' });
    const operations = ['forkSession', 'kimi.undo', 'kimi.transcript', 'kimi.fileContent', 'kimi.tasks.cancel', 'kimi.models.list'];
    const manifest: HarnessManifest = { ...codexManifest({ environmentId, harnessInstanceId }, {}), kind: 'kimi-web',
      extensions: operations.map(name => ({ name, owner: harnessInstanceId, scope: name === 'kimi.models.list' ? 'instance' : 'session', permission: 'native', schemaVersion: 1, support: { state: 'supported' } })) };
    const request = vi.fn(async () => ({ items: [], has_more: false }));
    const mutate = vi.fn(() => ({ accepted: Promise.resolve({ operationId: 'op' }), executed: Promise.resolve({ operationId: 'op', value: { id: 'forked' } }) }));
    const client = { request, mutate, scope: () => ({ isCurrent: () => true }) } as unknown as RuntimeClient;
    const native = createNativeKimiSessionClient(client, manifest, session);
    await native.forkSession('session/a');
    await native.undoSession('session/a', 2);
    await native.cancelSessionTask('session/a', 'task/a');
    await native.getAgentTranscript('session/a', 'child/a', 'turn_5');
    await native.getTurnFileContent('session/a', 5, 'proof.txt', 'start');
    expect(mutate.mock.calls.map(call => Reflect.get(call, '2'))).toEqual([
      { harnessInstanceId, session, operation: 'forkSession', args: { body: {} } },
      { harnessInstanceId, session, operation: 'kimi.undo', args: { body: { count: 2 } } },
      { harnessInstanceId, session, operation: 'kimi.tasks.cancel', args: { id: 'task/a', body: {} } },
    ]);
    expect(request.mock.calls.map(call => Reflect.get(call, '2'))).toEqual([
      { harnessInstanceId, session, operation: 'kimi.transcript', args: { query: { agent_id: 'child/a', page_size: 100, before_turn: 'turn_5' } } },
      { harnessInstanceId, session, operation: 'kimi.fileContent', args: { query: { turn_id: 5, path: 'proof.txt', phase: 'start' } } },
    ]);
    await expect(native.forkSession('session/b')).rejects.toThrow('kimi.session_scope');
    await expect(native.compactSession('session/a')).rejects.toThrow('unsupported');
    expect(mutate).toHaveBeenCalledTimes(3);
    await native.undoSession('forked', 1);
    expect(request).toHaveBeenLastCalledWith(environmentId, 'session.list', { harnessInstanceId, args: {} }, expect.any(Object));
    expect(Reflect.get(mutate.mock.calls[3]!, '2')).toEqual({ harnessInstanceId, session: { ...session, nativeSessionId: 'forked' }, operation: 'kimi.undo', args: { body: { count: 1 } } });
    await native.listModels();
    expect(request).toHaveBeenLastCalledWith(environmentId, 'native.query', { harnessInstanceId, operation: 'kimi.models.list', args: {} }, expect.any(Object));
  });
});

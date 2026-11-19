import { describe, expect, it, vi } from 'vitest';
import { parseEnvironmentId, parseHarnessInstanceId, parseSessionRef } from '../../shared/runtime/identity.js';
import { codexManifest } from '../../shared/runtime/native/codex/capabilities.js';
import type { RuntimeClient } from './client';
import { createNativeCodexAdapter } from './nativeCodexAdapter';

const environmentId = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const harnessInstanceId = parseHarnessInstanceId('22222222-2222-4222-8222-222222222222');
const session = parseSessionRef({ environmentId, harnessInstanceId, nativeSessionId: 'thread' });

function setup() {
  const manifest = codexManifest({ environmentId, harnessInstanceId }, {
    'codex.models': async () => null,
    getGlobalConfig: async () => null,
    'codex.goal.set': async () => null,
  });
  const request = vi.fn(async (_target, _method, params) => params.operation === 'codex.models'
    ? { data: [{ id: 'native-model', model: 'native-model', displayName: 'Native Model', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'high' }] }] }
    : { config: {} });
  const mutate = vi.fn(() => ({ accepted: Promise.resolve({ operationId: 'accepted' }), executed: Promise.resolve({ operationId: 'accepted', value: { goal: { objective: 'goal' } } }) }));
  const client = { scope: () => ({ isCurrent: () => true }), request, mutate } as unknown as RuntimeClient;
  return { adapter: createNativeCodexAdapter(client, manifest, session), request, mutate };
}

describe('instance Codex adapter', () => {
  it('preserves existing provider normalization while reading through the captured instance', async () => {
    const { adapter, request } = setup();
    const providers = await adapter.listProviders();
    expect(providers.all[0]?.models['native-model']?.name).toBe('Native Model');
    expect(providers.default.codex).toBe('native-model');
    expect(request.mock.calls[0]).toEqual([environmentId, 'native.query', {
      harnessInstanceId, operation: 'codex.models', args: { native: { includeHidden: true } },
    }, expect.objectContaining({ selectionCurrent: expect.any(Function) })]);
  });
  it('waits for execution and rejects a different native thread before dispatch', async () => {
    const { adapter, mutate } = setup();
    await expect(adapter.setThreadGoal({ threadId: 'thread', objective: 'goal' })).resolves.toEqual({ goal: { objective: 'goal' } });
    expect(mutate.mock.calls[0]).toEqual([environmentId, 'native.extension', {
      harnessInstanceId, session, operation: 'codex.goal.set', args: { native: { objective: 'goal' } },
    }, expect.objectContaining({ idempotencyKey: expect.any(String) })]);
    await expect(adapter.setThreadGoal({ threadId: 'other-thread', objective: 'goal' })).rejects.toThrow('codex.native_thread');
    expect(mutate).toHaveBeenCalledTimes(1);
  });
});

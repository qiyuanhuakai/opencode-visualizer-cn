import { describe, expect, it, vi } from 'vitest';
import { parseEnvironmentId, parseHarnessInstanceId, parseSessionRef } from '../../shared/runtime/identity.js';
import { codexManifest } from '../../shared/runtime/native/codex/capabilities.js';
import type { HarnessManifest } from '../../shared/runtime/harnessContract.js';
import type { RuntimeClient } from './client';
import { createNativeBackendAdapter } from './nativeBackendAdapter';

const environmentId = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const harnessInstanceId = parseHarnessInstanceId('22222222-2222-4222-8222-222222222222');
const session = parseSessionRef({ environmentId, harnessInstanceId, nativeSessionId: 'session' });

function setup(kind: HarnessManifest['kind'], operations: string[], result: unknown) {
  const manifest: HarnessManifest = {
    ...codexManifest({ environmentId, harnessInstanceId }, {}),
    kind,
    extensions: operations.map(name => ({ name, owner: harnessInstanceId, scope: 'session', permission: 'native', schemaVersion: 1, support: { state: 'supported' } })),
  };
  const request = vi.fn(async () => result);
  const mutate = vi.fn((..._args: unknown[]) => ({ accepted: Promise.resolve({ operationId: 'op' }), executed: Promise.resolve({ operationId: 'op', value: null }) }));
  const client = { request, mutate, scope: () => ({ isCurrent: () => true }) } as unknown as RuntimeClient;
  return { adapter: createNativeBackendAdapter(client, manifest, session), request, mutate };
}

describe('captured native backend adapters', () => {
  it('preserves Kimi model effort and attachment metadata through the bridge', async () => {
    const { adapter, request } = setup('kimi-web', ['listProviders'], { items: [{
      provider: 'managed:kimi-code', model: 'kimi', display_name: 'Kimi',
      max_context_size: 128000, capabilities: ['thinking', 'image_in'],
      support_efforts: ['high'], default_effort: 'high',
    }] });
    await expect(adapter.listProviders?.()).resolves.toMatchObject({
      all: [{ id: 'managed:kimi-code', models: { kimi: {
        name: 'Kimi', limit: { context: 128000 }, variants: { high: { default: true } },
        capabilities: { attachment: true, reasoning: true },
      } } }],
    });
    expect(request).toHaveBeenCalledWith(environmentId, 'native.query', {
      harnessInstanceId, session, operation: 'listProviders', args: {},
    }, expect.any(Object));
  });

  it('writes only changed ACP options and rejects another session before dispatch', async () => {
    const { adapter, mutate } = setup('acp', ['getSessionConfigOptions', 'syncSessionConfig'], [{
      type: 'select', id: 'model', name: 'Model', category: 'model', currentValue: 'old',
      options: [{ value: 'old', name: 'Old' }, { value: 'new', name: 'New' }],
    }]);
    await adapter.syncSessionConfig?.('session', { model: 'old', mode: 'default' });
    expect(mutate).not.toHaveBeenCalled();
    await adapter.syncSessionConfig?.('session', { model: 'new', mode: 'default' });
    expect(mutate).toHaveBeenCalledWith(environmentId, 'native.extension', {
      harnessInstanceId, session, operation: 'syncSessionConfig', args: { configId: 'model', value: 'new' },
    }, expect.any(Object));
    await expect(adapter.syncSessionConfig?.('other', { model: 'new', mode: 'default' })).rejects.toThrow('acp.session_scope');
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('routes OpenCode OAuth credentials and command edits through declared captured operations', async () => {
    const { adapter, mutate } = setup('opencode', ['authorizeProviderOAuth', 'completeProviderOAuth', 'setProviderAuth', 'deleteProviderAuth', 'sendCommand', 'patchMessagePart'], null);
    await adapter.authorizeProviderOAuth?.('provider/a', { method: 2, directory: '/ignored', inputs: { scope: 'read' } });
    await adapter.completeProviderOAuth?.('provider/a', { method: 2, code: 'test-code' });
    await adapter.setProviderAuth?.('provider/a', { type: 'api', key: 'test-key' });
    await adapter.deleteProviderAuth?.('provider/a');
    await adapter.sendCommand?.('session', { command: 'review', arguments: 'changed', directory: '/ignored' });
    await adapter.patchMessagePart?.({ sessionID: 'session', messageID: 'message', partID: 'part', part: { type: 'text', text: 'edited' } });
    expect(mutate.mock.calls.map(call => call[2])).toEqual([
      { harnessInstanceId, session, operation: 'authorizeProviderOAuth', args: { providerID: 'provider/a', body: { method: 2, inputs: { scope: 'read' } } } },
      { harnessInstanceId, session, operation: 'completeProviderOAuth', args: { providerID: 'provider/a', body: { method: 2, code: 'test-code' } } },
      { harnessInstanceId, session, operation: 'setProviderAuth', args: { providerID: 'provider/a', body: { type: 'api', key: 'test-key' } } },
      { harnessInstanceId, session, operation: 'deleteProviderAuth', args: { providerID: 'provider/a' } },
      { harnessInstanceId, session, operation: 'sendCommand', args: { body: { command: 'review', arguments: 'changed' } } },
      { harnessInstanceId, session, operation: 'patchMessagePart', args: { messageID: 'message', partID: 'part', body: { type: 'text', text: 'edited' } } },
    ]);
    await expect(adapter.sendCommand?.('foreign', { command: 'review', arguments: '' })).rejects.toThrow('native.session_scope');
    await expect(adapter.patchMessagePart?.({ sessionID: 'foreign', messageID: 'm', partID: 'p', part: {} })).rejects.toThrow('native.session_scope');
    expect(mutate).toHaveBeenCalledTimes(6);
  });

  it('omits undeclared management methods', () => {
    const { adapter } = setup('opencode', [], null);
    expect(adapter.updateGlobalConfig).toBeUndefined();
    expect(adapter.listProviders).toBeUndefined();
  });
});

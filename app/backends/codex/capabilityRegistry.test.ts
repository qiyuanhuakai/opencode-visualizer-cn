import { describe, expect, it } from 'vitest';
import { CodexJsonRpcError } from './jsonRpcClient';
import { createCodexCapabilityRegistry } from './capabilityRegistry';

describe('Codex runtime capability registry', () => {
  it('distinguishes supported, unsupported, gated, and schema-unknown methods', async () => {
    const registry = createCodexCapabilityRegistry();

    await expect(registry.run('thread/goals/read', async () => ({ goals: [] }))).resolves.toEqual({
      goals: [],
    });
    await expect(
      registry.run('thread/items/list', async () => {
        throw new CodexJsonRpcError(-32601, 'not supported yet');
      }),
    ).rejects.toBeInstanceOf(CodexJsonRpcError);
    await expect(
      registry.run('thread/turns/list', async () => {
        throw new CodexJsonRpcError(-32600, 'experimentalApi capability is required');
      }),
    ).rejects.toBeInstanceOf(CodexJsonRpcError);
    await expect(
      registry.run('configRequirements/read', async () => {
        throw new CodexJsonRpcError(-32600, 'invalid params: missing cwd');
      }),
    ).rejects.toBeInstanceOf(CodexJsonRpcError);

    expect(registry.states.value).toMatchObject({
      'thread/goals/read': 'supported',
      'thread/items/list': 'unsupported',
      'thread/turns/list': 'gated',
      'configRequirements/read': 'unknown',
    });
  });

  it('drops observations from a previous connection generation', async () => {
    const registry = createCodexCapabilityRegistry();
    let resolveOld: ((value: { ok: true }) => void) | undefined;
    const oldRequest = registry.run(
      'account/usage/read',
      () => new Promise<{ ok: true }>((resolve) => (resolveOld = resolve)),
    );

    registry.reset();
    await registry.run('account/usage/read', async () => ({ ok: true }));
    resolveOld?.({ ok: true });
    await oldRequest;

    expect(registry.states.value['account/usage/read']).toBe('supported');
  });
});

import { ref } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const legacy = vi.hoisted(() => vi.fn(() => { throw new Error('Unexpected legacy adapter'); }));
vi.mock('../backends/registry', () => ({ getBackendAdapter: legacy }));
beforeEach(() => { vi.resetModules(); legacy.mockClear(); });

describe('runtime command binding after file-tree initialization', () => {
  it('uses the later runtime binding for an already-created command runner', async () => {
    const { usePtyOneshot } = await import('./usePtyOneshot');
    const options = { activeDirectory: ref('/remote/workspace'), activeBackendKind: ref<'opencode'>('opencode') };
    const early = usePtyOneshot(options);
    const runtimeCommand = vi.fn(async () => 'remote Git output');
    usePtyOneshot({ ...options, runtimeCommand });
    await expect(early.runOneShotPtyCommand('git', ['status', '--porcelain'])).resolves.toBe('remote Git output');
    expect(runtimeCommand).toHaveBeenCalledWith('git', ['status', '--porcelain']);
    expect(legacy).not.toHaveBeenCalled();
  });
  it('preserves a refused runtime scope without falling back to a native adapter', async () => {
    const { usePtyOneshot } = await import('./usePtyOneshot');
    const options = { activeDirectory: ref('/remote/workspace'), activeBackendKind: ref<'opencode'>('opencode') };
    const early = usePtyOneshot(options);
    usePtyOneshot({ ...options, runtimeCommand: async () => { throw new Error('Obsolete workspace scope'); } });
    await expect(early.runOneShotPtyCommand('git', ['status'])).rejects.toThrow('Obsolete workspace scope');
    expect(legacy).not.toHaveBeenCalled();
  });
});

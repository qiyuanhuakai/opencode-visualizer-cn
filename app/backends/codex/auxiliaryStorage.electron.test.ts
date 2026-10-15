import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

it('reads the newest local snapshot while native persistence is pending', async () => {
  let finish: (value: boolean) => void = () => {};
  const completion = new Promise<boolean>((resolve) => { finish = resolve; });
  const getItem = vi.fn(() => JSON.stringify({ text: 'durable' }));
  const setItem = vi.fn();
  const setItemAsync = vi.fn(() => completion);
  vi.stubGlobal('window', { electronAPI: { persistentStorage: { getItem, setItem, setItemAsync } } });
  const storage = await import('./auxiliaryStorage');
  storage.writeCodexAuxiliarySnapshot('thread', { text: 'latest' });
  expect(storage.readCodexAuxiliarySnapshot('thread')).toEqual({ text: 'latest' });
  storage.removeCodexAuxiliarySnapshot('thread');
  expect(storage.readCodexAuxiliarySnapshot('thread')).toBeNull();
  expect(setItem).not.toHaveBeenCalled();
  expect(getItem).not.toHaveBeenCalled();
  finish(true);
  await storage.flushCodexAuxiliaryStorage();
  expect(setItemAsync).toHaveBeenCalledTimes(2);
});

it('blocks source freeze until failed auxiliary writes are durably retried', async () => {
  const setItemAsync = vi.fn().mockResolvedValue(false);
  vi.stubGlobal('window', { electronAPI: { persistentStorage: { setItemAsync } } });
  const storage = await import('./auxiliaryStorage');
  const freeze = await import('../../runtime/migration/writerFreeze');
  const snapshot = { text: 'accepted-before-quota' };
  storage.writeCodexAuxiliarySnapshot('thread', snapshot);
  snapshot.text = 'mutated-after-admission';
  await expect(freeze.freezeLegacyWriters({ clientOrigin: 'test', persist: async () => {} })).rejects.toThrow();
  expect(freeze.legacyWriterPhase()).toBe('paused');
  expect(storage.readCodexAuxiliarySnapshot('thread')).toEqual({ text: 'accepted-before-quota' });
  await expect(freeze.retryFrozenLegacyWrites()).rejects.toThrow();
  setItemAsync.mockResolvedValue(true);
  await freeze.retryFrozenLegacyWrites();
  expect(freeze.legacyWriterPhase()).toBe('frozen');
  expect(setItemAsync.mock.calls.every(([, value]) => value === JSON.stringify({ text: 'accepted-before-quota' }))).toBe(true);
});

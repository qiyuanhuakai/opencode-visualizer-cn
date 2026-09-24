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

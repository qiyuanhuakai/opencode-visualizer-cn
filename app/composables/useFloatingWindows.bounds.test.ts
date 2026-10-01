import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupFloatingWindows, createDeferred, mountFloatingWindows } from './useFloatingWindows.test-helpers';

async function fill(api: ReturnType<typeof mountFloatingWindows>['api']) {
  for (let i = 0; i < 30; i++) await api.open(`window-${i}`, { expiry: Infinity });
}

afterEach(() => {
  cleanupFloatingWindows();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('floating window capacity and automatic admission', () => {
  it('evicts the oldest created entry at 31 even after focus and updates', async () => {
    const { api } = mountFloatingWindows();
    await fill(api);
    api.bringToFront('window-0');
    await api.open('window-0', { title: 'updated' });
    await api.open('window-30', { expiry: Infinity });
    expect(api.entries.value).toHaveLength(30);
    expect(api.has('window-0')).toBe(false);
    expect(api.has('window-1')).toBe(true);
  });

  it('reserves pending opens and evicts before async setup completes out of order', async () => {
    const { api } = mountFloatingWindows();
    const gates = Array.from({ length: 40 }, () => createDeferred<void>());
    const opens = gates.map((gate, i) => api.open(`pending-${i}`, {
      beforeOpen: () => gate.promise, expiry: Infinity,
    }));
    gates.toReversed().forEach(gate => gate.resolve());
    await Promise.all(opens);
    expect(api.entries.value).toHaveLength(30);
    expect(api.entries.value.map(entry => entry.key).sort()).toEqual(
      Array.from({ length: 30 }, (_, i) => `pending-${i + 10}`).sort(),
    );
  });

  it('discards hidden automatic candidates before setup or rendering but keeps manual and approvals', async () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    const { api } = mountFloatingWindows();
    const beforeOpen = vi.fn();
    const content = vi.fn(async () => 'rendered');
    await api.open('automatic', { autoOpen: true, beforeOpen, content });
    await api.open('manual', { expiry: Infinity });
    await api.open('permission:one', { autoOpen: true, expiry: Infinity });
    expect(beforeOpen).not.toHaveBeenCalled();
    expect(content).not.toHaveBeenCalled();
    expect(api.entries.value.map(entry => entry.key)).toEqual(['manual', 'permission:one']);
  });

  it('invalidates pending automatic setup across hide and show without a later replay', async () => {
    const { api } = mountFloatingWindows();
    const gate = createDeferred<void>();
    const content = vi.fn(async () => 'rendered');
    const opening = api.open('pending', { autoOpen: true, beforeOpen: () => gate.promise, content });
    api.setAutomaticOpenAllowed(false);
    api.setAutomaticOpenAllowed(true);
    gate.resolve();
    await opening;
    expect(api.has('pending')).toBe(false);
    expect(content).not.toHaveBeenCalled();
  });

  it('clears timer and rendering ownership immediately even with an unresolved close hook', async () => {
    vi.useFakeTimers();
    const { api } = mountFloatingWindows();
    const rendering = createDeferred<string>();
    const closeGate = createDeferred<void>();
    const afterClose = vi.fn();
    await api.open('old', { autoOpen: true, content: () => rendering.promise,
      beforeClose: () => closeGate.promise, afterClose, expiry: 100 });
    const old = api.get('old');
    api.setAutomaticOpenAllowed(false);
    expect(api.has('old')).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(afterClose).toHaveBeenCalledOnce();
    rendering.resolve('stale');
    await rendering.promise;
    expect(old?.resolvedHtml).not.toBe('stale');
    closeGate.resolve();
  });

  it('invalidates automatic render completion when document visibility changes', async () => {
    const { api } = mountFloatingWindows();
    const rendering = createDeferred<string>();
    await api.open('rendering', { autoOpen: true, content: () => rendering.promise });
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
    rendering.resolve('stale');
    await rendering.promise;
    expect(api.has('rendering')).toBe(false);
  });

  it('protects critical prompts when capacity is full', async () => {
    const { api } = mountFloatingWindows();
    for (let i = 0; i < 30; i++) await api.open(`permission:${i}`, { expiry: Infinity });
    await api.open('automatic', { autoOpen: true });
    expect(api.has('automatic')).toBe(false);
    await api.open('question:extra', { expiry: Infinity });
    expect(api.entries.value).toHaveLength(31);
    await api.open('elicitation:dialog', { expiry: Infinity });
    expect(api.entries.value).toHaveLength(32);
    await api.open('automatic-again', { autoOpen: true });
    expect(api.has('elicitation:dialog')).toBe(true);
    expect(api.has('automatic-again')).toBe(false);
  });
  it('keeps the original terminal deadline across repeated open and status updates', async () => {
    vi.useFakeTimers();
    const { api } = mountFloatingWindows();
    await api.open('tool', { status: 'running' });
    api.updateOptions('tool', { status: 'completed' });
    for (let i = 0; i < 3; i++) {
      vi.advanceTimersByTime(500);
      await api.open('tool', { status: 'completed', content: `final ${i}` });
      api.updateOptions('tool', { status: 'completed' });
      api.setStatus('tool', 'completed');
    }
    vi.advanceTimersByTime(501);
    expect(api.has('tool')).toBe(false);
  });

  it('preserves an explicit permanent terminal window across status updates', async () => {
    vi.useFakeTimers();
    const { api } = mountFloatingWindows();
    await api.open('manual-terminal', { status: 'completed', expiry: Infinity });
    api.updateOptions('manual-terminal', { status: 'completed' });
    api.setStatus('manual-terminal', 'completed');
    vi.advanceTimersByTime(10000);
    expect(api.has('manual-terminal')).toBe(true);
  });

});

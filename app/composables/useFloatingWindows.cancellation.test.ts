import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupFloatingWindows, createDeferred, mountFloatingWindows } from './useFloatingWindows.test-helpers';
import { startRenderWorkerHtml } from '../utils/workerRenderer';
import { RenderCancelledError } from '../utils/renderErrors';

vi.mock('../utils/workerRenderer', async () => ({
  ...await vi.importActual('../utils/workerRenderer'),
  startRenderWorkerHtml: vi.fn(),
}));

afterEach(() => {
  cleanupFloatingWindows();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function pendingRender() {
  const deferred = Promise.withResolvers<string>();
  const task = { promise: deferred.promise, cancel: vi.fn(() => deferred.reject(new RenderCancelledError())) };
  vi.mocked(startRenderWorkerHtml).mockReturnValue(task);
  return task;
}

describe('floating renderer disposal', () => {
  it('cancels evicted rendering and expiry before publishing the replacement', async () => {
    vi.useFakeTimers();
    const task = pendingRender();
    const { api } = mountFloatingWindows();
    const baselineTimers = vi.getTimerCount();
    await api.open('old', { content: 'code', lang: 'ts', expiry: 100 });
    for (let i = 0; i < 30; i++) await api.open(`new-${i}`, { expiry: Infinity });
    expect(task.cancel).toHaveBeenCalledOnce();
    expect(api.has('old')).toBe(false);
    expect(api.entries.value).toHaveLength(30);
    expect(vi.getTimerCount()).toBe(baselineTimers);
  });

  it('cancels renderer tasks on suppression and unmount', async () => {
    const task = pendingRender();
    const { api, unmount } = mountFloatingWindows();
    await api.open('auto', { autoOpen: true, content: 'code', lang: 'ts' });
    api.setAutomaticOpenAllowed(false);
    expect(task.cancel).toHaveBeenCalledOnce();
    const manualTask = pendingRender();
    await api.open('manual', { content: 'manual', lang: 'ts' });
    unmount();
    expect(manualTask.cancel).toHaveBeenCalledOnce();
    expect(api.entries.value).toEqual([]);
  });

  it('rechecks hidden state on render completion before the visibility event arrives', async () => {
    const { api } = mountFloatingWindows();
    const render = createDeferred<string>();
    await api.open('auto', { autoOpen: true, content: () => render.promise });
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    render.resolve('stale');
    await render.promise;
    expect(api.has('auto')).toBe(false);
  });

  it('clears a previous expiry when a window becomes permanent', async () => {
    vi.useFakeTimers();
    const { api } = mountFloatingWindows();
    await api.open('kept', { expiry: 10 });
    await api.open('kept', { expiry: Infinity });
    vi.advanceTimersByTime(20);
    expect(api.has('kept')).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

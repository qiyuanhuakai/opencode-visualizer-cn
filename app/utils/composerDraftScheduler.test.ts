import { afterEach, describe, expect, it, vi } from 'vitest';

import { createComposerDraftScheduler } from './composerDraftScheduler';

describe('composerDraftScheduler', () => {
  afterEach(() => vi.useRealTimers());

  it('coalesces a typing burst into one trailing persistence task', () => {
    // Given: a composer persistence scheduler uses the interactive debounce interval.
    vi.useFakeTimers();
    const persist = vi.fn();
    const scheduler = createComposerDraftScheduler(persist, 150);

    // When: one hundred input updates arrive before the trailing interval expires.
    for (let index = 0; index < 100; index += 1) scheduler.schedule();
    vi.advanceTimersByTime(149);

    // Then: no synchronous writes occur and exactly one latest-state write follows.
    expect(persist).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('flushes pending input once before a lifecycle boundary', () => {
    // Given: one composer update is waiting for its trailing persistence task.
    vi.useFakeTimers();
    const persist = vi.fn();
    const scheduler = createComposerDraftScheduler(persist, 150);
    scheduler.schedule();

    // When: a context or unmount boundary flushes the pending update.
    scheduler.flush();
    vi.advanceTimersByTime(150);

    // Then: the draft is persisted immediately without a later duplicate write.
    expect(persist).toHaveBeenCalledTimes(1);
  });

  it('flushes the task captured before a context change', () => {
    vi.useFakeTimers();
    const persist = vi.fn();
    const scheduler = createComposerDraftScheduler(persist, 150);
    const previousContextTask = vi.fn();

    scheduler.schedule(previousContextTask);
    scheduler.flush();
    vi.advanceTimersByTime(150);

    expect(previousContextTask).toHaveBeenCalledTimes(1);
    expect(persist).not.toHaveBeenCalled();
  });
});

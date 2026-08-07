import { nextTick, ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { useLiveDescendantHistoryHydration } from './useLiveDescendantHistoryHydration';

describe('useLiveDescendantHistoryHydration', () => {
  it('hydrates a child as soon as session.created adds it to the selected root', async () => {
    const activeBackendKind = ref<'opencode' | 'codex' | 'acp'>('opencode');
    const selectedSessionId = ref('root');
    const allowedSessionIds = ref<ReadonlySet<string>>(new Set(['root']));
    const hydrate = vi.fn(async () => true);

    useLiveDescendantHistoryHydration({
      activeBackendKind,
      selectedSessionId,
      allowedSessionIds,
      hydrate,
    });
    allowedSessionIds.value = new Set(['root', 'child']);
    await nextTick();

    expect(hydrate).toHaveBeenCalledWith('root', ['child']);
  });

  it('does not rehydrate an unchanged child or hydrate a non-OpenCode backend', async () => {
    const activeBackendKind = ref<'opencode' | 'codex' | 'acp'>('opencode');
    const selectedSessionId = ref('root');
    const allowedSessionIds = ref<ReadonlySet<string>>(new Set(['root', 'child']));
    const hydrate = vi.fn(async () => true);

    useLiveDescendantHistoryHydration({
      activeBackendKind,
      selectedSessionId,
      allowedSessionIds,
      hydrate,
    });
    await nextTick();
    allowedSessionIds.value = new Set(['root', 'child']);
    await nextTick();
    activeBackendKind.value = 'codex';
    allowedSessionIds.value = new Set(['root', 'child', 'codex-child']);
    await nextTick();

    expect(hydrate).toHaveBeenCalledTimes(1);
    expect(hydrate).toHaveBeenCalledWith('root', ['child']);
  });

  it('retries descendants when hydration reports failure', async () => {
    vi.useFakeTimers();
    const activeBackendKind = ref<'opencode' | 'codex' | 'acp'>('opencode');
    const selectedSessionId = ref('root');
    const allowedSessionIds = ref<ReadonlySet<string>>(new Set(['root', 'child']));
    const hydrate = vi.fn().mockResolvedValue(false);

    useLiveDescendantHistoryHydration({
      activeBackendKind,
      selectedSessionId,
      allowedSessionIds,
      hydrate,
    });
    await nextTick();
    await vi.advanceTimersByTimeAsync(250);

    expect(hydrate).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it('keeps exhausted descendants terminal until the session scope changes', async () => {
    vi.useFakeTimers();
    const activeBackendKind = ref<'opencode' | 'codex' | 'acp'>('opencode');
    const selectedSessionId = ref('root');
    const allowedSessionIds = ref<ReadonlySet<string>>(new Set(['root', 'child']));
    const hydrate = vi.fn().mockResolvedValue(false);

    useLiveDescendantHistoryHydration({
      activeBackendKind,
      selectedSessionId,
      allowedSessionIds,
      hydrate,
    });
    await nextTick();
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await vi.runOnlyPendingTimersAsync();
      await nextTick();
    }
    expect(hydrate).toHaveBeenCalledTimes(4);

    allowedSessionIds.value = new Set(['root', 'child', 'other-child']);
    await nextTick();
    expect(hydrate).toHaveBeenCalledTimes(5);

    selectedSessionId.value = 'other-root';
    allowedSessionIds.value = new Set(['other-root', 'child']);
    await nextTick();
    expect(hydrate).toHaveBeenCalledTimes(6);
    vi.useRealTimers();
  });
});

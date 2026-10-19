import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountHistoryApp } from './test/appHarness';
import { parseSessionRef } from '../shared/runtime/identity.js';
import type { EnvironmentId, HarnessInstanceId } from '../shared/runtime/identity.js';
import type { RuntimeThreadState } from './composables/useRuntimeThread';

const mountedApps: Array<{ readonly unmount: () => void }> = [];

afterEach(() => {
  mountedApps.splice(0).forEach(({ unmount }) => unmount());
});

function historyEntry(id: string, text: string) {
  return {
    info: {
      id,
      sessionID: 'session-a',
      role: 'user',
      agent: 'build',
      model: { providerID: 'provider-a', modelID: 'model-a' },
      time: { created: 101 },
    },
    parts: [
      {
        id: `part-${id}`,
        messageID: id,
        sessionID: 'session-a',
        type: 'text',
        text,
      },
    ],
  };
}

async function selectSessionA(fixture: { host: HTMLElement }) {
  const picker = fixture.host.querySelector('.top-panel .ui-dropdown-button');
  expect(picker).toBeInstanceOf(HTMLButtonElement);
  picker?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await vi.waitFor(() => {
    const session = Array.from(fixture.host.querySelectorAll('.ui-dropdown-item')).find((item) =>
      item.textContent?.includes('Session A'),
    );
    if (!session) throw new Error('Session A did not appear in the picker');
    session.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('App is the real container of the Host Thread surface', () => {
  it('provides the thread state, so the thread surface can render in the running app', async () => {
    const fixture = await mountHistoryApp([historyEntry('message-1', 'first')]);
    mountedApps.push(fixture);
    await selectSessionA(fixture);

    // The seam the review found open: `useRuntimeThreadState()` answered null in
    // the real app, so OutputPanel's ThreadPanel was never mounted there.
    const threadState = fixture.readSetupBinding('threadState');
    expect(threadState).toBeTruthy();
    expect(typeof (threadState as { openThread?: unknown }).openThread).toBe('function');
  });

  it('binds @refresh-native-history on OutputPanel, so the event is not dropped', async () => {
    const fixture = await mountHistoryApp([historyEntry('message-1', 'first')]);
    mountedApps.push(fixture);
    await selectSessionA(fixture);

    const outputPanel = fixture.host.querySelector('.output-panel');
    expect(outputPanel).not.toBeNull();
    const listeners = (outputPanel as unknown as { __vnode?: { props?: Record<string, unknown> } }).__vnode?.props;
    expect(listeners).toBeTruthy();
    expect(typeof listeners?.onRefreshNativeHistory).toBe('function');
  });

  it('Refresh re-reads the located participant\'s OWN native history and backfills the panel', async () => {
    const fixture = await mountHistoryApp([historyEntry('message-1', 'first-read-entry')]);
    mountedApps.push(fixture);
    await selectSessionA(fixture);

    // When: the user opens the Host Thread for the selected session.
    const toggle = fixture.host.querySelector<HTMLElement>('[data-testid="host-thread-toggle"]');
    expect(toggle).not.toBeNull();
    toggle?.click();
    await vi.waitFor(() => {
      expect(fixture.host.querySelector('[data-testid="thread-view"]')).not.toBeNull();
    });
    await vi.waitFor(() => {
      expect(fixture.host.querySelector('[data-testid="native-history"]')).not.toBeNull();
    });

    // Then: the container produced a first read through the REAL backend.
    expect(fixture.listSessionMessages).toHaveBeenCalledWith('session-a', { directory: '/repo' });
    await vi.waitFor(() => {
      expect(fixture.host.querySelector('[data-testid="native-history-entry"]')?.textContent?.trim()).toBe(
        'first-read-entry',
      );
    });

    // And: the group names the participant's OWN native session, never a merged one.
    expect(
      fixture.host.querySelector('[data-testid="native-history-session"]')?.textContent?.trim(),
    ).toBe('session-a');

    // When: the backend's history changes and the user clicks Refresh.
    fixture.listSessionMessages.mockResolvedValue([historyEntry('message-2', 'reloaded-entry')]);
    fixture.host.querySelector<HTMLElement>('[data-testid="browse-native-history"]')?.click();

    // Then: the panel shows the RE-READ bytes, not the first read.
    await vi.waitFor(() => {
      expect(fixture.host.querySelector('[data-testid="native-history-entry"]')?.textContent?.trim()).toBe(
        'reloaded-entry',
      );
    });
  });
});

describe('App reads each participant history against its OWN target identity, in its OWN thread generation', () => {
  it('refuses to read a participant whose session belongs to another target, and says so', async () => {
    // A participant whose session is NOT one the active target holds has no readable backend in
    // THIS browser: reading through the ambient one would relabel another target's bytes as this
    // participant, or swallow the mismatch as an empty history.
    const fixture = await mountHistoryApp([historyEntry('message-1', 'first-read-entry')]);
    mountedApps.push(fixture);
    await selectSessionA(fixture);

    const toggle = fixture.host.querySelector<HTMLElement>('[data-testid="host-thread-toggle"]');
    toggle?.click();
    await vi.waitFor(() => {
      expect(fixture.host.querySelector('[data-testid="native-history"]')).not.toBeNull();
    });
    expect(fixture.listSessionMessages).toHaveBeenCalledWith('session-a', { directory: '/repo' });

    const threadState = fixture.readSetupBinding('threadState') as RuntimeThreadState;
    const ownerParticipant = threadState.summary.value?.participants[0];
    const owner = ownerParticipant?.session;
    if (owner === undefined || ownerParticipant === undefined) {
      throw new Error('the opened thread has no owner participant');
    }
    // The SAME participant, but its session now resolves to the OTHER harness instance of the
    // same environment — the state a target switch leaves behind. The container half is driven
    // through the REAL OutputPanel event binding, not a surrogate.
    const outputPanel = fixture.host.querySelector('.output-panel') as unknown as {
      __vnode?: { props?: Record<string, unknown> };
    };
    const refresh = outputPanel?.__vnode?.props?.onRefreshNativeHistory as
      | ((payload: { participantId: string; session: unknown }) => void)
      | undefined;
    expect(typeof refresh).toBe('function');
    fixture.listSessionMessages.mockClear();
    refresh?.({
      participantId: ownerParticipant.participantId,
      session: parseSessionRef({
        environmentId: owner.environmentId,
        harnessInstanceId: '20000000-0000-4000-8000-000000000009' as HarnessInstanceId,
        nativeSessionId: 'session-foreign',
      }),
    });

    // The read is refused for the foreign identity rather than served from the ambient backend,
    // and the refusal is stated explicitly instead of rendered as an empty history.
    await vi.waitFor(() => {
      expect(fixture.host.querySelector('[data-testid="native-history-unavailable"]')).not.toBeNull();
    });
    expect(fixture.listSessionMessages).not.toHaveBeenCalled();
    const unavailable = fixture.host.querySelector('[data-testid="native-history-unavailable"]');
    expect(unavailable?.textContent?.trim()).toContain('unavailable');
    expect(unavailable?.getAttribute('data-participant-id')).toBe(ownerParticipant.participantId);
    // The previously rendered entries are replaced by the honest unavailable statement.
    expect(fixture.host.querySelector('[data-testid="native-history-entry"]')).toBeNull();
  });

  it('never backfills a history read that was in flight when the thread was closed and reopened', async () => {
    // Closing clears the array, but a read already in flight is not stopped by that: it must be
    // invalidated by the thread generation it was issued under, or its bytes land in the NEW
    // thread's group under the old participant's label.
    const fixture = await mountHistoryApp([historyEntry('message-1', 'first-read-entry')]);
    mountedApps.push(fixture);
    await selectSessionA(fixture);
    const toggle = fixture.host.querySelector<HTMLElement>('[data-testid="host-thread-toggle"]');
    toggle?.click();
    await vi.waitFor(() => {
      expect(fixture.host.querySelector('[data-testid="native-history"]')).not.toBeNull();
    });

    // Close, then reopen: the reopened thread's OWN first read is the one that hangs.
    toggle?.click();
    await vi.waitFor(() => {
      expect(fixture.host.querySelector('[data-testid="thread-view"]')).toBeNull();
    });
    let releaseAbandonedRead: (() => void) | undefined;
    fixture.listSessionMessages.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseAbandonedRead = () => resolve([historyEntry('message-2', 'abandoned-entry')]);
      }),
    );
    toggle?.click();
    await vi.waitFor(() => {
      expect(fixture.host.querySelector('[data-testid="thread-view"]')).not.toBeNull();
    });

    // While that read is still in flight, close again and open a THIRD thread whose own first
    // read completes normally.
    toggle?.click();
    await vi.waitFor(() => {
      expect(fixture.host.querySelector('[data-testid="thread-view"]')).toBeNull();
    });
    fixture.listSessionMessages.mockResolvedValue([historyEntry('message-3', 'new-entry')]);
    toggle?.click();
    await vi.waitFor(() => {
      expect(fixture.host.querySelector('[data-testid="native-history-entry"]')?.textContent?.trim()).toBe(
        'new-entry',
      );
    });

    // The abandoned read completes now: its bytes belong to a thread that no longer exists and
    // must be dropped rather than backfilled into the current one.
    releaseAbandonedRead?.();
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    await vi.waitFor(() => {
      const entries = Array.from(fixture.host.querySelectorAll('[data-testid="native-history-entry"]'));
      expect(entries.map((entry) => entry.textContent?.trim())).toEqual(['new-entry']);
    });
  });

  it('never lets an older Refresh overwrite a newer one', async () => {
    // Two Refreshes for the same participant, the older one completing last: only the newest
    // request may write, or a stale result overwrites the current one.
    const fixture = await mountHistoryApp([historyEntry('message-1', 'first-read-entry')]);
    mountedApps.push(fixture);
    await selectSessionA(fixture);
    const toggle = fixture.host.querySelector<HTMLElement>('[data-testid="host-thread-toggle"]');
    toggle?.click();
    await vi.waitFor(() => {
      expect(fixture.host.querySelector('[data-testid="native-history-entry"]')?.textContent?.trim()).toBe(
        'first-read-entry',
      );
    });
    // Count the Refresh reads from here on; the first read above is not one of them.
    fixture.listSessionMessages.mockClear();

    let releaseFirstRefresh: (() => void) | undefined;
    fixture.listSessionMessages.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseFirstRefresh = () => resolve([historyEntry('message-2', 'stale-entry')]);
      }),
    );
    fixture.host.querySelector<HTMLElement>('[data-testid="browse-native-history"]')?.click();
    await vi.waitFor(() => {
      expect(fixture.listSessionMessages).toHaveBeenCalledTimes(1);
    });

    // A second Refresh is issued while the first is still in flight, and it completes first.
    fixture.listSessionMessages.mockResolvedValue([historyEntry('message-3', 'fresh-entry')]);
    fixture.host.querySelector<HTMLElement>('[data-testid="browse-native-history"]')?.click();
    await vi.waitFor(() => {
      expect(fixture.host.querySelector('[data-testid="native-history-entry"]')?.textContent?.trim()).toBe(
        'fresh-entry',
      );
    });
    expect(fixture.listSessionMessages).toHaveBeenCalledTimes(2);

    // The older Refresh completes now and must not overwrite the newer result.
    releaseFirstRefresh?.();
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    await vi.waitFor(() => {
      const entries = Array.from(fixture.host.querySelectorAll('[data-testid="native-history-entry"]'));
      expect(entries.map((entry) => entry.textContent?.trim())).toEqual(['fresh-entry']);
    });
  });
});

describe('App drives the real session tree from Locate, and back', () => {
  async function openThreadWithTwoParticipants(fixture: { host: HTMLElement; readSetupBinding: (name: string) => unknown }) {
    const toggle = fixture.host.querySelector<HTMLElement>('[data-testid="host-thread-toggle"]');
    toggle?.click();
    await vi.waitFor(() => {
      expect(fixture.host.querySelector('[data-testid="thread-view"]')).not.toBeNull();
    });
    const threadState = fixture.readSetupBinding('threadState') as RuntimeThreadState;
    const joined = parseSessionRef({
      environmentId: threadState.summary.value?.participants[0]?.session.environmentId as EnvironmentId,
      harnessInstanceId: threadState.summary.value?.participants[0]?.session.harnessInstanceId as HarnessInstanceId,
      nativeSessionId: 'session-b',
    });
    await threadState.joinThread(joined);
    return threadState;
  }

  it('Locate moves the REAL session tree selection, not only a local ref', async () => {
    // The composable wrote selectedSession and nothing consumed it, so clicking Locate left
    // the real tree, the output session and the composer exactly where they were.
    const fixture = await mountHistoryApp([historyEntry('message-1', 'first-read-entry')]);
    mountedApps.push(fixture);
    await selectSessionA(fixture);
    const threadState = await openThreadWithTwoParticipants(fixture);

    const located = Array.from(
      fixture.host.querySelectorAll<HTMLElement>('[data-testid="locate-session"]'),
    ).find((button) => button.getAttribute('data-participant-id') !== threadState.summary.value?.participants[0]?.participantId);
    expect(located).toBeDefined();
    located?.click();

    // The real App's selection moves to the located participant's own native session.
    await vi.waitFor(() => {
      expect(fixture.readSetupBinding('selectedSessionId')).toBe('session-b');
    });
    // And the thread surface's locate state agrees with the tree.
    await vi.waitFor(() => {
      expect(threadState.selectedSession.value?.nativeSessionId).toBe('session-b');
    });
  });

  it('the real tree selection drives the thread locate state back', async () => {
    // Reverse sync: selecting a participant's session in the tree writes the thread's located
    // session, so the surface follows the tree exactly as the tree follows Locate.
    const fixture = await mountHistoryApp([historyEntry('message-1', 'first-read-entry')]);
    mountedApps.push(fixture);
    await selectSessionA(fixture);
    const threadState = await openThreadWithTwoParticipants(fixture);

    await vi.waitFor(() => {
      expect(fixture.readSetupBinding('selectedSessionId')).toBe('session-a');
    });

    // Select the OTHER participant's session through the real picker.
    await fixture.host.querySelector<HTMLElement>('.top-panel .ui-dropdown-button')?.dispatchEvent(
      new MouseEvent('click', { bubbles: true }),
    );
    await vi.waitFor(() => {
      const session = Array.from(fixture.host.querySelectorAll('.top-panel .ui-dropdown-item')).find((item) =>
        item.textContent?.includes('Session B'),
      );
      if (!session) throw new Error('Session B did not appear in the picker');
      session.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await vi.waitFor(() => {
      expect(fixture.readSetupBinding('selectedSessionId')).toBe('session-b');
    });
    await vi.waitFor(() => {
      expect(threadState.selectedSession.value?.nativeSessionId).toBe('session-b');
    });
  });

  it('a locate of a session the thread does not hold moves nothing', async () => {
    // A locate can never point the real tree at a session no participant owns.
    const fixture = await mountHistoryApp([historyEntry('message-1', 'first-read-entry')]);
    mountedApps.push(fixture);
    await selectSessionA(fixture);
    const threadState = await openThreadWithTwoParticipants(fixture);

    threadState.locateSession(parseSessionRef({
      environmentId: threadState.summary.value?.participants[0]?.session.environmentId as EnvironmentId,
      harnessInstanceId: threadState.summary.value?.participants[0]?.session.harnessInstanceId as HarnessInstanceId,
      nativeSessionId: 'session-unrelated',
    }));

    expect(threadState.locateSession(parseSessionRef({
      environmentId: threadState.summary.value?.participants[0]?.session.environmentId as EnvironmentId,
      harnessInstanceId: threadState.summary.value?.participants[0]?.session.harnessInstanceId as HarnessInstanceId,
      nativeSessionId: 'session-unrelated',
    }))).toBeNull();
    await vi.waitFor(() => {
      expect(fixture.readSetupBinding('selectedSessionId')).toBe('session-a');
    });
  });
});

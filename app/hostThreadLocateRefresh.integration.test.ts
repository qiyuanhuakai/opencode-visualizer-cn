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

/**
 * Let a locate's full async consequence land before the tree is asserted on. The
 * selection switch is a chain of watcher flushes and awaited state waits, so the
 * assertion must observe the SETTLED tree — otherwise a locate that moves nothing
 * could pass merely because the move has not happened yet.
 */
async function settleSelection() {
  for (let index = 0; index < 5; index += 1) {
    await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
  }
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

  it('a locate of a REAL session the current tree holds but the thread does not moves nothing', async () => {
    // The non-member test above locates a session id no project holds, so it passes
    // because the tree cannot resolve it — it never proved the membership guard. Here
    // the session REALLY EXISTS in the current tree: locating it must still move
    // nothing, because no participant of the open thread owns it. Locate is not a
    // generic "select any session" action; it follows a participant.
    const fixture = await mountHistoryApp([historyEntry('message-1', 'first-read-entry')], { otherDirectory: true });
    mountedApps.push(fixture);
    await selectSessionA(fixture);
    const threadState = await openThreadWithTwoParticipants(fixture);

    const owner = threadState.summary.value?.participants[0]?.session;
    if (owner === undefined) throw new Error('the opened thread has no owner participant');
    const located = threadState.locateSession(parseSessionRef({
      environmentId: owner.environmentId,
      harnessInstanceId: owner.harnessInstanceId,
      nativeSessionId: 'session-other',
    }));

    // The locate resolves to nothing for the current thread, and it must not have been
    // written into the selection either: the container's watcher moves the real tree on
    // whatever selectedSession holds, native id alone.
    expect(located).toBeNull();
    expect(threadState.selectedSession.value).toBeNull();
    await settleSelection();
    expect(fixture.readSetupBinding('selectedSessionId')).toBe('session-a');
  });

  it('a locate of a same-named session of ANOTHER environment moves nothing', async () => {
    // The thread keeps a participant qualified under environment A; the tree is showing
    // environment B, and B's tree happens to contain another session with the SAME
    // nativeSessionId. The watcher used to read the native id alone and call
    // switchSessionSelection against B's CURRENT project — it selected B's same-named
    // session instead of switching to A or refusing.
    const fixture = await mountHistoryApp([historyEntry('message-1', 'first-read-entry')], { otherDirectory: true });
    mountedApps.push(fixture);
    await selectSessionA(fixture);
    const threadState = await openThreadWithTwoParticipants(fixture);

    // The tree sits on a DIFFERENT session, so the locate cannot hide behind the
    // same-id early exit.
    await fixture.selectOtherDirectorySession?.();
    await vi.waitFor(() => {
      expect(fixture.readSetupBinding('selectedSessionId')).toBe('session-other');
    });

    const owner = threadState.summary.value?.participants[0]?.session;
    if (owner === undefined) throw new Error('the opened thread has no owner participant');
    const located = threadState.locateSession(parseSessionRef({
      environmentId: '30000000-0000-4000-8000-000000000001' as EnvironmentId,
      harnessInstanceId: owner.harnessInstanceId,
      nativeSessionId: 'session-a',
    }));

    expect(located).toBeNull();
    expect(threadState.selectedSession.value).toBeNull();
    await settleSelection();
    // The same-named session of the CURRENT target is a different session that merely
    // shares a name: the tree stays where the user left it.
    expect(fixture.readSetupBinding('selectedSessionId')).toBe('session-other');
  });

  it('a locate of a thread participant after the active target switched moves nothing', async () => {
    // The participant's frozen ref is qualified under the environment the thread was
    // bound in. After the user switches the active target it STILL resolves as a member
    // of the thread — only the container can see that its environment is no longer the
    // active one, and must refuse to select the new tree's same-named session.
    const fixture = await mountHistoryApp([historyEntry('message-1', 'first-read-entry')], { otherDirectory: true });
    mountedApps.push(fixture);
    await selectSessionA(fixture);
    const threadState = await openThreadWithTwoParticipants(fixture);

    await fixture.selectOtherDirectorySession?.();
    await vi.waitFor(() => {
      expect(fixture.readSetupBinding('selectedSessionId')).toBe('session-other');
    });

    const owner = threadState.summary.value?.participants[0]?.session;
    if (owner === undefined) throw new Error('the opened thread has no owner participant');
    // A real target switch: the environment identity is derived from the active bridge
    // target, so re-pointing the stored server URL moves the active environment while
    // the session tree — and the thread's participants — stay exactly where they were.
    fixture.setStoredServerUrl('http://127.0.0.1:4096/harness-other-environment');
    await vi.waitFor(() => {
      expect(fixture.readSetupBinding('activeRuntimeEnvironmentId')).not.toBe(owner.environmentId);
    });

    // The participant is still a member of the open thread, so the composable answers
    // the resolution and writes the selection...
    const located = threadState.locateSession(owner);
    expect(located?.participantId).toBe(threadState.summary.value?.participants[0]?.participantId);
    expect(threadState.selectedSession.value?.nativeSessionId).toBe('session-a');

    await settleSelection();
    // ...and the container refuses the cross-target locate: this tree cannot represent
    // the participant's session, and selecting its native id here would land on the new
    // target's same-named session.
    expect(fixture.readSetupBinding('selectedSessionId')).toBe('session-other');
  });
});

describe('App reads a participant against the directory of its OWN sandbox, not the ambient one', () => {
  async function openThreadOnSessionA(fixture: { host: HTMLElement; listSessionMessages: { mockResolvedValue: (value: unknown) => void } }) {
    await selectSessionA(fixture);
    const toggle = fixture.host.querySelector<HTMLElement>('[data-testid="host-thread-toggle"]');
    toggle?.click();
    await vi.waitFor(() => {
      expect(fixture.host.querySelector('[data-testid="native-history-entry"]')?.textContent?.trim()).toBe(
        'first-read-entry',
      );
    });
    expect(fixture.listSessionMessages).toHaveBeenCalledWith('session-a', { directory: '/repo' });
  }

  it('refreshes an old participant against its OWN directory after the ambient directory moved', async () => {
    // The participant owns session-a in the /repo sandbox. The user then switches the
    // ambient directory to the OTHER sandbox of the SAME target and refreshes that
    // participant: the ACP loader uses the caller's directory as the cwd of
    // session/load and session/resume, overriding the session's own, so the ambient
    // directory must never be handed over for a session that lives elsewhere.
    const fixture = await mountHistoryApp([historyEntry('message-1', 'first-read-entry')], { otherDirectory: true });
    mountedApps.push(fixture);
    await openThreadOnSessionA(fixture);

    await fixture.selectOtherDirectorySession?.();
    await vi.waitFor(() => {
      expect(fixture.readSetupBinding('selectedSessionId')).toBe('session-other');
    });
    // The ambient selection loads THAT session's own history through the same backend
    // method; let it land before the participant's OWN re-read is issued, so the read
    // under test is not confused with the ambient one.
    await vi.waitFor(() => {
      expect(fixture.listSessionMessages).toHaveBeenCalledWith('session-other', { directory: '/other-project' });
    });

    fixture.listSessionMessages.mockClear();
    fixture.listSessionMessages.mockResolvedValue([historyEntry('message-2', 'reloaded-entry')]);
    // The output panel is keyed by the selected session, so the tree move remounted it:
    // the thread surface is an async component and re-renders a beat later.
    const browse = await vi.waitFor(() => {
      const button = fixture.host.querySelector<HTMLElement>('[data-testid="browse-native-history"]');
      if (button === null) throw new Error('the browse button did not come back with the remounted panel');
      return button;
    });
    browse.click();

    // The re-read lands in the participant's OWN group...
    await vi.waitFor(() => {
      expect(fixture.host.querySelector('[data-testid="native-history-entry"]')?.textContent?.trim()).toBe(
        'reloaded-entry',
      );
    });
    // ...and it carried the participant's OWN directory, never the ambient one: the
    // ACP loader would resume the session in the workspace the user happened to select.
    expect(fixture.listSessionMessages).toHaveBeenCalledWith('session-a', { directory: '/repo' });
    expect(fixture.listSessionMessages).not.toHaveBeenCalledWith('session-a', { directory: '/other-project' });
  });

  it('first-reads a participant that joins after the ambient directory moved against its OWN directory', async () => {
    // Same target, same harness, different workspace: the not-yet-loaded participant is
    // read the moment it joins, and that read must carry the participant's OWN directory.
    const fixture = await mountHistoryApp([historyEntry('message-1', 'first-read-entry')], { otherDirectory: true });
    mountedApps.push(fixture);
    await openThreadOnSessionA(fixture);

    await fixture.selectOtherDirectorySession?.();
    await vi.waitFor(() => {
      expect(fixture.readSetupBinding('selectedSessionId')).toBe('session-other');
    });

    const threadState = fixture.readSetupBinding('threadState') as RuntimeThreadState;
    const owner = threadState.summary.value?.participants[0]?.session;
    if (owner === undefined) throw new Error('the opened thread has no owner participant');
    await threadState.joinThread(parseSessionRef({
      environmentId: owner.environmentId,
      harnessInstanceId: owner.harnessInstanceId,
      nativeSessionId: 'session-b',
    }));

    await vi.waitFor(() => {
      expect(fixture.listSessionMessages).toHaveBeenCalledWith('session-b', { directory: '/repo' });
    });
  });

  it('marks a participant whose session the tree no longer holds unavailable instead of reading it ambiently', async () => {
    // A participant whose session is no longer in the active target's tree has no OWN
    // directory to read against — a session deleted server-side while the thread is
    // open, say. Substituting the ambient one is the very override above, so the honest
    // answer is an explicit unavailable group rather than a read in the wrong workspace.
    const fixture = await mountHistoryApp([historyEntry('message-1', 'first-read-entry')], { otherDirectory: true });
    mountedApps.push(fixture);
    await openThreadOnSessionA(fixture);

    const threadState = fixture.readSetupBinding('threadState') as RuntimeThreadState;
    const ownerParticipant = threadState.summary.value?.participants[0];
    const owner = ownerParticipant?.session;
    if (owner === undefined || ownerParticipant === undefined) {
      throw new Error('the opened thread has no owner participant');
    }
    const outputPanel = fixture.host.querySelector('.output-panel') as unknown as {
      __vnode?: { props?: Record<string, unknown> };
    };
    const refresh = outputPanel?.__vnode?.props?.onRefreshNativeHistory as
      | ((payload: { participantId: string; session: unknown }) => void)
      | undefined;
    expect(typeof refresh).toBe('function');

    await fixture.selectOtherDirectorySession?.();
    await vi.waitFor(() => {
      expect(fixture.readSetupBinding('selectedSessionId')).toBe('session-other');
    });
    fixture.listSessionMessages.mockClear();
    refresh?.({
      participantId: ownerParticipant.participantId,
      session: parseSessionRef({
        environmentId: owner.environmentId,
        harnessInstanceId: owner.harnessInstanceId,
        nativeSessionId: 'session-vanished',
      }),
    });

    await vi.waitFor(() => {
      expect(fixture.host.querySelector('[data-testid="native-history-unavailable"]')).not.toBeNull();
    });
    expect(fixture.listSessionMessages).not.toHaveBeenCalled();
    const unavailable = fixture.host.querySelector('[data-testid="native-history-unavailable"]');
    expect(unavailable?.textContent?.trim()).toContain('unavailable');
    expect(unavailable?.getAttribute('data-participant-id')).toBe(ownerParticipant.participantId);
  });
});

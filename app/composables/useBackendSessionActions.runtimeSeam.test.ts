import { describe, expect, it, vi } from 'vitest';
import { parseConnectionProfileId, parseSessionRef } from '../../shared/runtime/identity.js';
import type { ConnectionProfileId, EnvironmentId, HarnessInstanceId, SessionRef } from '../../shared/runtime/identity.js';
import { createSessionActionsFixture } from './useBackendSessionActions.test-helpers';
import type { RuntimeSessionRouter, RuntimeSessionRuntime } from './useRuntimeSessionActions';

const PROFILE: ConnectionProfileId = parseConnectionProfileId('33333333-3333-4333-8333-333333333333');
const ENV: EnvironmentId = '11111111-1111-4111-8111-111111111111' as EnvironmentId;
const HARNESS: HarnessInstanceId = '10000000-0000-4000-8000-000000000001' as HarnessInstanceId;
const SESSION: SessionRef = parseSessionRef({ environmentId: ENV, harnessInstanceId: HARNESS, nativeSessionId: 'native-1' });

function makeRouter() {
  return {
    sendMessage: vi.fn(), cancel: vi.fn(), fork: vi.fn(), rename: vi.fn(),
    archive: vi.fn(), unarchive: vi.fn(), delete: vi.fn(), compact: vi.fn(),
    revert: vi.fn(), todos: vi.fn(), tokenMonitor: vi.fn(), history: vi.fn(), respond: vi.fn(),
  } satisfies Record<keyof RuntimeSessionRouter, ReturnType<typeof vi.fn>>;
}
function makeRuntime(router: ReturnType<typeof makeRouter>): RuntimeSessionRuntime {
  return { binding: () => ({ profileId: PROFILE, session: SESSION }), router: router as unknown as RuntimeSessionRouter };
}
/** A mutable selection whose bound session can change under the composable's feet. */
function mutableRuntime(
  router: ReturnType<typeof makeRouter>,
  initial: SessionRef = SESSION,
): { runtime: RuntimeSessionRuntime; select: (session: SessionRef) => void } {
  let current = initial;
  return {
    runtime: {
      binding: () => ({ profileId: PROFILE, session: current }),
      router: router as unknown as RuntimeSessionRouter,
    },
    select: (session: SessionRef) => { current = session; },
  };
}

describe('legacy useBackendSessionActions seam delegates by full SessionRef', () => {
  it('starts a runtime rename dialog with the qualified human session title', async () => {
    const router = makeRouter(), showPrompt = vi.fn(async () => null);
    const { actions } = createSessionActionsFixture({ runtime: { ...makeRuntime(router), title: () => 'Human native title' }, showPrompt });
    await actions.renameSession(SESSION.nativeSessionId);
    expect(showPrompt).toHaveBeenCalledWith('topPanel.sessionActions.rename', 'Human native title');
    expect(router.rename).not.toHaveBeenCalled();
  });
  it('does not delete a runtime session when confirmation is declined', async () => {
    const router = makeRouter();
    const { actions } = createSessionActionsFixture({ runtime: makeRuntime(router), showConfirm: vi.fn(async () => false) });
    await actions.deleteSession(SESSION.nativeSessionId);
    expect(router.delete).not.toHaveBeenCalled();
  });
  it('captures the qualified delete target before the confirmation dialog changes selection', async () => {
    const router = makeRouter();
    const { runtime, select } = mutableRuntime(router);
    const { actions } = createSessionActionsFixture({ runtime, showConfirm: vi.fn(async () => { select(parseSessionRef({ ...SESSION, harnessInstanceId: '44444444-4444-4444-8444-444444444444' })); return true; }) });
    await actions.deleteSession(SESSION.nativeSessionId);
    expect(router.delete).toHaveBeenCalledWith({ profileId: PROFILE, session: SESSION });
  });
  it('shows a qualified checkpoint failure and suppresses an obsolete failure after selection changes', async () => {
    const router = makeRouter();
    router.fork.mockRejectedValueOnce(new Error('native checkpoint missing'));
    const { runtime, select } = mutableRuntime(router);
    const { actions, mocks } = createSessionActionsFixture({ runtime });
    await actions.handleForkMessage({ sessionId: SESSION.nativeSessionId, messageId: 'prompt' });
    expect(mocks.setSessionError).toHaveBeenCalledWith(expect.stringContaining('app.error.sessionForkFailed'));
    mocks.setSessionError.mockClear();
    let reject!: (error: Error) => void;
    router.fork.mockReturnValueOnce(new Promise((_, rejectPromise) => { reject = rejectPromise; }));
    const action = actions.handleForkMessage({ sessionId: SESSION.nativeSessionId, messageId: 'prompt' });
    select(parseSessionRef({ ...SESSION, nativeSessionId: 'other-session' }));
    reject(new Error('late checkpoint failure'));
    await action;
    expect(mocks.setSessionError).not.toHaveBeenCalled();
  });
  it('archive/delete/compact/fork/revert delegate to the router and skip the legacy backend call', async () => {
    const router = makeRouter();
    const { actions, mocks } = createSessionActionsFixture({ runtime: makeRuntime(router), showConfirm: vi.fn(async () => true) });
    await actions.archiveSession(SESSION.nativeSessionId);
    await actions.deleteSession(SESSION.nativeSessionId);
    await actions.handleCompactSession(SESSION.nativeSessionId);
    await actions.handleForkSession(SESSION.nativeSessionId);
    await actions.handleRevertMessage({ sessionId: SESSION.nativeSessionId, messageId: 'm1' });
    const bound = { profileId: PROFILE, session: SESSION };
    expect(router.archive).toHaveBeenCalledWith(bound);
    expect(router.delete).toHaveBeenCalledWith(bound);
    expect(router.compact).toHaveBeenCalledWith(bound);
    expect(router.fork).toHaveBeenCalledWith(bound, {});
    expect(router.revert).toHaveBeenCalledWith(bound, { messageId: 'm1' });
    expect(mocks.openCodeApi.archiveSession).not.toHaveBeenCalled();
    expect(mocks.backendDeleteSession).not.toHaveBeenCalled();
  });

  it('a NON-selected target is routed, never the currently selected session', async () => {
    const router = makeRouter();
    const { runtime } = mutableRuntime(router, SESSION);
    const { actions } = createSessionActionsFixture({ runtime, showConfirm: vi.fn(async () => true) });
    // The selection is SESSION, but the operation is for a different native id.
    await actions.deleteSession('other-native-id');
    await actions.archiveSession('other-native-id');
    await actions.unarchiveSession('other-native-id');
    await actions.handleForkSession('other-native-id');
    const target = { profileId: PROFILE, session: { ...SESSION, nativeSessionId: 'other-native-id' } };
    expect(router.delete).toHaveBeenCalledWith(target);
    expect(router.archive).toHaveBeenCalledWith(target);
    expect(router.unarchive).toHaveBeenCalledWith(target);
    expect(router.fork).toHaveBeenCalledWith(target, {});
  });

  it('switching the selection during the rename dialog cannot change the outcome', async () => {
    const router = makeRouter();
    const otherSession: SessionRef = parseSessionRef({
      environmentId: ENV,
      harnessInstanceId: HARNESS,
      nativeSessionId: 'switched-to',
    });
    const { runtime, select } = mutableRuntime(router, SESSION);
    const { actions } = createSessionActionsFixture({
      runtime,
      showPrompt: vi.fn(async () => {
        // The user selects another session while the dialog is open.
        select(otherSession);
        return 'Renamed A';
      }),
    });
    await actions.renameSession(SESSION.nativeSessionId);
    expect(router.rename).toHaveBeenCalledWith(
      { profileId: PROFILE, session: SESSION },
      'Renamed A',
    );
  });

  it('without a runtime seam the legacy backend path still runs (no regression)', async () => {
    const { actions, mocks } = createSessionActionsFixture();
    await actions.archiveSession('bare-native-id', { projectId: 'proj-1', directory: '/repo' });
    expect(mocks.openCodeApi.archiveSession).toHaveBeenCalled();
  });
});

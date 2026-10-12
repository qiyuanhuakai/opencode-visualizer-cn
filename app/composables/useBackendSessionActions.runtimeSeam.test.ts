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

describe('legacy useBackendSessionActions seam delegates by full SessionRef', () => {
  it('archive/delete/compact/fork/revert delegate to the router and skip the legacy backend call', async () => {
    const router = makeRouter();
    const { actions, mocks } = createSessionActionsFixture({ runtime: makeRuntime(router) });
    await actions.archiveSession('bare-native-id');
    await actions.deleteSession('bare-native-id');
    await actions.handleCompactSession('bare-native-id');
    await actions.handleForkSession('bare-native-id');
    await actions.handleRevertMessage({ sessionId: 'bare-native-id', messageId: 'm1' });
    const bound = { profileId: PROFILE, session: SESSION };
    expect(router.archive).toHaveBeenCalledWith(bound);
    expect(router.delete).toHaveBeenCalledWith(bound);
    expect(router.compact).toHaveBeenCalledWith(bound);
    expect(router.fork).toHaveBeenCalledWith(bound, {});
    expect(router.revert).toHaveBeenCalledWith(bound, { messageId: 'm1' });
    expect(mocks.openCodeApi.archiveSession).not.toHaveBeenCalled();
    expect(mocks.backendDeleteSession).not.toHaveBeenCalled();
  });

  it('without a runtime seam the legacy backend path still runs (no regression)', async () => {
    const { actions, mocks } = createSessionActionsFixture();
    await actions.archiveSession('bare-native-id', { projectId: 'proj-1', directory: '/repo' });
    expect(mocks.openCodeApi.archiveSession).toHaveBeenCalled();
  });
});

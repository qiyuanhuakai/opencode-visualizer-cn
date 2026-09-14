import { ref } from 'vue';
import { vi } from 'vitest';
import type { BackendKind } from '../backends/types';
import {
  type CodexApiLike,
  type OpenCodeApiLike,
  useBackendSessionActions,
} from './useBackendSessionActions';

type ActionOptions = Parameters<typeof useBackendSessionActions>[0];

type ActionFixtureOverrides = Partial<
  Omit<ActionOptions, 'activeBackendKind' | 'openCodeApi' | 'codexApi'>
> & {
  readonly activeBackendKind?: BackendKind;
  readonly activeBackendKindRef?: ActionOptions['activeBackendKind'];
  readonly openCodeApi?: Partial<OpenCodeApiLike>;
  readonly codexApi?: Partial<CodexApiLike>;
};

export function createSessionActionsFixture(overrides: ActionFixtureOverrides = {}) {
  const {
    activeBackendKind,
    activeBackendKindRef,
    openCodeApi: openCodeOverrides,
    codexApi: codexOverrides,
    ...optionOverrides
  } = overrides;
  const openCodeApi = {
    deleteSession: vi.fn<OpenCodeApiLike['deleteSession']>(),
    archiveSession: vi.fn<OpenCodeApiLike['archiveSession']>(),
    unarchiveSession: vi.fn<OpenCodeApiLike['unarchiveSession']>(),
    renameSession: vi.fn<OpenCodeApiLike['renameSession']>(),
    pinSession: vi.fn<OpenCodeApiLike['pinSession']>(),
    unpinSession: vi.fn<OpenCodeApiLike['unpinSession']>(),
    forkSession: vi.fn<OpenCodeApiLike['forkSession']>(),
    revertSession: vi.fn<OpenCodeApiLike['revertSession']>(),
  };
  const codexApi = {
    hiddenThreadIds: ref(new Set<string>()),
    visibleThreads: ref<Array<{ id: string }>>([]),
    activeThreadId: ref(''),
    archiveThread: vi.fn<CodexApiLike['archiveThread']>(),
    hideThread: vi.fn<CodexApiLike['hideThread']>(),
    unhideThread: vi.fn<CodexApiLike['unhideThread']>(),
    setThreadName: vi.fn<CodexApiLike['setThreadName']>(),
    forkThread: vi.fn<CodexApiLike['forkThread']>(),
    rollbackThread: vi.fn<CodexApiLike['rollbackThread']>(),
    startThreadCompaction: vi.fn<CodexApiLike['startThreadCompaction']>(),
    selectThread: vi.fn<CodexApiLike['selectThread']>(),
  };
  const setSessionError = vi.fn<ActionOptions['setSessionError']>();
  const clearSessionError = vi.fn<ActionOptions['clearSessionError']>();
  const setLocalPinnedSession = vi.fn<ActionOptions['setLocalPinnedSession']>();
  const setLocalUnpinnedSession = vi.fn<ActionOptions['setLocalUnpinnedSession']>();
  const clearLocalPinnedSessionOverride = vi.fn<ActionOptions['clearLocalPinnedSessionOverride']>();
  const restoreLocalPinnedSessionOverride =
    vi.fn<ActionOptions['restoreLocalPinnedSessionOverride']>();
  const setSendStatusKey = vi.fn<ActionOptions['setSendStatusKey']>();
  const setLocalSessionArchived = vi.fn<ActionOptions['setLocalSessionArchived']>();
  const backendDeleteSession = vi.fn<ActionOptions['backendDeleteSession']>();
  const backendUpdateSession = vi.fn<ActionOptions['backendUpdateSession']>();
  const params = {
    activeBackendKind: activeBackendKindRef ?? ref(activeBackendKind ?? 'opencode'),
    codexProjectId: 'codex',
    selectedProjectId: ref('proj-1'),
    selectedSessionId: ref('session-1'),
    activeDirectory: ref('/repo'),
    localPinnedSessionStore: ref({}),
    serverProjects: {},
    ensureConnectionReady: () => true,
    setSessionError,
    clearSessionError,
    toErrorMessage: String,
    translate: (key: string) => key,
    showPrompt: vi.fn<ActionOptions['showPrompt']>(),
    showConfirm: vi.fn<ActionOptions['showConfirm']>(),
    findSessionInProjects: () => null,
    resolveProjectIdForSession: () => 'proj-1',
    resolveSessionOperationPayload: () => ({ projectId: 'proj-1', directory: '/repo' }),
    getSessionPinnedOverride: () => 123,
    setLocalPinnedSession,
    setLocalUnpinnedSession,
    clearLocalPinnedSessionOverride,
    restoreLocalPinnedSessionOverride,
    switchSessionSelection: vi.fn<ActionOptions['switchSessionSelection']>(),
    reloadSelectedSessionState: vi.fn<ActionOptions['reloadSelectedSessionState']>(),
    seedForkedSessionComposerDraft: vi.fn<ActionOptions['seedForkedSessionComposerDraft']>(),
    setSendStatusKey,
    setLocalSessionArchived,
    batchConcurrency: 2,
    backendDeleteSession,
    backendUpdateSession,
    ...optionOverrides,
    openCodeApi: { ...openCodeApi, ...openCodeOverrides },
    codexApi: { ...codexApi, ...codexOverrides },
  } satisfies ActionOptions;

  return {
    actions: useBackendSessionActions(params),
    params,
    mocks: {
      openCodeApi,
      codexApi,
      setSessionError,
      clearSessionError,
      setLocalPinnedSession,
      setLocalUnpinnedSession,
      clearLocalPinnedSessionOverride,
      restoreLocalPinnedSessionOverride,
      setSendStatusKey,
      setLocalSessionArchived,
      backendDeleteSession,
      backendUpdateSession,
    },
  };
}

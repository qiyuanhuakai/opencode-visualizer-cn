import { computed, createApp, defineComponent, h, provide, ref } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../locales/en';
import OutputPanel from './OutputPanel.vue';
import { RUNTIME_THREAD_STATE_KEY, createRuntimeThreadState } from '../composables/useRuntimeThread';
import type { RuntimeThreadState } from '../composables/useRuntimeThread';
import { createThreadService } from '../../bridge/runtime/threads/threadService.js';
import type { ThreadService } from '../../bridge/runtime/threads/threadService.js';
import { parseRepoRef, parseSessionRef } from '../../shared/runtime/identity.js';
import type { EnvironmentId, HarnessInstanceId, RepoRef, SessionRef } from '../../shared/runtime/identity.js';

vi.mock('../utils/workerRenderer', () => ({
  startRenderWorkerHtml: () => ({ promise: Promise.resolve(''), cancel: () => {} }),
  RenderCancelledError: class RenderCancelledError extends Error {},
}));
vi.mock('../composables/useFileTree', async () => {
  const { ref } = await import('vue');
  return { useFileTree: () => ({ files: ref<string[]>([]) }) };
});
vi.mock('@iconify/vue', () => ({ Icon: { template: '<span />' } }));

const SESSION_A = parseSessionRef({
  environmentId: '11111111-1111-4111-8111-111111111111' as EnvironmentId,
  harnessInstanceId: '10000000-0000-4000-8000-000000000001' as HarnessInstanceId,
  nativeSessionId: 'native-a',
});
const SESSION_B = parseSessionRef({
  environmentId: '11111111-1111-4111-8111-111111111111' as EnvironmentId,
  harnessInstanceId: '20000000-0000-4000-8000-000000000002' as HarnessInstanceId,
  nativeSessionId: 'native-b',
});
const REPO: RepoRef = parseRepoRef({
  environmentId: '11111111-1111-4111-8111-111111111111' as EnvironmentId,
  canonicalCommonDir: '/repo',
  pathPolicy: { platform: 'posix', volumeId: 'vol', caseSensitive: true },
});

const apps = new Set<ReturnType<typeof createApp>>();
afterEach(() => {
  for (const app of apps) app.unmount();
  apps.clear();
  document.body.replaceChildren();
});

async function settle(root: HTMLElement): Promise<void> {
  // The panel hosts the thread surface through an async component, so the mount is
  // awaited the same way the InputPanel seam test awaits its async chips row.
  await vi.waitFor(() => {
    if (root.querySelector<HTMLElement>('[data-testid="thread-view"]') === null) {
      throw new Error('the thread surface has not mounted yet');
    }
  });
}

interface Mounted {
  root: HTMLElement;
  state: RuntimeThreadState;
  refreshCalls: Array<{ participantId: string; session: SessionRef }>;
}

/**
 * The container the reviewer asked for: the REAL OutputPanel hosting the REAL ThreadView over
 * the REAL composable, with the container owning the native-history source the way App.vue
 * will. Locate writes the composable's selection; Refresh re-reads the container's source.
 */
async function mountThreadOutputPanel(): Promise<Mounted> {
  const sessions = new Map<string, SessionRef>([
    [SESSION_A.nativeSessionId, SESSION_A],
    [SESSION_B.nativeSessionId, SESSION_B],
  ]);
  const threads: ThreadService = createThreadService({
    resolveSession: async (ref) => (sessions.has(ref.nativeSessionId) ? { session: ref, archived: false, parentSession: null } : null),
  });
  const bound = await threads.bind({ session: SESSION_A, repo: REPO });
  await threads.join({ threadId: bound.threadId, session: SESSION_B, repo: REPO });
  const state = createRuntimeThreadState({ thread: threads });
  await state.openThread({ session: SESSION_A, repo: REPO });
  await state.joinThread(SESSION_B);

  const refreshCalls: Array<{ participantId: string; session: SessionRef }> = [];
  const readCount = ref(0);
  const Container = defineComponent({
    setup() {
      provide(RUNTIME_THREAD_STATE_KEY, state);
      const nativeHistory = computed(() => {
        const generation = readCount.value;
        const text = generation === 0 ? 'first-read-entry' : `reloaded-entry-${generation}`;
        return [{
          participantId: state.summary.value?.participants[1]?.participantId ?? '',
          label: 'session-b',
          harness: 'codex',
          session: SESSION_B,
          entries: [{ id: `entry-${generation}`, kind: 'message' as const, text, at: 1000 }],
        }];
      });
      return { state, nativeHistory, refreshCalls };
    },
    render() {
      return h(OutputPanel, {
        isFollowing: false,
        isAnchoring: false,
        statusText: '',
        isStatusError: false,
        isThinking: false,
        theme: 'github-dark',
        currentSessionId: SESSION_A.nativeSessionId,
        backendKind: 'opencode',
        threadAvailableSessions: [{ session: SESSION_B, label: 'session-b', harness: 'codex' }],
        threadNativeHistory: this.nativeHistory,
        threadCheckpoint: null,
        threadCurrentTarget: null,
        threadReadEvidence: null,
        threadDraftText: '',
        threadHandoffEntries: [],
        threadLatestNativeEventId: '',
        onRefreshNativeHistory: (payload: { participantId: string; session: SessionRef }) => {
          this.refreshCalls.push(payload);
          readCount.value += 1;
        },
      });
    },
  });
  const root = document.createElement('div');
  document.body.appendChild(root);
  const app = createApp(Container);
  apps.add(app);
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
  app.provide('showConfirm', async () => true);
  app.mount(root);
  await settle(root);
  return { root, state, refreshCalls };
}

describe('OutputPanel hosts the real thread chain: Locate drives the tree and Refresh re-reads', () => {
  it('feeds the located session back into the panel, so Locate is not a dead write', async () => {
    // Given: the real panel hosting the real thread surface.
    const { root, state } = await mountThreadOutputPanel();
    const targetParticipantId = state.summary.value?.participants[1]?.participantId ?? '';

    // When: the user locates the SECOND participant's own native session in the tree.
    root
      .querySelector<HTMLElement>(
        `[data-testid="locate-session"][data-participant-id="${targetParticipantId}"]`,
      )
      ?.click();
    await settle(root);

    // Then: the selection reached the composable...
    expect(state.selectedSession.value).toEqual(SESSION_B);
    // ...and came BACK into the panel as the resolved thread↔session line, naming the
    // participant the tree's selection belongs to.
    const resolution = root.querySelector<HTMLElement>('[data-testid="thread-for-session"]');
    expect(resolution).not.toBeNull();
    expect(resolution?.getAttribute('data-unresolved')).toBe('false');
    expect(resolution?.getAttribute('data-participant-id')).toBe(targetParticipantId);
  });

  it('re-reads the native history from Refresh instead of only writing the selection', async () => {
    // Given: the real panel with a container-owned history source.
    const { root, refreshCalls } = await mountThreadOutputPanel();
    const entry = root.querySelector<HTMLElement>('[data-testid="native-history-entry"]');
    expect(entry?.textContent?.trim()).toBe('first-read-entry');

    // When: the user clicks the group's Refresh.
    root.querySelector<HTMLElement>('[data-testid="browse-native-history"]')?.click();
    await settle(root);

    // Then: the refresh action really reached the container with the participant identity...
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0]?.session).toEqual(SESSION_B);
    // ...and the panel shows the RE-READ bytes, not the first read.
    const reloaded = root.querySelector<HTMLElement>('[data-testid="native-history-entry"]');
    expect(reloaded?.textContent?.trim()).toBe('reloaded-entry-1');
  });
});

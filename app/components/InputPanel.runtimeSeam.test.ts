import { createApp, computed, defineComponent, h, reactive, resolveComponent } from 'vue';
import type { Ref } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import en from '../locales/en';
import InputPanel from './InputPanel.vue';
import { INPUT_PANEL_DEFAULT_PROPS } from './inputPanel.test-helpers';
import { parseConnectionProfileId, parseRepoRef, parseSessionRef } from '../../shared/runtime/identity.js';
import type { ConnectionProfileId, EnvironmentId, HarnessInstanceId, RepoRef, SessionRef } from '../../shared/runtime/identity.js';
import { createThreadService } from '../../bridge/runtime/threads/threadService.js';
import { RUNTIME_SESSION_ACTIONS_KEY } from '../composables/useRuntimeSessionActions';
import type { RuntimeSessionRouter, RuntimeSessionRuntime } from '../composables/useRuntimeSessionActions';
import { RUNTIME_THREAD_STATE_KEY, createRuntimeThreadState } from '../composables/useRuntimeThread';
import type { RuntimeThreadState } from '../composables/useRuntimeThread';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));

const PROFILE: ConnectionProfileId = parseConnectionProfileId('33333333-3333-4333-8333-333333333333');
const SESSION = parseSessionRef({
  environmentId: '11111111-1111-4111-8111-111111111111' as EnvironmentId,
  harnessInstanceId: '10000000-0000-4000-8000-000000000001' as HarnessInstanceId,
  nativeSessionId: 'native-1',
});
const TARGET_SESSION = parseSessionRef({
  environmentId: '11111111-1111-4111-8111-111111111111' as EnvironmentId,
  harnessInstanceId: '20000000-0000-4000-8000-000000000002' as HarnessInstanceId,
  nativeSessionId: 'native-target',
});
const REPO: RepoRef = parseRepoRef({
  environmentId: '11111111-1111-4111-8111-111111111111' as EnvironmentId,
  canonicalCommonDir: '/repo',
  pathPolicy: { platform: 'posix', volumeId: 'vol', caseSensitive: true },
});

const apps = new Set<ReturnType<typeof createApp>>();
afterEach(() => { for (const app of apps) app.unmount(); apps.clear(); document.body.replaceChildren(); });

function makeRouter() {
  return {
    sendMessage: vi.fn(), cancel: vi.fn(), fork: vi.fn(), rename: vi.fn(), archive: vi.fn(),
    unarchive: vi.fn(), delete: vi.fn(), compact: vi.fn(), revert: vi.fn(), todos: vi.fn(),
    tokenMonitor: vi.fn(), history: vi.fn(), respond: vi.fn(),
  } satisfies Record<keyof RuntimeSessionRouter, ReturnType<typeof vi.fn>>;
}

function mount(options: { port?: RuntimeSessionRuntime; threadState?: RuntimeThreadState; onSend?: () => void; onStatusError?: (message: string) => void }) {
  const root = document.createElement('div');
  document.body.appendChild(root);
  const props = reactive({
    ...INPUT_PANEL_DEFAULT_PROPS,
    messageInput: 'hi',
    canSend: true,
    onSend: options.onSend ?? vi.fn(),
    ...(options.onStatusError === undefined ? {} : { onStatusError: options.onStatusError }),
  });
  const app = createApp(defineComponent({ setup: () => () => h(resolveComponent('InputPanel'), props) }));
  apps.add(app);
  app.component('InputPanel', InputPanel);
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
  app.provide('showConfirm', async () => true);
  if (options.port) app.provide(RUNTIME_SESSION_ACTIONS_KEY, options.port);
  if (options.threadState) app.provide(RUNTIME_THREAD_STATE_KEY, options.threadState);
  app.mount(root);
  return root;
}

describe('InputPanel uses the qualified runtime path when a port is provided', () => {
  it('routes the send through the port and does not emit legacy send', () => {
    const router = makeRouter();
    const onSend = vi.fn();
    const port: RuntimeSessionRuntime = { binding: () => ({ profileId: PROFILE, session: SESSION }), router: router as unknown as RuntimeSessionRouter };
    const root = mount({ port, onSend });
    root.querySelector<HTMLElement>('.send-button')?.click();
    expect(router.sendMessage).toHaveBeenCalledTimes(1);
    const [binding, input] = router.sendMessage.mock.calls[0]!;
    expect(binding).toEqual({ profileId: PROFILE, session: SESSION });
    expect(input).toMatchObject({ text: 'hi', model: 'openai/gpt' });
    expect(onSend).not.toHaveBeenCalled();
  });

  it('falls back to the legacy emit when no port is provided', () => {
    const onSend = vi.fn();
    const root = mount({ onSend });
    root.querySelector<HTMLElement>('.send-button')?.click();
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('falls back to the legacy emit when the port has no qualified binding', () => {
    const router = makeRouter();
    const onSend = vi.fn();
    const port: RuntimeSessionRuntime = { binding: () => null, router: router as unknown as RuntimeSessionRouter };
    const root = mount({ port, onSend });
    root.querySelector<HTMLElement>('.send-button')?.click();
    expect(router.sendMessage).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it('sends through the selected thread target participant session, not the runtime binding session', async () => {
    const sessions = new Map<string, { session: SessionRef; archived: boolean; parentSession: null }>([
      [SESSION.nativeSessionId, { session: SESSION, archived: false, parentSession: null }],
      [TARGET_SESSION.nativeSessionId, { session: TARGET_SESSION, archived: false, parentSession: null }],
    ]);
    const threads = createThreadService({
      resolveSession: async (ref: SessionRef) => sessions.get(ref.nativeSessionId) ?? null,
    });
    // Bind and join for real so the composable holds the frozen participant read models.
    const bound = await threads.bind({ session: SESSION, repo: REPO });
    const joined = await threads.join({ threadId: bound.threadId, session: TARGET_SESSION, repo: REPO });
    const state = createRuntimeThreadState({ thread: threads });
    await state.openThread({ session: SESSION, repo: REPO });
    state.setTarget(joined.participantId);

    const router = makeRouter();
    const port: RuntimeSessionRuntime = { binding: () => ({ profileId: PROFILE, session: SESSION }), router: router as unknown as RuntimeSessionRouter };
    const root = mount({ port, threadState: state });
    root.querySelector<HTMLElement>('.send-button')?.click();
    expect(router.sendMessage).toHaveBeenCalledTimes(1);
    const [binding] = router.sendMessage.mock.calls[0]!;
    // The chips name the target participant, so the prompt must go to THAT participant's session.
    expect((binding as { session: SessionRef }).session).toEqual(TARGET_SESSION);
  });

  it('sends through the ACTIVE participant session when no target is explicitly selected', async () => {
    // Given: a bound thread (A) with B joined and ACTIVATED, and NO explicit
    // target selection — the default every real session starts in. The chips
    // follow the active participant, so the send must follow it too.
    const sessions = new Map<string, { session: SessionRef; archived: boolean; parentSession: null }>([
      [SESSION.nativeSessionId, { session: SESSION, archived: false, parentSession: null }],
      [TARGET_SESSION.nativeSessionId, { session: TARGET_SESSION, archived: false, parentSession: null }],
    ]);
    const threads = createThreadService({
      resolveSession: async (ref: SessionRef) => sessions.get(ref.nativeSessionId) ?? null,
    });
    const bound = await threads.bind({ session: SESSION, repo: REPO });
    const joined = await threads.join({ threadId: bound.threadId, session: TARGET_SESSION, repo: REPO });
    const state = createRuntimeThreadState({ thread: threads });
    await state.openThread({ session: SESSION, repo: REPO });
    await state.joinThread(TARGET_SESSION);
    await state.activateParticipant(joined.participantId);

    const router = makeRouter();
    const port: RuntimeSessionRuntime = { binding: () => ({ profileId: PROFILE, session: SESSION }), router: router as unknown as RuntimeSessionRouter };
    const root = mount({ port, threadState: state });
    root.querySelector<HTMLElement>('.send-button')?.click();
    expect(router.sendMessage).toHaveBeenCalledTimes(1);
    const [binding] = router.sendMessage.mock.calls[0]!;
    // The chips display the ACTIVE participant, so the prompt must go to that
    // participant's own session — not the session the ambient binding holds.
    expect((binding as { session: SessionRef }).session).toEqual(TARGET_SESSION);
  });

  it('displays and send agree: the chips name the active participant the router receives', async () => {
    // Given: the default-active state above, mounted for real.
    const sessions = new Map<string, { session: SessionRef; archived: boolean; parentSession: null }>([
      [SESSION.nativeSessionId, { session: SESSION, archived: false, parentSession: null }],
      [TARGET_SESSION.nativeSessionId, { session: TARGET_SESSION, archived: false, parentSession: null }],
    ]);
    const threads = createThreadService({
      resolveSession: async (ref: SessionRef) => sessions.get(ref.nativeSessionId) ?? null,
    });
    const bound = await threads.bind({ session: SESSION, repo: REPO });
    const joined = await threads.join({ threadId: bound.threadId, session: TARGET_SESSION, repo: REPO });
    const state = createRuntimeThreadState({ thread: threads });
    await state.openThread({ session: SESSION, repo: REPO });
    await state.joinThread(TARGET_SESSION);
    await state.activateParticipant(joined.participantId);

    const router = makeRouter();
    const port: RuntimeSessionRuntime = { binding: () => ({ profileId: PROFILE, session: SESSION }), router: router as unknown as RuntimeSessionRouter };
    const root = mount({ port, threadState: state });

    // When: the composer's own target row (the real ThreadView chips) renders.
    // The row is an async component, so it settles on a later microtask.
    await vi.waitFor(() => {
      expect(root.querySelector<HTMLElement>('[data-testid="target-count"]')?.textContent?.trim()).toBe('1');
    });
    const count = root.querySelector<HTMLElement>('[data-testid="target-count"]');
    expect(count?.textContent?.trim()).toBe('1');

    // Then: clicking Send routes to the SAME participant the chips name.
    root.querySelector<HTMLElement>('.send-button')?.click();
    const [binding] = router.sendMessage.mock.calls[0]!;
    expect((binding as { session: SessionRef }).session).toEqual(TARGET_SESSION);
  });

  it('refuses the send when a thread is open but its effective target cannot be resolved', async () => {
    // Given: a thread state that is open yet has NO resolvable effective
    // target (the anomalous state the real service does not produce, driven
    // here so the safety net is covered). The ambient binding still holds A.
    const sessions = new Map<string, { session: SessionRef; archived: boolean; parentSession: null }>([
      [SESSION.nativeSessionId, { session: SESSION, archived: false, parentSession: null }],
    ]);
    const threads = createThreadService({
      resolveSession: async (ref: SessionRef) => sessions.get(ref.nativeSessionId) ?? null,
    });
    await threads.bind({ session: SESSION, repo: REPO });
    const state = createRuntimeThreadState({ thread: threads });
    await state.openThread({ session: SESSION, repo: REPO });
    const anomalous = state as RuntimeThreadState & { effectiveTargets: Ref<readonly unknown[]> };
    anomalous.effectiveTargets = computed(() => Object.freeze([]));

    const router = makeRouter();
    const statusError = vi.fn();
    const port: RuntimeSessionRuntime = { binding: () => ({ profileId: PROFILE, session: SESSION }), router: router as unknown as RuntimeSessionRouter };
    const root = mount({ port, threadState: anomalous, onStatusError: statusError });
    root.querySelector<HTMLElement>('.send-button')?.click();

    // Then: nothing is sent through the ambient binding — the silent fallback
    // is exactly the defect this lane exists for — and the refusal is visible.
    expect(router.sendMessage).not.toHaveBeenCalled();
    expect(statusError).toHaveBeenCalledTimes(1);
    expect(String(statusError.mock.calls[0]?.[0])).not.toBe('');
  });
});

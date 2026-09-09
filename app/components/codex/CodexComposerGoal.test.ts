import { createApp, nextTick, ref, type App } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { useCodexApi } from '../../composables/useCodexApi';
import type { CodexThreadGoal } from '../../backends/codex/codexAdapter';
import CodexComposerGoal from './CodexComposerGoal.vue';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
const apps: App[] = [];
function mountGoal(connected = true, activeThreadId: string | null = 'thread-a') {
  const api = {
    connected: ref(connected), activeThreadId: ref(activeThreadId),
    threadGoal: ref<CodexThreadGoal | null>(null), threadGoalThreadId: ref<string | null>('thread-a'),
    threadGoalLoading: ref(false),
    runtimeCapabilities: ref<ReturnType<typeof useCodexApi>['runtimeCapabilities']['value']>({}),
    refreshThreadGoal: vi.fn(async (_threadId?: string | null) => ({ goal: null })),
  };
  const target = document.createElement('div');
  document.body.append(target);
  const onOpen = vi.fn();
  const app = createApp(CodexComposerGoal, { api, onOpen });
  app.use(createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false }));
  app.mount(target);
  apps.push(app);
  const button = target.querySelector('button');
  if (!button) throw new Error('Goal button missing');
  return { api, target, button, onOpen };
}
afterEach(() => {
  apps.splice(0).forEach(app => app.unmount());
  document.body.innerHTML = '';
});
describe('CodexComposerGoal', () => {
  it('loads the active thread and opens the editor on click', async () => {
    const { api, button, onOpen } = mountGoal();
    button.click();
    expect(onOpen).toHaveBeenCalledOnce();
    expect(api.refreshThreadGoal).toHaveBeenCalledExactlyOnceWith('thread-a');
  });
  it.each([[false, 'thread-a'], [true, null]])('disables unavailable context connected=%s thread=%s', (connected, threadId) => {
    const { button, api, onOpen } = mountGoal(connected, threadId);
    button.click();
    expect(button.disabled).toBe(true);
    expect(onOpen).not.toHaveBeenCalled();
    expect(api.refreshThreadGoal).not.toHaveBeenCalled();
  });
  it('shows current objective with full accessible text', async () => {
    const { api, button } = mountGoal();
    api.threadGoal.value = { threadId: 'thread-a', objective: 'Objective '.repeat(50), status: 'active', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 0, updatedAt: 0 };
    await nextTick();
    expect(button.title).toContain(api.threadGoal.value.objective);
    expect(button.getAttribute('aria-label')).toBe(button.title);
  });
  it('does not show the previous thread objective after switching', async () => {
    const { api, button } = mountGoal();
    api.threadGoal.value = { threadId: 'thread-a', objective: 'Old objective', status: 'active', tokenBudget: null, tokensUsed: 0, timeUsedSeconds: 0, createdAt: 0, updatedAt: 0 };
    api.activeThreadId.value = 'thread-b';
    await nextTick();
    expect(button.textContent).not.toContain('Old objective');
    expect(api.refreshThreadGoal).toHaveBeenLastCalledWith('thread-b');
  });
  it('keeps unsupported goals inspectable', async () => {
    const { api, button, onOpen } = mountGoal();
    api.runtimeCapabilities.value = { 'thread/goal/get': 'unsupported' };
    await nextTick();
    button.click();
    expect(button.disabled).toBe(false);
    expect(onOpen).toHaveBeenCalledOnce();
    expect(button.textContent).toContain('does not support');
  });
  it('announces refresh failure without rejecting the watcher', async () => {
    const { api, target } = mountGoal();
    api.refreshThreadGoal.mockRejectedValueOnce(new Error('Read failed'));
    api.activeThreadId.value = 'thread-b';
    await nextTick();
    await nextTick();
    expect(target.querySelector('[role="alert"]')?.textContent).toContain('Read failed');
  });
});

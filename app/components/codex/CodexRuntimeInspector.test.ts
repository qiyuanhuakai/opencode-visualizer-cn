import { createApp, nextTick, ref, type App as VueApp } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { useCodexApi } from '../../composables/useCodexApi';
import CodexRuntimeInspector from './CodexRuntimeInspector.vue';

const mountedApps: VueApp[] = [];

function mountInspector() {
  const activeThreadId = ref('thread-1');
  const threadGoalLoading = ref(false);
  const threadGoalThreadId = ref<string | null>('thread-1');
  const api = {
    activeThreadId,
    runtimeCapabilities: ref({ 'thread/goal/get': 'supported' }),
    threadGoal: ref({
      threadId: 'thread-1',
      objective: 'Ship integration',
      status: 'active',
      tokenBudget: 1000,
      tokensUsed: 100,
      timeUsedSeconds: 60,
      createdAt: 1,
      updatedAt: 2,
    }),
    threadGoalLoading,
    threadGoalThreadId,
    accountUsage: ref({
      summary: { lifetimeTokens: 1200, currentStreakDays: 3 },
      dailyUsageBuckets: [],
    }),
    accountUsageLoading: ref(false),
    modelProviderCapabilities: ref({
      namespaceTools: true,
      imageGeneration: false,
      webSearch: true,
    }),
    modelProviderCapabilitiesLoading: ref(false),
    permissionProfiles: ref([{ id: 'default', description: 'Default profile' }]),
    permissionProfilesLoading: ref(false),
    configRequirements: ref({ allowedResidencies: ['us'] }),
    configRequirementsLoading: ref(false),
    loadedThreadIds: ref(['thread-1']),
    refreshThreadGoal: vi.fn().mockResolvedValue({ goal: null }),
    refreshAccountUsage: vi.fn().mockResolvedValue({}),
    refreshModelProviderCapabilities: vi.fn().mockResolvedValue({}),
    refreshPermissionProfiles: vi.fn().mockResolvedValue({}),
    refreshConfigRequirements: vi.fn().mockResolvedValue({}),
    refreshLoadedThreads: vi.fn().mockResolvedValue(undefined),
    setThreadGoal: vi.fn().mockResolvedValue({}),
    clearThreadGoal: vi.fn().mockResolvedValue({ cleared: true }),
    cleanThreadBackgroundTerminals: vi.fn().mockResolvedValue(undefined),
  } as unknown as ReturnType<typeof useCodexApi>;
  const target = document.createElement('div');
  document.body.append(target);
  const app = createApp(CodexRuntimeInspector, { api });
  app.use(
    createI18n({
      legacy: false,
      locale: 'en',
      messages: {
        en: {
          common: { refresh: 'Refresh', save: 'Save', clear: 'Clear' },
          codexPanel: {
            runtime: {
              title: 'Runtime',
              capabilities: 'Capabilities',
              goal: 'Goal',
              objective: 'Objective',
              tokenBudget: 'Token budget',
              status: 'Status',
              usage: 'Usage',
              lifetimeTokens: 'Lifetime tokens',
              streakDays: 'Streak days',
              provider: 'Provider capabilities',
              permissionProfiles: 'Permission profiles',
              configRequirements: 'Config requirements',
              loadedThreads: 'Loaded threads',
              cleanBackgroundTerminals: 'Clean terminals',
              supported: 'Supported',
              unsupported: 'Unsupported',
              gated: 'Gated',
              unknown: 'Unknown',
              enabled: 'Enabled',
              disabled: 'Disabled',
              goalStatusActive: 'Active',
              goalStatusPaused: 'Paused',
              goalStatusBlocked: 'Blocked',
              goalStatusUsageLimited: 'Usage limited',
              goalStatusBudgetLimited: 'Budget limited',
              goalStatusComplete: 'Complete',
            },
          },
        },
      },
    }),
  );
  mountedApps.push(app);
  app.mount(target);
  return { api, target, activeThreadId, threadGoalLoading };
}

afterEach(() => {
  mountedApps.splice(0).forEach((app) => app.unmount());
  document.body.innerHTML = '';
});

describe('CodexRuntimeInspector', () => {
  it('loads and renders runtime-supported data, then saves the active goal', async () => {
    const { api, target } = mountInspector();
    await nextTick();

    expect(api.refreshAccountUsage).toHaveBeenCalledOnce();
    expect(target.textContent).toContain('1,200');
    expect(target.textContent).toContain('Default profile');

    const objective = target.querySelector<HTMLInputElement>('input[name="objective"]');
    expect(objective).not.toBeNull();
    if (!objective) throw new Error('Objective input missing.');
    expect(objective.value).toBe('Ship integration');
    objective.value = 'Updated objective';
    objective.dispatchEvent(new Event('input', { bubbles: true }));
    const save = Array.from(target.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    save?.click();
    await nextTick();

    expect(api.setThreadGoal).toHaveBeenCalledWith({
      objective: 'Updated objective',
      status: 'active',
      tokenBudget: 1000,
    });

    Array.from(target.querySelectorAll('button')).find((button) => button.textContent?.trim() === 'Clean terminals')?.click();
    await vi.waitFor(() => expect(api.cleanThreadBackgroundTerminals).toHaveBeenCalledWith('thread-1'));
  });

  it('clears and locks the goal editor while a newly selected thread goal loads', async () => {
    const { api, target, activeThreadId, threadGoalLoading } = mountInspector();
    await nextTick();
    const objective = target.querySelector<HTMLInputElement>('input[name="objective"]');
    const save = Array.from(target.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Save',
    );
    if (!objective || !save) throw new Error('Goal controls missing.');

    activeThreadId.value = 'thread-2';
    threadGoalLoading.value = true;
    await nextTick();

    expect(objective.value).toBe('');
    expect(save.disabled).toBe(true);
    expect(api.refreshThreadGoal).toHaveBeenCalledWith('thread-2');
  });
});

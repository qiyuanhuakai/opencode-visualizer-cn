import { createApp, nextTick, ref, type App as VueApp } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { useCodexApi } from '../../composables/useCodexApi';
import CodexRuntimeInspector from './CodexRuntimeInspector.vue';

const mountedApps: VueApp[] = [];

vi.mock('@iconify/vue', () => ({ Icon: () => null }));

function mountInspector() {
  const connected = ref(true);
  const activeThreadId = ref('thread-1');
  const threadGoalLoading = ref(false);
  const threadGoalThreadId = ref<string | null>('thread-1');
  const api = {
    connected,
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
  return { api, target, activeThreadId, threadGoalLoading, connected };
}

afterEach(() => {
  mountedApps.splice(0).forEach((app) => app.unmount());
  document.body.innerHTML = '';
});

describe('CodexRuntimeInspector', () => {
  it('saves a status selected with the shared dropdown', async () => {
    const { api, target } = mountInspector();
    await nextTick();
    expect(target.querySelector('select')).toBeNull();
    const trigger = target.querySelector<HTMLButtonElement>('.goal-status-dropdown button');
    trigger?.click();
    await nextTick();
    const paused = Array.from(target.querySelectorAll<HTMLElement>('[role="option"]'))
      .find((option) => option.textContent?.trim() === 'Paused');
    expect(paused).toBeDefined();
    paused?.click();
    await nextTick();
    expect(trigger?.textContent).toContain('Paused');
    target.querySelector<HTMLButtonElement>('.goal-save')?.click();
    await nextTick();
    expect(api.setThreadGoal).toHaveBeenCalledWith({ objective: 'Ship integration', status: 'paused', tokenBudget: 1000 });
  });

  it('loads and renders runtime-supported data, then saves the active goal', async () => {
    const { api, target } = mountInspector();
    await nextTick();

    expect(api.refreshAccountUsage).toHaveBeenCalledOnce();
    expect(target.textContent).toContain('1,200');
    expect(target.textContent).toContain('Default profile');

    const objective = target.querySelector<HTMLTextAreaElement>('textarea[name="objective"]');
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
    const objective = target.querySelector<HTMLTextAreaElement>('textarea[name="objective"]');
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

it('sends null when the budget is emptied', async () => {
  const { api, target } = mountInspector();
  await nextTick();
  const budget = target.querySelector<HTMLInputElement>('input[type="number"]');
  if (!budget) throw new Error('Budget input missing');
  budget.value = '';
  budget.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  Array.from(target.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Save')?.click();
  await nextTick();
  expect(api.setThreadGoal).toHaveBeenCalledWith({ objective: 'Ship integration', status: 'active', tokenBudget: null });
});

it.each(['0', '-1', '1.5'])('blocks invalid budget %s', async (value) => {
  const { api, target } = mountInspector();
  await nextTick();
  const budget = target.querySelector<HTMLInputElement>('input[type="number"]');
  if (!budget) throw new Error('Budget input missing');
  budget.value = value;
  budget.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  const save = Array.from(target.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Save');
  expect(save?.disabled).toBe(true);
  save?.click();
  expect(api.setThreadGoal).not.toHaveBeenCalled();
});

it('shows a save failure and keeps the draft for retry', async () => {
  const { api, target } = mountInspector();
  vi.mocked(api.setThreadGoal).mockRejectedValueOnce(new Error('Request refused'));
  await nextTick();
  Array.from(target.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Save')?.click();
  await vi.waitFor(() => expect(target.querySelector('[role="alert"]')?.textContent).toContain('Request refused'));
  expect(target.querySelector<HTMLTextAreaElement>('textarea[name="objective"]')?.value).toBe('Ship integration');
  expect(Array.from(target.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Save')?.disabled).toBe(false);
});

it('shows clear failure without erasing the saved goal', async () => {
  const { api, target } = mountInspector();
  vi.mocked(api.clearThreadGoal).mockRejectedValueOnce(new Error('Clear refused'));
  await nextTick();
  Array.from(target.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Clear')?.click();
  await vi.waitFor(() => expect(target.querySelector('[role="alert"]')?.textContent).toContain('Clear refused'));
  expect(target.querySelector<HTMLTextAreaElement>('textarea[name="objective"]')?.value).toBe('Ship integration');
});

it('announces successful saving', async () => {
  const { target } = mountInspector();
  await nextTick();
  Array.from(target.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Save')?.click();
  await vi.waitFor(() => expect(target.querySelector('[role="status"]')?.textContent).toBe('Goal saved.'));
});

it.each(['unsupported', 'gated'] as const)('locks unavailable goal operations: %s', async state => {
  const { api, target } = mountInspector();
  api.runtimeCapabilities.value['thread/goal/set'] = state;
  await nextTick();
  expect(Array.from(target.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Save')?.disabled).toBe(true);
  expect(target.querySelector('[role="status"]')?.textContent).toBeTruthy();
});

it('locks the editor when disconnected', async () => {
  const { connected, target } = mountInspector();
  connected.value = false;
  await nextTick();
  expect(target.querySelector<HTMLTextAreaElement>('textarea[name="objective"]')?.disabled).toBe(true);
  expect(target.querySelector('[role="status"]')?.textContent).toBeTruthy();
});

it('blocks objectives above the server limit', async () => {
  const { api, target } = mountInspector();
  await nextTick();
  const objective = target.querySelector<HTMLTextAreaElement>('textarea[name="objective"]');
  if (!objective) throw new Error('Objective missing');
  objective.value = 'x'.repeat(4001);
  objective.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  expect(Array.from(target.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Save')?.disabled).toBe(true);
  expect(api.setThreadGoal).not.toHaveBeenCalled();
});

it('announces successful clearing', async () => {
  const { target } = mountInspector();
  await nextTick();
  Array.from(target.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Clear')?.click();
  await vi.waitFor(() => expect(target.querySelector('[role="status"]')?.textContent).toBe('Goal cleared.'));
});

it('shows a load failure and permits retry through Refresh', async () => {
  const { api, target } = mountInspector();
  await nextTick();
  await vi.waitFor(() => expect(Array.from(target.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Refresh')?.disabled).toBe(false));
  vi.mocked(api.refreshThreadGoal).mockRejectedValueOnce(new Error('Read refused'));
  Array.from(target.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Refresh')?.click();
  await vi.waitFor(() => expect(target.querySelector('[role="alert"]')?.textContent).toContain('Read refused'));
  expect(target.querySelector<HTMLTextAreaElement>('textarea[name="objective"]')?.disabled).toBe(true);
  Array.from(target.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Refresh')?.click();
  await vi.waitFor(() => expect(target.querySelector<HTMLTextAreaElement>('textarea[name="objective"]')?.disabled).toBe(false));
  expect(target.querySelector('[role="alert"]')).toBeNull();
});

it('shows goal usage separately from lifetime usage', async () => {
  const { target } = mountInspector();
  await nextTick();
  const goal = target.querySelector('textarea')?.closest('article');
  expect(Array.from(goal?.querySelectorAll('dd') ?? []).map(node => node.textContent)).toEqual(['100', '60']);
});

it('locks the editor without a selected thread', async () => {
  const { activeThreadId, target } = mountInspector();
  activeThreadId.value = '';
  await nextTick();
  expect(target.querySelector<HTMLTextAreaElement>('textarea[name="objective"]')?.disabled).toBe(true);
  expect(target.querySelector('[role="status"]')?.textContent).toBeTruthy();
});

it('ignores an old save success after switching away and back', async () => {
  const { api, target, activeThreadId } = mountInspector();
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof api.setThreadGoal>>>();
  vi.mocked(api.setThreadGoal).mockReturnValueOnce(pending.promise);
  await nextTick();
  Array.from(target.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Save')?.click();
  activeThreadId.value = 'thread-2';
  activeThreadId.value = 'thread-1';
  await nextTick();
  const goal = api.threadGoal.value;
  if (!goal) throw new Error('Goal missing');
  pending.resolve({ goal });
  await pending.promise;
  await nextTick();
  expect(target.querySelector('[role="status"]')).toBeNull();
});

it('ignores an old save error after disconnecting and reconnecting', async () => {
  const { api, target, connected } = mountInspector();
  const pending = Promise.withResolvers<Awaited<ReturnType<typeof api.setThreadGoal>>>();
  vi.mocked(api.setThreadGoal).mockReturnValueOnce(pending.promise);
  await nextTick();
  Array.from(target.querySelectorAll('button')).find(button => button.textContent?.trim() === 'Save')?.click();
  connected.value = false;
  connected.value = true;
  await nextTick();
  pending.reject(new Error('Old connection failed'));
  await nextTick();
  await nextTick();
  expect(target.querySelector('[role="alert"]')).toBeNull();
});

it('preserves unsaved draft when a live usage notification updates the goal', async () => {
  const { api, target } = mountInspector();
  await nextTick();
  const objective = target.querySelector<HTMLTextAreaElement>('textarea[name="objective"]');
  if (!objective || !api.threadGoal.value) throw new Error('Missing fixture');
  objective.value = 'Unsaved revised objective';
  objective.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  api.threadGoal.value = { ...api.threadGoal.value, tokensUsed: 101 };
  await nextTick();
  expect(objective.value).toBe('Unsaved revised objective');
});

it.each(['usage', 'clear'])('preserves all dirty goal fields across a background %s update', async (update) => {
  const { api, target, activeThreadId } = mountInspector();
  await nextTick();
  const objective = target.querySelector<HTMLTextAreaElement>('textarea[name="objective"]');
  const budget = target.querySelector<HTMLInputElement>('input[name="tokenBudget"]');
  if (!objective || !budget || !api.threadGoal.value) throw new Error('Missing fixture');
  objective.value = 'Local objective';
  objective.dispatchEvent(new Event('input', { bubbles: true }));
  budget.value = '2500';
  budget.dispatchEvent(new Event('input', { bubbles: true }));
  target.querySelector<HTMLButtonElement>('.goal-status-dropdown button')?.click();
  await nextTick();
  Array.from(target.querySelectorAll<HTMLElement>('[role="option"]')).find(option => option.textContent?.trim() === 'Paused')?.click();
  await nextTick();
  api.threadGoal.value = update === 'clear' ? null : { ...api.threadGoal.value, tokensUsed: 101 };
  await nextTick();
  expect(objective.value).toBe('Local objective');
  expect(budget.value).toBe('2500');
  expect(target.querySelector('.goal-status-dropdown button')?.textContent).toContain('Paused');
  activeThreadId.value = 'thread-2';
  await nextTick();
  expect(objective.value).toBe('');
  expect(budget.value).toBe('');
});

it('hydrates a successful own save and clear after preserving a draft', async () => {
  const { api, target } = mountInspector();
  await nextTick();
  const objective = target.querySelector<HTMLTextAreaElement>('textarea[name="objective"]');
  if (!objective || !api.threadGoal.value) throw new Error('Missing fixture');
  objective.value = '  New goal  ';
  objective.dispatchEvent(new Event('input', { bubbles: true }));
  const goal = { ...api.threadGoal.value, objective: 'New goal' };
  vi.mocked(api.setThreadGoal).mockResolvedValueOnce({ goal });
  target.querySelector<HTMLButtonElement>('.goal-save')?.click();
  await vi.waitFor(() => expect(objective.value).toBe('New goal'));
  target.querySelector<HTMLButtonElement>('.goal-clear')?.click();
  await vi.waitFor(() => expect(objective.value).toBe(''));
});

import { createApp, nextTick, ref, type App } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CodexCollaborationModeManager from './CodexCollaborationModeManager.vue';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));

const apps: App[] = [];
function mountModes() {
  const api = {
    connected: ref(true),
    collaborationModesLoading: ref(false),
    collaborationModesError: ref<string | null>(null),
    collaborationModes: ref([
      { name: 'Plan', mode: 'plan', model: null, reasoningEffort: null },
      { name: 'Default', mode: 'default', model: null, reasoningEffort: null },
    ]),
    refreshCollaborationModes: vi.fn().mockResolvedValue({ data: [] }),
  };
  const selectedMode = ref('default');
  const onSelectMode = vi.fn((mode: string) => { selectedMode.value = mode; });
  const target = document.createElement('div');
  document.body.append(target);
  const app = createApp(CodexCollaborationModeManager, { api, modeSelection: { selectedMode, onSelectMode } });
  app.use(createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false }));
  app.mount(target);
  apps.push(app);
  return { api, target, selectedMode, onSelectMode };
}

afterEach(() => {
  apps.splice(0).forEach((app) => app.unmount());
  document.body.innerHTML = '';
});

describe('CodexCollaborationModeManager', () => {
  it('selects a mode and reflects later composer changes', async () => {
    const { target, selectedMode, onSelectMode } = mountModes();
    const plan = target.querySelector<HTMLButtonElement>('.codex-collaboration-mode-item');
    plan?.click();
    await nextTick();
    expect(onSelectMode).toHaveBeenCalledWith('plan');
    expect(plan?.getAttribute('aria-pressed')).toBe('true');
    selectedMode.value = 'default';
    await nextTick();
    expect(plan?.getAttribute('aria-pressed')).toBe('false');
    expect(target.querySelector('[aria-pressed="true"]')?.textContent).toContain('Default');
  });

  it('shows discovery failure instead of stale selectable modes', async () => {
    const { api, target } = mountModes();
    api.collaborationModesError.value = 'Method not found';
    await nextTick();
    expect(target.querySelector('[role="alert"]')?.textContent).toContain('Method not found');
    expect(target.querySelector('.codex-collaboration-mode-item')).toBeNull();
  });

  it('hides selectable modes after disconnection', async () => {
    const { api, target } = mountModes();
    api.connected.value = false;
    await nextTick();
    expect(target.querySelector('.codex-collaboration-mode-item')).toBeNull();
    expect(target.querySelector('button')?.disabled).toBe(true);
  });
});

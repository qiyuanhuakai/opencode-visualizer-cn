import { createApp, computed, nextTick, ref, type App } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODEX_PERMISSION_MODES } from '../../backends/codex/sessionControls';
import type { CodexSideChat as SideState } from '../../backends/codex/sideChat';
import CodexPermissionPicker from './CodexPermissionPicker.vue';
import CodexSideChat from './CodexSideChat.vue';
const apps: App[] = [];
function mount(app: App) {
  const target = document.createElement('div');
  document.body.append(target);
  app.use(createI18n({ legacy: false, locale: 'en', missingWarn: false, fallbackWarn: false }));
  app.mount(target);
  apps.push(app);
  return target;
}
async function flush() { await Promise.resolve(); await nextTick(); await Promise.resolve(); await nextTick(); }
afterEach(() => { apps.splice(0).forEach(app => app.unmount()); document.body.innerHTML = ''; });

function permissions() {
  const api = {
    connected: ref(true), permissionModes: computed(() => [...CODEX_PERMISSION_MODES]),
    selectedPermissionMode: ref('read-only'),
    setPermissionMode: vi.fn(async (id: string) => { api.selectedPermissionMode.value = id; }),
  };
  return { api, target: mount(createApp(CodexPermissionPicker, { api })) };
}
function side() {
  const api = {
    connected: ref(true),
    sideChat: ref<SideState | null>({ threadId: 'side', parentThreadId: 'main', messages: [], pending: false, error: '', turnId: '' }),
    startSideChat: vi.fn(async () => {}), sendSidePrompt: vi.fn(async () => {}), closeSideChat: vi.fn(async () => {}),
  };
  const onClose = vi.fn();
  return { api, onClose, target: mount(createApp(CodexSideChat, { api, onClose })) };
}
describe('Codex permission picker', () => {
  it('applies the selected mode and reflects server rejection', async () => {
    const { api, target } = permissions();
    target.querySelectorAll<HTMLButtonElement>('.command-option')[1]?.click();
    await flush();
    expect(api.setPermissionMode).toHaveBeenCalledWith('workspace-write');
    expect(target.querySelector('[aria-pressed="true"]')?.textContent).toContain('Workspace write');
    api.setPermissionMode.mockRejectedValueOnce(new Error('Server policy denied'));
    target.querySelectorAll<HTMLButtonElement>('.command-option')[2]?.click();
    await flush();
    expect(target.querySelector('[role="alert"]')?.textContent).toContain('Server policy denied');
    expect(api.selectedPermissionMode.value).toBe('workspace-write');
  });
  it('removes selectable modes while disconnected', async () => {
    const { api, target } = permissions(); api.connected.value = false; await nextTick();
    expect(target.querySelector('.command-option')).toBeNull();
    expect(target.textContent).toContain('Connect to Codex');
  });
});
describe('Codex side conversation', () => {
  it('sends only to the side branch and closes through the side lifecycle', async () => {
    const { api, target, onClose } = side();
    const input = target.querySelector('textarea');
    if (!input) throw new Error('Missing composer');
    input.value = 'Explain this'; input.dispatchEvent(new Event('input')); await nextTick();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await flush();
    expect(api.sendSidePrompt).toHaveBeenCalledWith('Explain this');
    expect(api.startSideChat).not.toHaveBeenCalled();
    expect(input.value).toBe('');
    target.querySelector<HTMLButtonElement>('button[type="button"]')?.click(); await flush();
    expect(api.closeSideChat).toHaveBeenCalledOnce(); expect(onClose).toHaveBeenCalledOnce();
  });
  it('preserves CJK composition and failed drafts; blocks sending during pending turn', async () => {
    const { api, target } = side();
    const input = target.querySelector('textarea');
    if (!input) throw new Error('Missing composer');
    input.value = '问题'; input.dispatchEvent(new Event('input')); await nextTick();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true })); await flush();
    expect(api.sendSidePrompt).not.toHaveBeenCalled();
    api.sendSidePrompt.mockRejectedValueOnce(new Error('Side request failed'));
    target.querySelector<HTMLButtonElement>('button[type="submit"]')?.click(); await flush();
    expect(input.value).toBe('问题');
    expect(target.querySelector('[role="alert"]')?.textContent).toContain('Side request failed');
    if (api.sideChat.value) api.sideChat.value.pending = true; await nextTick();
    expect(target.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(true);
    expect(target.querySelector<HTMLButtonElement>('button[type="button"]')?.disabled).toBe(false);
  });
});

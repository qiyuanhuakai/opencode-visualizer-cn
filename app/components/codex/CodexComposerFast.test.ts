import { createApp, nextTick, ref, type App } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CodexModel } from '../../backends/codex/codexAdapter';
import CodexComposerFast from './CodexComposerFast.vue';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
const apps: App[] = [];
function mountFast() {
  const selectedServiceTier = ref('default');
  const api = {
    selectedServiceTier, connected: ref(true),
    models: ref<CodexModel[]>([{ id: 'model', model: 'model', displayName: 'Model', serviceTiers: [{ id: 'fast', name: 'Fast', description: '' }] }]),
    setFastMode: vi.fn(async (enabled: boolean) => { selectedServiceTier.value = enabled ? 'fast' : 'default'; }),
  };
  const target = document.createElement('div');
  document.body.append(target);
  const onError = vi.fn();
  const app = createApp(CodexComposerFast, { api, onError });
  app.use(createI18n({ legacy: false, locale: 'en' }));
  app.mount(target);
  apps.push(app);
  const button = target.querySelector('button');
  if (!button) throw new Error('Fast button missing');
  return { api, button, onError };
}
afterEach(() => {
  apps.splice(0).forEach(app => app.unmount());
  document.body.innerHTML = '';
});
describe('Codex Fast toggle', () => {
  it('reflects the confirmed tier when clicked', async () => {
    const { api, button } = mountFast();
    button.click();
    await nextTick();
    expect(api.setFastMode).toHaveBeenCalledExactlyOnceWith(true);
    expect(button.getAttribute('aria-pressed')).toBe('true');
  });

  it('prevents duplicate writes while saving and retains state after rejection', async () => {
    const { api, button, onError } = mountFast();
    const write = Promise.withResolvers<void>();
    api.setFastMode.mockImplementation(() => write.promise);
    button.click();
    await nextTick();
    button.click();
    expect(api.setFastMode).toHaveBeenCalledTimes(1);
    expect(button.disabled).toBe(true);
    write.reject(new Error('Tier update failed'));
    await nextTick();
    await nextTick();
    expect(onError).toHaveBeenCalledWith('Tier update failed');
    expect(button.disabled).toBe(false);
    expect(button.getAttribute('aria-pressed')).toBe('false');
  });
});

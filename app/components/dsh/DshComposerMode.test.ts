import { afterEach, expect, it, vi } from 'vitest';
import { createApp, h, nextTick, reactive } from 'vue';
import { createI18n } from 'vue-i18n';
import DshComposerMode from './DshComposerMode.vue';
import en from '../../locales/en';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
const apps: ReturnType<typeof createApp>[] = [];
afterEach(() => { apps.splice(0).forEach(app => app.unmount()); document.body.innerHTML = ''; });

it('selects a session mode independently and disables selection after the first turn', async () => {
  const selected = vi.fn();
  const props = reactive({ current: 'standard', locked: false, options: [
    { id: 'standard', label: 'Standard mode', description: 'Search and editing tools' },
    { id: 'ptc', label: 'PTC mode', description: 'Batch tool execution' },
  ] });
  const root = document.createElement('div'); document.body.append(root);
  const app = createApp({ render: () => h(DshComposerMode, { ...props, onSelect: selected }) });
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en } })); app.mount(root); apps.push(app);
  root.querySelector<HTMLButtonElement>('button')?.click(); await nextTick();
  const target = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(option => option.textContent?.includes('PTC mode'));
  expect(target?.textContent).toContain('Batch tool execution');
  target?.click(); await nextTick();
  expect(selected).toHaveBeenCalledWith('ptc');
  props.locked = true; await nextTick();
  expect(root.querySelector<HTMLButtonElement>('button')?.disabled).toBe(true);
  expect(root.querySelector('[title]')?.getAttribute('title')).toBe(en.inputPanel.dshPresetLocked);
});

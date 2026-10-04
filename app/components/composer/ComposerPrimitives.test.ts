import { createApp, defineComponent, h, nextTick, ref, type App } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ComposerDropdown from './ComposerDropdown.vue';
import ComposerToggle from './ComposerToggle.vue';
import ComposerGoal from './ComposerGoal.vue';
import DropdownItem from '../Dropdown/Item.vue';
import en from '../../locales/en';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
const apps: App[] = [];
afterEach(() => { apps.splice(0).forEach(app => app.unmount()); document.body.replaceChildren(); });
async function mount(component: ReturnType<typeof defineComponent>) {
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp(component);
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
  apps.push(app); app.mount(host);
  await nextTick();
  return host;
}

describe('composer presentation contracts', () => {
  it('forwards value slot, keyboard selection, controlled open, selection and highlight events', async () => {
    const value = ref('first'); const open = ref(false);
    const select = vi.fn(); const highlight = vi.fn();
    const host = await mount(defineComponent({ setup: () => () => h(ComposerDropdown, {
      modelValue: value.value, open: open.value, autoClose: true,
      'onUpdate:modelValue': (next: unknown) => { if (typeof next === 'string') value.value = next; },
      'onUpdate:open': (next: boolean) => { open.value = next; },
      onSelect: select, 'onHighlight-change': highlight,
    }, {
      value: ({ value }: { value: string }) => `Selected ${value}`,
      default: () => ['first', 'second'].map(option => h(DropdownItem, { value: option }, () => option)),
    }) }));
    const button = host.querySelector('button');
    button?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await nextTick(); await nextTick();
    expect(open.value).toBe(true);
    button?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    button?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await nextTick(); await nextTick();
    expect(value.value).toBe('second'); expect(select).toHaveBeenCalledExactlyOnceWith('second');
    expect(open.value).toBe(false); expect(highlight).toHaveBeenCalled();
    expect(button?.textContent).toContain('Selected second');
  });

  it('keeps independent choices open and forwards dialog role, autofocus and label slot', async () => {
    const open = ref(false);
    const host = await mount(defineComponent({ setup: () => () => h(ComposerDropdown, {
      open: open.value, 'onUpdate:open': (next: boolean) => { open.value = next; },
      controlRole: 'settings', menuWidth: 312, label: 'Settings', menuRole: 'dialog', autoFocus: false, autoClose: false,
      buttonClass: 'custom-trigger', title: 'Settings title',
    }, { label: () => 'Custom settings', default: () => h(DropdownItem, { value: 'plan' }, () => 'plan') }) }));
    const button = host.querySelector<HTMLButtonElement>('button');
    button?.focus(); button?.click(); await nextTick(); await nextTick();
    expect(document.activeElement).toBe(button);
    expect(button?.textContent).toContain('Custom settings');
    expect(host.querySelector('[role="dialog"]')?.getAttribute('aria-label')).toBe('Settings');
    host.querySelector<HTMLElement>('[role="option"]')?.click(); await nextTick();
    expect(open.value).toBe(true);
    button?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await nextTick();
    expect(open.value).toBe(false);
  });

  it('blocks a busy toggle while retaining its confirmed active state', async () => {
    const busy = ref(true); const click = vi.fn();
    const host = await mount(defineComponent({ setup: () => () => h(ComposerToggle, { active: true, busy: busy.value, onClick: click }, () => 'Fast') }));
    const button = host.querySelector<HTMLButtonElement>('button');
    expect(button?.getAttribute('aria-pressed')).toBe('true');
    expect(button?.getAttribute('aria-busy')).toBe('true');
    expect(button?.disabled).toBe(true); button?.click(); expect(click).not.toHaveBeenCalled();
    busy.value = false; await nextTick(); button?.click(); expect(click).toHaveBeenCalledOnce();
  });

  it('exposes the full goal and announces failures without losing its open action', async () => {
    const summary = 'A complete multiline objective with a long final sentence'; const open = vi.fn();
    const host = await mount(defineComponent({ setup: () => () => h(ComposerGoal, { label: 'Goal', summary, error: true, onOpen: open }) }));
    const button = host.querySelector<HTMLButtonElement>('button');
    expect(button?.getAttribute('aria-label')).toBe(`Goal: ${summary}`);
    expect(button?.title).toBe(`Goal: ${summary}`);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(summary);
    button?.click(); expect(open).toHaveBeenCalledOnce();
  });
});

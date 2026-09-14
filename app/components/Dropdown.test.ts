import { createApp, defineComponent, h, nextTick, ref } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Dropdown from './Dropdown.vue';
import DropdownItem from './Dropdown/Item.vue';
import en from '../locales/en';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));

const mountedApps: Array<() => void> = [];

afterEach(() => {
  while (mountedApps.length > 0) mountedApps.pop()?.();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function installDropdownApp(root: HTMLElement, component: ReturnType<typeof defineComponent>) {
  const app = createApp(component);
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
  app.mount(root);
  mountedApps.push(() => app.unmount());
}

describe('Dropdown interactions', () => {
  it('opens, navigates, and selects a candidate with the keyboard', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const selected = ref('first');
    installDropdownApp(
      root,
      defineComponent({
        setup() {
          return () =>
            h(
              Dropdown,
              {
                autoClose: true,
                modelValue: selected.value,
                'onUpdate:modelValue': (value: unknown) => {
                  if (typeof value === 'string') selected.value = value;
                },
              },
              {
                default: () => [
                  h(DropdownItem, { value: 'first' }, () => 'First'),
                  h(DropdownItem, { value: 'second' }, () => 'Second'),
                  h(DropdownItem, { value: 'third' }, () => 'Third'),
                ],
              },
            );
        },
      }),
    );
    await nextTick();

    const button = root.querySelector<HTMLButtonElement>('.ui-dropdown-button');
    expect(button).not.toBeNull();
    button?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    await nextTick();
    await nextTick();
    expect(root.querySelector('.ui-dropdown-menu')?.classList.contains('is-open')).toBe(true);

    button?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    button?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await nextTick();
    await nextTick();

    expect(selected.value).toBe('second');
    expect(root.querySelector('.ui-dropdown-menu')?.classList.contains('is-open')).toBe(false);
  });

  it('selects the clicked candidate and updates the visible value', async () => {
    const root = document.createElement('div');
    document.body.append(root);
    const selected = ref('first');
    installDropdownApp(
      root,
      defineComponent({
        setup() {
          return () =>
            h(
              Dropdown,
              {
                modelValue: selected.value,
                'onUpdate:modelValue': (value: unknown) => {
                  if (typeof value === 'string') selected.value = value;
                },
              },
              {
                default: () => [
                  h(DropdownItem, { value: 'first' }, () => 'First'),
                  h(DropdownItem, { value: 'second' }, () => 'Second'),
                ],
              },
            );
        },
      }),
    );
    await nextTick();

    const options = root.querySelectorAll<HTMLElement>('.ui-input-candidate-item');
    options.item(1).click();
    await nextTick();

    expect(selected.value).toBe('second');
    expect(root.querySelector('.ui-dropdown-button')?.textContent).toContain('second');
  });
});

describe('Dropdown candidate updates', () => {
  it.each([20, 200])(
    'coalesces %i item mounts into a bounded positive scan count',
    async (count) => {
      const original = Element.prototype.querySelectorAll;
      const candidateScans = vi.fn();
      vi.spyOn(Element.prototype, 'querySelectorAll').mockImplementation(
        function (this: Element, selector) {
          if (String(selector).includes('.ui-input-candidate-item[data-value]')) candidateScans();
          return original.call(this, selector);
        },
      );
      const root = document.createElement('div');
      document.body.append(root);
      installDropdownApp(
        root,
        defineComponent({
          setup() {
            return () =>
              h(Dropdown, null, {
                default: () =>
                  Array.from({ length: count }, (_, index) =>
                    h(DropdownItem, { value: { id: index } }, () => `Item ${index}`),
                  ),
              });
          },
        }),
      );

      await nextTick();
      await nextTick();

      expect(candidateScans.mock.calls.length).toBeGreaterThan(0);
      expect(candidateScans.mock.calls.length).toBeLessThanOrEqual(2);
    },
  );
});

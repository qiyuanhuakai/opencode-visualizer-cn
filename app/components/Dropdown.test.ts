import { createApp, defineComponent, h, nextTick } from 'vue';
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
  document.body.innerHTML = '';
});

describe('Dropdown candidate updates', () => {
  it('coalesces item mount updates into one candidate scan per Vue flush', async () => {
    const original = Element.prototype.querySelectorAll;
    const candidateScans = vi.fn();
    vi.spyOn(Element.prototype, 'querySelectorAll').mockImplementation(function (
      this: Element,
      selector,
    ) {
      if (String(selector).includes('.ui-input-candidate-item[data-value]')) candidateScans();
      return original.call(this, selector);
    });
    const root = document.createElement('div');
    document.body.appendChild(root);
    const app = createApp(
      defineComponent({
        setup() {
          return () => h(Dropdown, null, {
            default: () => Array.from({ length: 20 }, (_, index) =>
              h(DropdownItem, { value: { id: index } }, () => `Item ${index}`)),
          });
        },
      }),
    );
    app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
    app.mount(root);
    mountedApps.push(() => app.unmount());

    await nextTick();
    await nextTick();

    expect(candidateScans.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

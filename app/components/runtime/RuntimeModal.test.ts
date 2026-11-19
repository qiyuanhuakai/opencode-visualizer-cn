import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, h, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import MigrationWizard from './MigrationWizard.vue';
import ThreadView from './ThreadView.vue';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); vi.restoreAllMocks(); });

describe('runtime modal lifecycle', () => {
  for (const surface of ['thread', 'migration']) {
    it(`opens ${surface} modally when mounted open and allows Escape to close it`, async () => {
      const show = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
      const closed = vi.fn();
      const root = document.createElement('div'); document.body.appendChild(root);
      const app = createApp({ render: () => surface === 'thread'
        ? h(ThreadView, { open: true, variant: 'panel', thread: null, targets: [], handoff: null, onClose: closed })
        : h(MigrationWizard, { open: true, inventory: { revision: 'empty', sources: [] }, onClose: closed }) });
      app.use(createI18n({ legacy: false, locale: 'en', messages: { en: {} }, missingWarn: false, fallbackWarn: false }));
      app.mount(root); await nextTick(); await nextTick();
      cleanups.push(() => { app.unmount(); root.remove(); });
      const dialog = root.querySelector('dialog');
      if (!dialog) throw new Error('Missing modal dialog');
      expect(show).toHaveBeenCalledOnce();
      expect(dialog.open).toBe(true);
      expect(dialog.getAttribute('aria-label')).toBeTruthy();
      const event = new Event('cancel', { cancelable: true });
      dialog.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
      expect(closed).toHaveBeenCalledOnce();
    });
  }
});

import { afterEach, describe, expect, it } from 'vitest';
import { createApp, nextTick, type App as VueApp } from 'vue';
import { createI18n } from 'vue-i18n';
import { useCodexApi } from '../composables/useCodexApi';
import { StorageKeys, storageRemove } from '../utils/storageKeys';
import CodexPanel from './CodexPanel.vue';

const apps: VueApp[] = [];

afterEach(() => {
  apps.splice(0).forEach((app) => app.unmount());
  document.body.innerHTML = '';
  storageRemove(StorageKeys.state.codexActiveThread);
});

function mountPanel(api: ReturnType<typeof useCodexApi>) {
  const target = document.createElement('div');
  document.body.append(target);
  const app = createApp(CodexPanel, { api });
  app.use(
    createI18n({
      legacy: false,
      locale: 'en',
      missingWarn: false,
      fallbackWarn: false,
      messages: { en: {} },
    }),
  );
  apps.push(app);
  app.mount(target);
  return target;
}

describe('CodexPanel', () => {
  it('disables cached thread selection while disconnected', () => {
    // Given: cached thread metadata remains after the transport disconnects
    const api = useCodexApi();
    api.reconnectOnMount.value = false;
    api.threads.value = [{ id: 'thread-1', name: 'Cached thread', cwd: '/workspace' }];
    api.activeThreadId.value = 'thread-1';

    // When: the disconnected panel renders that cached state
    const target = mountPanel(api);

    // Then: stale adapter actions are unavailable
    const threadButton = target.querySelector<HTMLButtonElement>('.codex-thread-select');
    expect(threadButton?.disabled).toBe(true);
  });

  it('enables cached thread selection after the transport reconnects', async () => {
    // Given: the panel renders cached thread metadata while disconnected
    const api = useCodexApi();
    api.reconnectOnMount.value = false;
    api.threads.value = [{ id: 'thread-1', name: 'Cached thread', cwd: '/workspace' }];
    const target = mountPanel(api);

    // When: the transport reconnects without an active loading operation
    api.initialized.value = true;
    api.status.value = 'connected';
    await nextTick();

    // Then: thread selection becomes available again
    const threadButton = target.querySelector<HTMLButtonElement>('.codex-thread-select');
    expect(threadButton?.disabled).toBe(false);
  });
});

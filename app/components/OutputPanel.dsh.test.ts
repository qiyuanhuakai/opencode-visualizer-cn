import { createApp, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import en from '../locales/en';
import { useMessages } from '../composables/useMessages';
import { makeUserHistoryEntry } from './historyTestBuilders';
import OutputPanel from './OutputPanel.vue';

vi.mock('../utils/workerRenderer', () => ({
  startRenderWorkerHtml: () => ({ promise: Promise.resolve(''), cancel: () => {} }),
  RenderCancelledError: class RenderCancelledError extends Error {},
}));
vi.mock('../composables/useFileTree', async () => {
  const { ref } = await import('vue');
  return { useFileTree: () => ({ files: ref<string[]>([]) }) };
});
vi.mock('@iconify/vue', () => ({ Icon: { template: '<span />' } }));

beforeEach(() => {
  useMessages().reset();
});

function mountPanel(isThinking: boolean) {
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp(OutputPanel, {
    isFollowing: true,
    isAnchoring: false,
    statusText: '',
    isStatusError: false,
    isThinking,
    theme: 'github-dark',
    currentSessionId: 'root-session',
    backendKind: 'dsh',
  });
  app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
  app.provide('showConfirm', async () => true);
  app.mount(host);
  return { app, host };
}

async function flushRender() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
  await nextTick();
}

afterEach(() => {
  document.body.replaceChildren();
});

it('disables dsh card actions while the turn is thinking', async () => {
  useMessages().loadHistory([makeUserHistoryEntry(1)]);
  const { app, host } = mountPanel(true);
  try {
    await flushRender();
    const fork = host.querySelector<HTMLButtonElement>('.ib-top-right');
    expect(fork).not.toBeNull();
    expect(fork?.disabled).toBe(true);
  } finally {
    app.unmount();
  }
});

it('keeps dsh card actions enabled when the turn is idle', async () => {
  useMessages().loadHistory([makeUserHistoryEntry(2)]);
  const { app, host } = mountPanel(false);
  try {
    await flushRender();
    const fork = host.querySelector<HTMLButtonElement>('.ib-top-right');
    expect(fork).not.toBeNull();
    expect(fork?.disabled).toBe(false);
  } finally {
    app.unmount();
  }
});

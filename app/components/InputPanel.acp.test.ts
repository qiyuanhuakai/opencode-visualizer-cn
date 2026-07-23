import { createApp, nextTick } from 'vue';
import { createI18n } from 'vue-i18n';
import { afterEach, describe, expect, it } from 'vitest';
import InputPanel from './InputPanel.vue';
import en from '../locales/en';

describe('InputPanel ACP controls', () => {
  let host: HTMLDivElement | undefined;

  afterEach(() => {
    host?.remove();
    host = undefined;
  });

  it('shows permission policies separately and prefers file paths for @ completion', async () => {
    host = document.createElement('div');
    document.body.append(host);
    const app = createApp(InputPanel, {
      messageInput: '@src',
      canSend: true,
      selectedMode: 'default',
      selectedPermissionMode: 'acceptEdits',
      permissionModeOptions: [
        { id: 'normal', label: 'Normal' },
        { id: 'acceptEdits', label: 'Accept Edits' },
      ],
      agentOptions: [{ id: 'default', label: 'Default' }],
      subagentOptions: [],
      mentionFiles: ['src/auth.ts', 'docs/guide.md'],
      preferFileMentions: true,
      hasAgentOptions: true,
      selectedModel: 'acp/model',
      selectedThinking: undefined,
      modelOptions: [{ id: 'acp/model', modelID: 'model', label: 'Model', displayName: 'Model' }],
      thinkingOptions: [undefined],
      hasModelOptions: true,
      hasThinkingOptions: true,
      isThinking: false,
      canAbort: false,
      commands: [],
      attachments: [],
    });
    app.use(createI18n({ legacy: false, locale: 'en', messages: { en } }));
    app.mount(host);
    await nextTick();

    expect(host.querySelector('[title="Permission policy"]')).not.toBeNull();
    expect(host.textContent).toContain('@src/auth.ts');
    expect(host.textContent).not.toContain('@Default');
    app.unmount();
  });
});

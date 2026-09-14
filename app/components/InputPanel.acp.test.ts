import { nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupInputPanelFixtures, mountInputPanel } from './inputPanel.test-helpers';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));

describe('InputPanel ACP controls', () => {
  afterEach(() => {
    cleanupInputPanelFixtures();
  });

  it('shows permission policies separately and prefers file paths for @ completion', async () => {
    const { root } = mountInputPanel({
      messageInput: '@src',
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
      selectedModel: 'acp/model',
      modelOptions: [{ id: 'acp/model', modelID: 'model', label: 'Model', displayName: 'Model' }],
    });
    await nextTick();

    expect(root.querySelector('[title="Permission policy"]')).not.toBeNull();
    expect(root.textContent).toContain('@src/auth.ts');
    expect(root.textContent).not.toContain('@Default');
  });
});

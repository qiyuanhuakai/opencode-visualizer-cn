import { nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupInputPanelFixtures, mountInputPanel } from './inputPanel.test-helpers';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));

describe('InputPanel ACP controls', () => {
  afterEach(() => {
    cleanupInputPanelFixtures();
  });

  it('shows the ACP permission policy in the left agent position and prefers file paths for @ completion', async () => {
    const { root } = mountInputPanel({
      messageInput: '@src',
      acpPermissionControls: true,
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

    const selectors = root.querySelectorAll('.input-selects > .input-field');
    expect(selectors).toHaveLength(1);
    expect(selectors[0]?.querySelector('[title="Permission policy"]')?.textContent).toContain('Accept Edits');
    expect(root.querySelector('[title="Agent (Tab)"]')).toBeNull();
    expect(root.textContent).toContain('@src/auth.ts');
    expect(root.textContent).not.toContain('@Default');
  });

  it('keeps the ACP permission selector visible when the agent advertises only one policy', async () => {
    const { root } = mountInputPanel({
      acpPermissionControls: true,
      selectedMode: 'default',
      selectedPermissionMode: 'default',
      permissionModeOptions: [{ id: 'default', label: 'Default' }],
      agentOptions: [{ id: 'default', label: 'Default' }],
      selectedModel: 'acp/default',
      modelOptions: [{ id: 'acp/default', modelID: 'default', label: 'Agent default', displayName: 'Agent default' }],
    });
    await nextTick();

    expect(root.querySelector('[title="Permission policy"]')?.textContent).toContain('Default');
    expect(root.querySelector('[title="Agent (Tab)"]')).toBeNull();
  });

  it('offers a right-side Plan toggle only when the ACP agent advertises Plan', async () => {
    const onTogglePlan = vi.fn();
    const { root } = mountInputPanel({
      acpPermissionControls: true,
      planModeAvailable: true,
      onTogglePlan,
      selectedMode: 'default',
      selectedPermissionMode: 'auto',
      permissionModeOptions: [
        { id: 'default', label: 'Default' },
        { id: 'auto', label: 'Auto' },
      ],
    });
    await nextTick();

    const toggle = root.querySelector<HTMLButtonElement>('button[aria-label="Plan mode"]');
    expect(toggle?.getAttribute('aria-pressed')).toBe('false');
    toggle?.click();
    expect(onTogglePlan).toHaveBeenCalledWith(true);
    expect(root.querySelector('[title="Permission policy"]')?.textContent).toContain('Auto');
  });

});

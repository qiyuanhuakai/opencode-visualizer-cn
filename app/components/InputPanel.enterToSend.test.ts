import { nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TextTransformer } from '../utils/textTransformers';
import {
  cleanupInputPanelFixtures,
  mountInputPanel as mountSharedInputPanel,
} from './inputPanel.test-helpers';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
const settings = vi.hoisted(() => ({
  enterToSend: { value: true, __v_isRef: true },
  textTransformersEnabled: { value: false, __v_isRef: true },
  textTransformers: { value: [] as TextTransformer[], __v_isRef: true },
}));
vi.mock('../composables/useSettings', () => ({
  useSettings: () => settings,
}));

function mountInputPanel(messageInput: string) {
  const onSend = vi.fn();
  const { root } = mountSharedInputPanel({
    messageInput,
    commands: [{ name: 'goal' }],
    onSend,
  });
  return { root, onSend };
}

function pressEnter(root: HTMLElement, options: { ctrlKey?: boolean } = {}) {
  const event = new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    cancelable: true,
    ctrlKey: options.ctrlKey ?? false,
  });
  root.querySelector('textarea')?.dispatchEvent(event);
  return event;
}

afterEach(() => {
  cleanupInputPanelFixtures();
  settings.enterToSend.value = true;
  document.body.innerHTML = '';
});

describe('InputPanel enterToSend setting', () => {
  it('does not send a recognized slash command on Enter when enterToSend is disabled', async () => {
    // Given: enter-to-send is off and the input holds a recognized slash command.
    settings.enterToSend.value = false;
    const { root, onSend } = mountInputPanel('/goal ship it');
    await nextTick();

    // When: Enter is pressed without modifiers.
    const event = pressEnter(root);
    await nextTick();

    // Then: no send fires and the newline default is preserved.
    expect(onSend).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('sends a recognized slash command on Enter when enterToSend is enabled', async () => {
    // Given: enter-to-send is on and the input holds a recognized slash command.
    settings.enterToSend.value = true;
    const { root, onSend } = mountInputPanel('/goal ship it');
    await nextTick();

    // When: Enter is pressed without modifiers.
    const event = pressEnter(root);
    await nextTick();

    // Then: the command is sent and the newline default is suppressed.
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('still sends on Ctrl+Enter when enterToSend is disabled', async () => {
    // Given: enter-to-send is off and the input holds a recognized slash command.
    settings.enterToSend.value = false;
    const { root, onSend } = mountInputPanel('/goal ship it');
    await nextTick();

    // When: Ctrl+Enter is pressed.
    const event = pressEnter(root, { ctrlKey: true });
    await nextTick();

    // Then: the always-send shortcut still fires.
    expect(onSend).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });
});

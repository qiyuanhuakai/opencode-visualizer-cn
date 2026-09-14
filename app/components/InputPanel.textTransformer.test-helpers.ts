import { nextTick, toRef } from 'vue';
import { afterEach, beforeEach, vi } from 'vitest';

import {
  cleanupInputPanelFixtures,
  mountInputPanel as mountSharedInputPanel,
} from './inputPanel.test-helpers';

const mockedSettings = vi.hoisted(() => ({
  enterToSend: { value: true, __v_isRef: true },
  textTransformersEnabled: { value: true, __v_isRef: true },
  textTransformers: {
    value: [
      {
        id: 'snippet-hi',
        trigger: 'hi',
        name: 'Greeting',
        body: '你好',
        description: 'Friendly greeting',
        enabled: true,
        tags: ['Common'],
      },
    ],
    __v_isRef: true,
  },
}));

export const settings = mockedSettings;

vi.mock('@iconify/vue', () => ({ Icon: () => null }));
vi.mock('../composables/useSettings', () => ({ useSettings: () => mockedSettings }));

const initialClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');

export function mountInputPanel(
  options: {
    readonly commands?: readonly { readonly name: string; readonly description?: string }[];
  } = {},
) {
  const send = vi.fn();
  const statusError = vi.fn();
  const mounted = mountSharedInputPanel({
    commands: options.commands ? [...options.commands] : [],
    currentSessionId: 'session-a',
    activeDirectory: '/repo',
    activeFile: '/repo/src/main.ts',
    onSend: send,
    onStatusError: statusError,
    'onUpdate:messageInput': (value: string) => {
      mounted.props.messageInput = value;
    },
  });
  return {
    root: mounted.root,
    message: toRef(mounted.props, 'messageInput'),
    send,
    statusError,
    currentSessionId: toRef(mounted.props, 'currentSessionId'),
    activeDirectory: toRef(mounted.props, 'activeDirectory'),
    activeFile: toRef(mounted.props, 'activeFile'),
  };
}

export async function typeInto(textarea: HTMLTextAreaElement, value: string) {
  textarea.value = value;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  textarea.setSelectionRange(value.length, value.length);
}

export function press(textarea: HTMLTextAreaElement, key: string, isComposing = false) {
  const event = new KeyboardEvent('keydown', {
    key,
    isComposing,
    bubbles: true,
    cancelable: true,
  });
  textarea.dispatchEvent(event);
  return event;
}

export function release(textarea: HTMLTextAreaElement, key: string) {
  const event = new KeyboardEvent('keyup', { key, bubbles: true });
  textarea.dispatchEvent(event);
  return event;
}

beforeEach(() => {
  settings.enterToSend.value = true;
  settings.textTransformersEnabled.value = true;
  settings.textTransformers.value = [
    {
      id: 'snippet-hi',
      trigger: 'hi',
      name: 'Greeting',
      body: '你好',
      description: 'Friendly greeting',
      enabled: true,
      tags: ['Common'],
    },
  ];
});

afterEach(() => {
  try {
    cleanupInputPanelFixtures();
  } finally {
    Reflect.deleteProperty(window, 'electronAPI');
    if (initialClipboardDescriptor) {
      Object.defineProperty(navigator, 'clipboard', initialClipboardDescriptor);
    } else {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  }
});

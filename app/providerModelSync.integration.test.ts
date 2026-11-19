import { nextTick } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountCodexApp } from './test/appHarness';

const mountedApps: Array<{ readonly unmount: () => void }> = [];

afterEach(() => {
  mountedApps.splice(0).forEach(({ unmount }) => unmount());
});

async function selectComposerModel(host: HTMLElement, modelId: string) {
  const trigger = host.querySelector<HTMLButtonElement>(
    '.input-dropdown-root .input-dropdown-button',
  );
  expect(trigger).toBeInstanceOf(HTMLButtonElement);
  trigger?.click();
  await nextTick();
  const option = Array.from(
    host.querySelectorAll<HTMLElement>('.input-dropdown-root .ui-input-candidate-item'),
  ).find((candidate) => candidate.getAttribute('data-value') === JSON.stringify(modelId));
  expect(option).toBeInstanceOf(HTMLElement);
  option?.click();
  await nextTick();
}

async function enterAndSend(host: HTMLElement, text: string) {
  const textarea = host.querySelector<HTMLTextAreaElement>('.input-textarea');
  const send = host.querySelector<HTMLButtonElement>('.send-button');
  expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
  expect(send).toBeInstanceOf(HTMLButtonElement);
  if (!textarea) return;
  textarea.value = text;
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
  send?.click();
}

describe('App Codex provider model binding', () => {
  it('Given a mounted Codex App with an openai thread, When the user sends with official then custom models through the composer, Then official reuses the openai thread while custom starts a fresh thread', async () => {
    const fixture = await mountCodexApp();
    mountedApps.push(fixture);

    await selectComposerModel(fixture.host, 'openai/official-model');
    await enterAndSend(fixture.host, 'official provider message');
    await vi.waitFor(() =>
      expect(fixture.codexAdapterSendPrompt).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'official provider message', threadId: 'thread-openai' }),
      ),
    );
    expect(fixture.codexSendPrompt).toHaveBeenCalledWith(
      'official provider message',
      expect.objectContaining({ forceNewThread: false, threadId: 'thread-openai' }),
    );

    await selectComposerModel(fixture.host, 'custom-provider/custom-model');
    await enterAndSend(fixture.host, 'custom provider message');
    await vi.waitFor(() => expect(fixture.codexAdapterSendPrompt).toHaveBeenCalledTimes(2));
    expect(fixture.codexBatchWriteConfig).toHaveBeenLastCalledWith({
      edits: [
        { keyPath: 'model_provider', value: 'custom-provider', mergeStrategy: 'replace' },
        { keyPath: 'model', value: 'custom-model', mergeStrategy: 'replace' },
      ],
    });
    expect(fixture.codexSendPrompt).toHaveBeenLastCalledWith(
      'custom provider message',
      expect.objectContaining({ forceNewThread: true, threadId: undefined }),
    );
    const customInput = fixture.codexAdapterSendPrompt.mock.calls[1]?.[0];
    expect(customInput).toMatchObject({ text: 'custom provider message' });
    expect(customInput).not.toHaveProperty('threadId');
  });
});

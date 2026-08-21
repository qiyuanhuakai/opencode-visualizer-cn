import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useBackendMessageSend } from './useBackendMessageSend';
import { createBaseParams, createCodexApi } from './useBackendMessageSend.test-helpers';

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function imageAttachment() {
  return {
    id: 'image',
    filename: 'image.png',
    mime: 'image/png',
    dataUrl: 'data:image/png;base64,AA==',
  };
}

describe('useBackendMessageSend behavior', () => {
  it('orders sending status before backend dispatch', async () => {
    const events: string[] = [];
    const base = createBaseParams();
    base.enableFollow = vi.fn(() => {
      events.push('follow');
    });
    base.setSendStatusKey = vi.fn((key: string) => {
      events.push(key);
    });
    const sendPromptAsync = vi.fn().mockImplementation(() => {
      events.push('dispatch');
      return Promise.resolve();
    });
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('opencode'),
      openCodeApi: { sendPromptAsync },
      codexApi: createCodexApi(),
    });

    await runtime.sendMessage();

    expect(events).toEqual(['follow', 'app.status.sending', 'dispatch', 'app.status.sent']);
  });

  it('runs Codex local commands without resolving a prompt model', async () => {
    const base = createBaseParams();
    base.messageInput.value = '/debug inspect';
    base.parseProviderModelKey = vi.fn(() => {
      throw new Error('prompt model should not be resolved');
    });
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('codex'),
      openCodeApi: { sendPromptAsync: vi.fn() },
      codexApi: createCodexApi(),
    });

    await runtime.sendMessage();

    expect(base.parseProviderModelKey).not.toHaveBeenCalled();
    expect(base.setSendStatusText).toHaveBeenCalledWith('inspect');
  });

  it('expands transformers before resolving a stale session fallback', async () => {
    const events: string[] = [];
    const base = createBaseParams();
    base.selectedSessionId.value = 'stale-session';
    base.filteredSessions.value = [{ id: 'fallback-session' }];
    base.textTransformersEnabled.value = true;
    base.messageInput.value = String.raw`Say \hi`;
    base.textTransformers.value = [
      {
        trigger: 'hi',
        get replacement() {
          events.push('transform');
          return 'hello';
        },
      },
    ];
    base.pickPreferredSessionId = (sessions) => {
      events.push('fallback');
      return sessions[0]?.id || '';
    };
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('opencode'),
      openCodeApi: { sendPromptAsync: vi.fn().mockResolvedValue(undefined) },
      codexApi: createCodexApi(),
    });

    await runtime.sendMessage();

    expect(events.slice(0, 2)).toEqual(['transform', 'fallback']);
  });

  it('retains unsupported Codex attachments and reports the attachment error', async () => {
    const base = createBaseParams();
    base.attachments.value = [{ ...imageAttachment(), mime: 'text/plain' }];
    const codexApi = createCodexApi();
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('codex'),
      openCodeApi: { sendPromptAsync: vi.fn() },
      codexApi,
    });

    await runtime.sendMessage();

    expect(codexApi.sendPrompt).not.toHaveBeenCalled();
    expect(base.attachments.value).toHaveLength(1);
    expect(base.setSendStatusKey).toHaveBeenLastCalledWith('app.error.unsupportedAttachment');
    expect(base.isSending.value).toBe(false);
  });

  it('retains Codex attachments when thread refresh fails', async () => {
    const base = createBaseParams();
    base.attachments.value = [imageAttachment()];
    const codexApi = createCodexApi();
    codexApi.refreshThreads = vi.fn().mockRejectedValue(new Error('refresh failed'));
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('codex'),
      openCodeApi: { sendPromptAsync: vi.fn() },
      codexApi,
    });

    await runtime.sendMessage();

    expect(codexApi.sendPrompt).toHaveBeenCalledTimes(1);
    expect(base.attachments.value).toHaveLength(1);
    expect(base.setSendStatusKey).toHaveBeenLastCalledWith('app.error.sendFailed', {
      message: 'Error: refresh failed',
    });
    expect(base.isSending.value).toBe(false);
  });

  it('retains attachments after a successful OpenCode command', async () => {
    const base = createBaseParams();
    base.messageInput.value = '/fix issue';
    base.attachments.value = [imageAttachment()];
    const sendCommand = vi.fn().mockResolvedValue(undefined);
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('opencode'),
      openCodeApi: { sendPromptAsync: vi.fn() },
      codexApi: createCodexApi(),
      sendCommand,
    });

    await runtime.sendMessage();

    expect(sendCommand).toHaveBeenCalledWith('session-1', { name: 'fix' }, 'issue');
    expect(base.attachments.value).toHaveLength(1);
    expect(base.clearComposerDraftForCurrentContext).toHaveBeenCalledTimes(1);
  });

  it('keeps ACP isSending true while prompt is pending', async () => {
    const pending = deferred<unknown>();
    const sendPromptAsync = vi.fn().mockReturnValue(pending.promise);
    const base = createBaseParams();
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('acp'),
      openCodeApi: { sendPromptAsync },
      codexApi: createCodexApi(),
    });

    const sending = runtime.sendMessage();
    await vi.waitFor(() => expect(sendPromptAsync).toHaveBeenCalledTimes(1));
    expect(base.isSending.value).toBe(true);
    pending.resolve(undefined);
    await sending;
    expect(base.isSending.value).toBe(false);
  });

  it('retains attachments after an OpenCode prompt rejection', async () => {
    const base = createBaseParams();
    base.attachments.value = [imageAttachment()];
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('opencode'),
      openCodeApi: { sendPromptAsync: vi.fn().mockRejectedValue(new Error('rejected')) },
      codexApi: createCodexApi(),
    });

    await runtime.sendMessage();

    expect(base.attachments.value).toHaveLength(1);
    expect(base.setSendStatusKey).toHaveBeenLastCalledWith('app.error.sendFailed', {
      message: 'Error: rejected',
    });
    expect(base.isSending.value).toBe(false);
  });
});

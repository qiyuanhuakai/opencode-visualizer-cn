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

  it('preserves unconfirmed snippet triggers while resolving a stale session fallback', async () => {
    // Given: an unconfirmed trigger is present and the selected session is stale.
    const events: string[] = [];
    const base = createBaseParams();
    base.selectedSessionId.value = 'stale-session';
    base.filteredSessions.value = [{ id: 'fallback-session' }];
    base.textTransformersEnabled.value = true;
    base.messageInput.value = String.raw`Say \hi`;
    base.textTransformers.value = [
      {
        id: 'snippet-hi',
        trigger: 'hi',
        name: 'Greeting',
        get body() {
          events.push('transform');
          return 'hello';
        },
        enabled: true,
        tags: [],
      },
    ];
    base.pickPreferredSessionId = (sessions) => {
      events.push('fallback');
      return sessions[0]?.id || '';
    };
    const sendPromptAsync = vi.fn().mockResolvedValue(undefined);
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('opencode'),
      openCodeApi: { sendPromptAsync },
      codexApi: createCodexApi(),
    });

    // When: the message crosses the backend send boundary.
    await runtime.sendMessage();

    // Then: session recovery runs without reading or expanding the snippet body.
    expect(events).toEqual(['fallback']);
    expect(sendPromptAsync.mock.calls[0]?.[1]).toMatchObject({
      parts: [{ type: 'text', text: String.raw`Say \hi` }],
    });
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

  it('sends attachments as file parts with an OpenCode command and clears them', async () => {
    // Given: a recognized slash command with a queued image attachment.
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

    // When: the command is sent.
    await runtime.sendMessage();

    // Then: the attachment rides the command payload as a file part and is consumed.
    expect(sendCommand).toHaveBeenCalledWith('session-1', { name: 'fix' }, 'issue', [
      { type: 'file', mime: 'image/png', url: 'data:image/png;base64,AA==', filename: 'image.png' },
    ]);
    expect(base.attachments.value).toEqual([]);
    expect(base.clearComposerDraftForCurrentContext).toHaveBeenCalledTimes(1);
  });

  it('folds line-comment notes into command arguments and keeps the file part', async () => {
    // Given: a recognized slash command with a line-comment attachment.
    const base = createBaseParams();
    base.messageInput.value = '/fix issue';
    base.attachments.value = [
      {
        id: 'c1',
        filename: 'a.ts:1-2',
        mime: 'text/plain',
        dataUrl: '',
        lineComment: { path: 'src/a.ts', startLine: 1, endLine: 2, text: 'note' },
      },
    ];
    const sendCommand = vi.fn().mockResolvedValue(undefined);
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('opencode'),
      openCodeApi: { sendPromptAsync: vi.fn() },
      codexApi: createCodexApi(),
      sendCommand,
    });

    // When: the command is sent.
    await runtime.sendMessage();

    // Then: the note text joins the arguments and the referenced lines ride as a file part.
    expect(sendCommand).toHaveBeenCalledWith(
      'session-1',
      { name: 'fix' },
      'issue\nsrc/a.ts:1-2:note',
      [{ type: 'file', mime: 'text/plain', url: 'src/a.ts:1-2', filename: 'a.ts' }],
    );
    expect(base.attachments.value).toEqual([]);
  });

  it('clears command attachments only after the forwarded request resolves', async () => {
    // Given: a recognized slash command with an attachment and a pending command request.
    const pending = deferred<void>();
    const sendCommand = vi.fn().mockReturnValue(pending.promise);
    const base = createBaseParams();
    base.messageInput.value = '/fix issue';
    base.attachments.value = [imageAttachment()];
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('opencode'),
      openCodeApi: { sendPromptAsync: vi.fn() },
      codexApi: createCodexApi(),
      sendCommand,
    });

    // When: the send starts but the forwarded request has not resolved yet.
    const sending = runtime.sendMessage();
    await vi.waitFor(() => expect(sendCommand).toHaveBeenCalledTimes(1));

    // Then: the attachment is still queued.
    expect(base.attachments.value).toHaveLength(1);

    // When: the forwarded request resolves.
    pending.resolve(undefined);
    await sending;

    // Then: the attachment is cleared.
    expect(base.attachments.value).toEqual([]);
  });

  it('retains attachments when an OpenCode command send fails', async () => {
    // Given: a recognized slash command with a queued attachment and a failing command request.
    const base = createBaseParams();
    base.messageInput.value = '/fix issue';
    base.attachments.value = [imageAttachment()];
    const sendCommand = vi.fn().mockRejectedValue(new Error('command rejected'));
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('opencode'),
      openCodeApi: { sendPromptAsync: vi.fn() },
      codexApi: createCodexApi(),
      sendCommand,
    });

    // When: the forwarded command request rejects.
    await runtime.sendMessage();

    // Then: the attachment is retained for retry and the failure is surfaced.
    expect(base.attachments.value).toHaveLength(1);
    expect(base.setSendStatusKey).toHaveBeenLastCalledWith('app.error.sendFailed', {
      message: 'Error: command rejected',
    });
    expect(base.isSending.value).toBe(false);
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

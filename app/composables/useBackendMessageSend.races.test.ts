import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useBackendMessageSend } from './useBackendMessageSend';
import {
  createBaseParams,
  createCodexApi,
  createOpenCodeApi,
} from './useBackendMessageSend.test-helpers';

function deferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createRuntime(
  backend: 'opencode' | 'codex' | 'acp',
  sendPromptAsync = createOpenCodeApi().sendPromptAsync,
) {
  const base = createBaseParams();
  const activeBackendKind = ref(backend);
  const runtime = useBackendMessageSend({
    ...base,
    activeBackendKind,
    openCodeApi: { sendPromptAsync },
    codexApi: createCodexApi(),
  });
  return { base, activeBackendKind, runtime, sendPromptAsync };
}

describe('useBackendMessageSend races', () => {
  it('falls back to the preferred session before dispatch', async () => {
    const { base } = createRuntime('opencode');
    base.selectedSessionId.value = 'stale-session';
    base.filteredSessions.value = [{ id: 'fallback-session' }];
    const sendPromptAsync = vi.fn().mockResolvedValue(undefined);
    const guardedRuntime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('opencode'),
      openCodeApi: { sendPromptAsync },
      codexApi: createCodexApi(),
    });

    await guardedRuntime.sendMessage();

    expect(base.selectedSessionId.value).toBe('fallback-session');
    expect(sendPromptAsync.mock.calls[0]?.[0]).toBe('fallback-session');
  });

  it('does not invalidate an in-flight send when a second send has no content', async () => {
    const firstPrompt = deferred<unknown>();
    const sendPromptAsync = vi.fn().mockReturnValue(firstPrompt.promise);
    const { base, runtime } = createRuntime('opencode', sendPromptAsync);

    const first = runtime.sendMessage();
    await vi.waitFor(() => expect(sendPromptAsync).toHaveBeenCalledTimes(1));
    base.messageInput.value = '   ';
    await runtime.sendMessage();
    firstPrompt.resolve(undefined);
    await first;

    expect(base.setSendStatusKey).toHaveBeenLastCalledWith('app.status.sent');
    expect(base.isSending.value).toBe(false);
  });

  it('normalizes Codex directories before begin and local slash execution', async () => {
    const events: string[] = [];
    const base = createBaseParams();
    base.messageInput.value = '/debug inspect';
    base.normalizeProjectDirectoryForActiveBackend = vi.fn((directory: string) => {
      events.push('normalize');
      return directory;
    });
    base.enableFollow = vi.fn(() => events.push('follow'));
    base.setSendStatusKey = vi.fn((key: string) => events.push(key));
    base.runDebugCommand = vi.fn((args: string) => {
      events.push(`debug:${args}`);
      return { ok: true, message: args };
    });
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('codex'),
      openCodeApi: { sendPromptAsync: vi.fn() },
      codexApi: createCodexApi(),
    });

    await runtime.sendMessage();

    expect(events).toEqual(['normalize', 'follow', 'app.status.sending', 'debug:inspect']);
  });

  it('propagates Codex directory normalization failures before begin', async () => {
    const base = createBaseParams();
    base.normalizeProjectDirectoryForActiveBackend = vi.fn(() => {
      throw new Error('directory failed');
    });
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('codex'),
      openCodeApi: { sendPromptAsync: vi.fn() },
      codexApi: createCodexApi(),
    });

    await expect(runtime.sendMessage()).rejects.toThrow('directory failed');

    expect(base.setSendStatusKey).not.toHaveBeenCalled();
    expect(base.isSending.value).toBe(false);
  });

  it('does not dispatch ACP context work through a replacement backend', async () => {
    const context = deferred<Array<Record<string, unknown>>>();
    const { base, activeBackendKind, runtime, sendPromptAsync } = createRuntime('acp');
    base.buildAcpMentionContextParts = vi.fn().mockReturnValue(context.promise);
    base.messageInput.value = 'Review @src/auth.ts';
    base.parseAtAgent = () => ({ agent: 'src/auth.ts', text: 'Review' });

    const sending = runtime.sendMessage();
    activeBackendKind.value = 'codex';
    context.resolve([]);
    await sending;

    expect(sendPromptAsync).not.toHaveBeenCalled();
    expect(base.setSendStatusKey).toHaveBeenCalledTimes(1);
    expect(base.attachments.value).toEqual([]);
    expect(base.clearComposerDraftForCurrentContext).not.toHaveBeenCalled();
    expect(base.isSending.value).toBe(false);
  });

  it('drops late success commits after a backend switch', async () => {
    const prompt = deferred<unknown>();
    const { base, activeBackendKind, runtime, sendPromptAsync } = createRuntime(
      'opencode',
      vi.fn().mockReturnValue(prompt.promise),
    );
    base.attachments.value = [
      { id: 'a', filename: 'a.txt', mime: 'text/plain', dataUrl: 'data:a' },
    ];

    const sending = runtime.sendMessage();
    await vi.waitFor(() => expect(sendPromptAsync).toHaveBeenCalledTimes(1));
    activeBackendKind.value = 'codex';
    prompt.resolve(undefined);
    await sending;

    expect(base.setSendStatusKey).toHaveBeenCalledTimes(1);
    expect(base.attachments.value).toHaveLength(1);
    expect(base.clearComposerDraftForCurrentContext).not.toHaveBeenCalled();
    expect(base.isSending.value).toBe(false);
  });

  it('drops late error commits after an ABA backend switch', async () => {
    const prompt = deferred<unknown>();
    const { base, activeBackendKind, runtime, sendPromptAsync } = createRuntime(
      'opencode',
      vi.fn().mockReturnValue(prompt.promise),
    );
    base.attachments.value = [
      { id: 'a', filename: 'a.txt', mime: 'text/plain', dataUrl: 'data:a' },
    ];

    const sending = runtime.sendMessage();
    await vi.waitFor(() => expect(sendPromptAsync).toHaveBeenCalledTimes(1));
    activeBackendKind.value = 'codex';
    activeBackendKind.value = 'opencode';
    prompt.reject(new Error('late failure'));
    await sending;

    expect(base.setSendStatusKey).toHaveBeenCalledTimes(1);
    expect(base.attachments.value).toHaveLength(1);
    expect(base.clearComposerDraftForCurrentContext).not.toHaveBeenCalled();
    expect(base.isSending.value).toBe(false);
  });

  it('does not select or send Codex after provider sync becomes stale', async () => {
    const sync = deferred<Record<string, unknown> | null>();
    const base = createBaseParams();
    base.syncCodexActiveProviderModel = vi.fn().mockReturnValue(sync.promise);
    const activeBackendKind = ref<'codex' | 'opencode'>('codex');
    const codexApi = createCodexApi();
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind,
      openCodeApi: { sendPromptAsync: vi.fn() },
      codexApi,
    });

    const sending = runtime.sendMessage();
    activeBackendKind.value = 'opencode';
    sync.resolve({ model: 'model-1' });
    await sending;

    expect(codexApi.selectModel).not.toHaveBeenCalled();
    expect(codexApi.sendPrompt).not.toHaveBeenCalled();
    expect(base.providerConfig.value).toBeNull();
    expect(base.isSending.value).toBe(false);
  });

  it('keeps the newer send owner when an older send rejects', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const sendPromptAsync = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { base, runtime } = createRuntime('opencode', sendPromptAsync);

    const older = runtime.sendMessage();
    await vi.waitFor(() => expect(sendPromptAsync).toHaveBeenCalledTimes(1));
    base.messageInput.value = 'new message';
    const newer = runtime.sendMessage();
    await vi.waitFor(() => expect(sendPromptAsync).toHaveBeenCalledTimes(2));
    first.reject(new Error('old failure'));
    await older;
    expect(base.isSending.value).toBe(true);
    second.resolve(undefined);
    await newer;

    expect(base.isSending.value).toBe(false);
    expect(base.setSendStatusKey).toHaveBeenLastCalledWith('app.status.sent');
  });
});

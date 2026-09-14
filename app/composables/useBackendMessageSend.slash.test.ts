import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useBackendMessageSend } from './useBackendMessageSend';
import {
  createBaseParams,
  createCodexApi,
  createOpenCodeApi,
  deferred,
  imageAttachment,
} from './useBackendMessageSend.test-helpers';

describe('Codex slash dispatch', () => {
  it.each(['new', 'fork', 'archive'])('consumes /%s in the source draft before navigating', async (name) => {
    const base = createBaseParams();
    base.messageInput.value = `/${name}`;
    base.attachments.value = [imageAttachment()];
    const persisted: string[] = [];
    const runtime = useBackendMessageSend({
      ...base, activeBackendKind: ref('codex'), codexApi: createCodexApi(), openCodeApi: createOpenCodeApi(),
      persistComposerDraftForCurrentContext: () => { persisted.push(base.messageInput.value); },
      executeCodexSlashCommand: async () => {
        expect(base.messageInput.value).toBe('');
        expect(persisted).toEqual(['']);
        expect(base.attachments.value).toHaveLength(1);
        base.selectedSessionId.value = 'destination';
        base.messageInput.value = 'destination draft';
        return 'handled';
      },
    });
    await runtime.sendMessage();
    expect(base.messageInput.value).toBe('destination draft');
    expect(persisted).toEqual(['']);
  });

  it('restores a failed navigation command when the source input is still empty', async () => {
    const base = createBaseParams();
    base.messageInput.value = '/fork';
    const runtime = useBackendMessageSend({
      ...base, activeBackendKind: ref('codex'), codexApi: createCodexApi(), openCodeApi: createOpenCodeApi(),
      executeCodexSlashCommand: async () => { throw new Error('Fork failed'); },
    });
    await runtime.sendMessage();
    expect(base.messageInput.value).toBe('/fork');
    expect(base.persistComposerDraftForCurrentContext).toHaveBeenCalledTimes(2);
  });

  it('keeps a replacement draft when navigation fails later', async () => {
    const base = createBaseParams();
    base.messageInput.value = '/fork';
    const pending = deferred<'handled'>();
    const runtime = useBackendMessageSend({
      ...base, activeBackendKind: ref('codex'), codexApi: createCodexApi(), openCodeApi: createOpenCodeApi(),
      executeCodexSlashCommand: () => pending.promise,
    });
    const sending = runtime.sendMessage();
    base.messageInput.value = 'replacement';
    pending.reject(new Error('Fork failed'));
    await sending;
    expect(base.messageInput.value).toBe('replacement');
    expect(base.persistComposerDraftForCurrentContext).toHaveBeenCalledTimes(1);
  });

  it('opens commands before connection, session and send gates when blocked', async () => {
    const base = createBaseParams();
    base.messageInput.value = '/usage';
    base.canSend.value = false;
    base.selectedSessionId.value = '';
    base.attachments.value = [imageAttachment()];
    const ensureConnectionReady = vi.fn(() => false);
    const executeCodexSlashCommand = vi.fn(async () => 'handled' as const);
    const codexApi = createCodexApi();
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('codex'),
      codexApi,
      openCodeApi: createOpenCodeApi(),
      ensureConnectionReady,
      executeCodexSlashCommand,
    });
    await runtime.sendMessage();
    expect(executeCodexSlashCommand).toHaveBeenCalledWith({ name: 'usage', arguments: '' });
    expect(ensureConnectionReady).not.toHaveBeenCalled();
    expect(codexApi.sendPrompt).not.toHaveBeenCalled();
    expect(base.messageInput.value).toBe('');
    expect(base.attachments.value).toHaveLength(1);
  });

  it('rejects unknown commands without sending them to a model', async () => {
    const base = createBaseParams();
    base.messageInput.value = '/unknown task';
    const codexApi = createCodexApi();
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('codex'),
      codexApi,
      openCodeApi: createOpenCodeApi(),
    });
    await runtime.sendMessage();
    expect(codexApi.sendPrompt).not.toHaveBeenCalled();
    expect(base.messageInput.value).toBe('/unknown task');
    expect(base.setSendStatusText).toHaveBeenCalled();
  });

  it('sends the expanded task when init callback returns not-handled', async () => {
    const base = createBaseParams();
    base.messageInput.value = '/init';
    const codexApi = createCodexApi();
    const executeCodexSlashCommand = vi.fn(async () => {
      base.messageInput.value = 'expanded task';
      return 'not-handled' as const;
    });
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('codex'),
      codexApi,
      openCodeApi: createOpenCodeApi(),
      executeCodexSlashCommand,
    });
    await runtime.sendMessage();
    expect(codexApi.sendPrompt).toHaveBeenCalledTimes(1);
    expect(codexApi.sendPrompt.mock.calls[0]?.[0]).toBe(base.recentUserInputs[0]?.text);
    expect(base.recentUserInputs[0]?.text.startsWith('/')).toBe(false);
  });

  it('keeps a replacement draft when a command finishes later', async () => {
    const base = createBaseParams();
    base.messageInput.value = '/compact';
    const pending = deferred<'handled'>();
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('codex'),
      codexApi: createCodexApi(),
      openCodeApi: createOpenCodeApi(),
      executeCodexSlashCommand: () => pending.promise,
    });
    const sending = runtime.sendMessage();
    base.messageInput.value = 'next draft';
    pending.resolve('handled');
    await sending;
    expect(base.messageInput.value).toBe('next draft');
    expect(base.clearComposerDraftForCurrentContext).not.toHaveBeenCalled();
  });

  it('preserves OpenCode command dispatch', async () => {
    const base = createBaseParams();
    base.messageInput.value = '/fix issue';
    const executeCodexSlashCommand = vi.fn(async () => 'handled' as const);
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('opencode'),
      codexApi: createCodexApi(),
      openCodeApi: createOpenCodeApi(),
      executeCodexSlashCommand,
    });
    await runtime.sendMessage();
    expect(executeCodexSlashCommand).not.toHaveBeenCalled();
    expect(base.sendCommand).toHaveBeenCalledTimes(1);
  });
});

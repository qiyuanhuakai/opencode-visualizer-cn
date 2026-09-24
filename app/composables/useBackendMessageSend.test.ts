import { describe, expect, it, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import { useBackendMessageSend } from './useBackendMessageSend';
import {
  createBaseParams,
  createCodexApi,
  deferred,
  imageAttachment,
} from './useBackendMessageSend.test-helpers';
import type { KimiWebSlashAction } from '../backends/kimiWeb/slashCommands';
import type { BackendKind } from '../backends/types';
import {
  KimiWebError,
  type KimiWebPromptAccepted,
  type KimiWebUploadedFile,
  type KimiWebUploadFileInput,
} from '../utils/kimiWeb';

describe('useBackendMessageSend', () => {
  it.each<BackendKind>(['opencode', 'codex', 'acp', 'kimi-web'])(
    'opens Forge locally for %s without a connected session or model',
    async (kind) => {
      const base = createBaseParams();
      base.messageInput.value = '/forge';
      base.selectedSessionId.value = '';
      base.selectedModel.value = '';
      base.canSend.value = false;
      base.attachments.value = [imageAttachment()];
      const ensureConnectionReady = vi.fn(() => false);
      const sendPromptAsync = vi.fn();
      const codexApi = createCodexApi({ activeThreadId: '', threads: [] });
      const runtime = useBackendMessageSend({
        ...base,
        activeBackendKind: ref(kind),
        ensureConnectionReady,
        openCodeApi: { sendPromptAsync },
        codexApi,
      });

      await runtime.sendMessage();

      expect(base.openForgePanel).toHaveBeenCalledTimes(1);
      expect(ensureConnectionReady).not.toHaveBeenCalled();
      expect(sendPromptAsync).not.toHaveBeenCalled();
      expect(codexApi.sendPrompt).not.toHaveBeenCalled();
      expect(base.messageInput.value).toBe('');
      expect(base.attachments.value).toHaveLength(1);
    },
  );

  it('keeps /forge in the composer when the panel cannot open', async () => {
    const base = createBaseParams();
    base.messageInput.value = '/forge';
    base.openForgePanel.mockResolvedValue(false);
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('opencode'),
      openCodeApi: { sendPromptAsync: vi.fn() },
      codexApi: createCodexApi(),
    });

    await runtime.sendMessage();

    expect(base.messageInput.value).toBe('/forge');
  });

  it('does not clear a newer draft after opening Forge', async () => {
    const pending = deferred<boolean>();
    const base = createBaseParams();
    base.messageInput.value = '/forge';
    base.openForgePanel.mockReturnValue(pending.promise);
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('opencode'),
      openCodeApi: { sendPromptAsync: vi.fn() },
      codexApi: createCodexApi(),
    });

    const opening = runtime.sendMessage();
    base.selectedSessionId.value = 'session-2';
    base.messageInput.value = 'new draft';
    pending.resolve(true);
    await opening;

    expect(base.messageInput.value).toBe('new draft');
  });

  it('sends Codex prompts with image attachments through runtime', async () => {
    const base = createBaseParams();
    base.attachments.value = [
      { id: 'a1', filename: 'img.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AA==' },
    ];
    const codexApi = createCodexApi();
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('codex'),
      openCodeApi: { sendPromptAsync: vi.fn() },
      codexApi,
    });

    await runtime.sendMessage();

    expect(codexApi.sendPrompt).toHaveBeenCalledTimes(1);
    expect(codexApi.sendPrompt.mock.calls[0]?.[1]).toMatchObject({
      threadId: 'session-1',
      cwd: '/repo',
      model: 'model-1',
      effort: 'high',
    });
    expect(base.attachments.value).toEqual([]);
  });

  it('passes selected collaboration mode to Codex when switcher value matches a collaboration mode id', async () => {
    const base = createBaseParams();
    base.selectedMode.value = 'plan';
    const codexApi = createCodexApi({
      collaborationModes: [{ mode: 'plan', name: 'Plan' }],
    });
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('codex'),
      openCodeApi: { sendPromptAsync: vi.fn() },
      codexApi,
    });

    await runtime.sendMessage();

    expect(codexApi.sendPrompt.mock.calls[0]?.[1]).toMatchObject({
      collaborationMode: {
        mode: 'plan',
        settings: { model: 'model-1', developer_instructions: null },
      },
    });
  });

  it('routes slash commands to sendCommand for OpenCode backends', async () => {
    const base = createBaseParams();
    base.messageInput.value = '/fix issue';
    const sendPromptAsync = vi.fn();
    const sendCommand = vi.fn().mockResolvedValue(undefined);
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('opencode'),
      openCodeApi: { sendPromptAsync },
      codexApi: createCodexApi({ activeThreadId: '', threads: [] }),
      sendCommand,
    });

    await runtime.sendMessage();

    expect(sendCommand).toHaveBeenCalledWith('session-1', { name: 'fix' }, 'issue', []);
    expect(sendPromptAsync).not.toHaveBeenCalled();
  });

  it('sends OpenCode prompt payloads through sendPromptAsync', async () => {
    const base = createBaseParams();
    const sendPromptAsync = vi.fn().mockResolvedValue(undefined);
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('opencode'),
      openCodeApi: { sendPromptAsync },
      codexApi: createCodexApi({ activeThreadId: '', threads: [] }),
    });

    await runtime.sendMessage();

    expect(sendPromptAsync).toHaveBeenCalledTimes(1);
    expect(sendPromptAsync.mock.calls[0]?.[0]).toBe('session-1');
    expect(sendPromptAsync.mock.calls[0]?.[1]).toMatchObject({
      directory: '/repo',
      agent: 'build',
      model: { providerID: 'provider', modelID: 'model-1' },
    });
  });

  it('preserves unconfirmed snippet triggers at the backend send boundary', async () => {
    // Given: snippets are enabled but the user has not confirmed the visible completion.
    const base = createBaseParams();
    base.messageInput.value = String.raw`Say \hi and keep \unknown`;
    base.textTransformersEnabled.value = true;
    base.textTransformers.value = [
      {
        id: 'snippet-hi',
        trigger: 'hi',
        name: 'Greeting',
        body: '你好',
        enabled: true,
        tags: [],
      },
    ];
    const sendPromptAsync = vi.fn().mockResolvedValue(undefined);
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('opencode'),
      openCodeApi: { sendPromptAsync },
      codexApi: createCodexApi({ activeThreadId: '', threads: [] }),
    });

    // When: the prompt is sent without selecting the candidate with Enter or a click.
    await runtime.sendMessage();

    // Then: the backend receives the literal draft without silently resolving missing context.
    const payload = sendPromptAsync.mock.calls[0]?.[1] as { parts: Array<{ text?: string }> };
    expect(payload.parts).toContainEqual({
      type: 'text',
      text: String.raw`Say \hi and keep \unknown`,
    });
  });
});

function createKimiWebApi() {
  const uploadFile = vi.fn(
    async (input: KimiWebUploadFileInput): Promise<KimiWebUploadedFile> => ({
      id: `file-${input.name ?? 'attachment'}`,
      name: input.name ?? 'attachment',
      media_type: input.file.type || 'application/octet-stream',
      size: input.file.size,
    }),
  );
  const sendPrompt = vi.fn(
    async (): Promise<KimiWebPromptAccepted> => ({
      prompt_id: 'msg_01',
      user_message_id: 'msg_01',
      status: 'running',
    }),
  );
  const steer = vi.fn(async (_sessionId: string, promptIds: string[]) => ({
    steered: true as const,
    prompt_ids: promptIds,
  }));
  const abortPrompt = vi.fn(async () => ({ aborted: true, at_seq: 12 }));
  return { uploadFile, sendPrompt, steer, abortPrompt, updateProfile: vi.fn().mockResolvedValue({}) };
}

function createKimiRuntime(
  options: {
    readonly api?: ReturnType<typeof createKimiWebApi>;
    readonly executeKimiWebSlashCommand?: (action: KimiWebSlashAction) => Promise<void>;
    readonly activeBackendKind?: Ref<BackendKind>;
  } = {},
) {
  const base = createBaseParams();
  const api = options.api ?? createKimiWebApi();
  const activeBackendKind = options.activeBackendKind ?? ref<BackendKind>('kimi-web');
  const runtime = useBackendMessageSend({
    ...base,
    activeBackendKind,
    openCodeApi: { sendPromptAsync: vi.fn().mockResolvedValue(undefined) },
    codexApi: createCodexApi({ activeThreadId: '', threads: [] }),
    kimiWebApi: api,
    executeKimiWebSlashCommand: options.executeKimiWebSlashCommand,
  });
  return { base, runtime, api, activeBackendKind };
}

describe('useBackendMessageSend kimi-web', () => {
  it('retains the existing local shell and debug commands', async () => {
    const { base, runtime, api } = createKimiRuntime();
    base.messageInput.value = '/shell pwd';
    await runtime.sendMessage();
    expect(base.openShellFromInput).toHaveBeenCalledWith('pwd');
    expect(api.sendPrompt).not.toHaveBeenCalled();
    base.messageInput.value = '/debug status';
    await runtime.sendMessage();
    expect(base.setSendStatusText).toHaveBeenCalledWith('status');
    expect(api.sendPrompt).not.toHaveBeenCalled();
  });

  it('executes slash controls without a prompt or model, preserving attachments', async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const { base, runtime, api } = createKimiRuntime({ executeKimiWebSlashCommand: execute });
    base.messageInput.value = '/plan on'; base.canSend.value = false;
    base.attachments.value = [imageAttachment()];
    await runtime.sendMessage();
    expect(execute).toHaveBeenCalledWith({ kind: 'toggle', field: 'planMode', value: true });
    expect(api.sendPrompt).not.toHaveBeenCalled(); expect(api.updateProfile).not.toHaveBeenCalled();
    expect(base.messageInput.value).toBe(''); expect(base.attachments.value).toHaveLength(1);
  });
  it('rejects unknown commands explicitly and retains input', async () => {
    const { base, runtime, api } = createKimiRuntime();
    base.messageInput.value = '/unknown';
    await runtime.sendMessage();
    expect(api.sendPrompt).not.toHaveBeenCalled(); expect(base.messageInput.value).toBe('/unknown');
    expect(base.setSendStatusKey).toHaveBeenLastCalledWith('app.error.sendFailed', expect.objectContaining({ message: expect.stringContaining('Unsupported Kimi Web command') }));
  });
  it('does not clear a new sessions draft after a delayed slash action', async () => {
    const pending = deferred<void>();
    const { base, runtime } = createKimiRuntime({ executeKimiWebSlashCommand: () => pending.promise });
    base.messageInput.value = '/compact';
    const sending = runtime.sendMessage();
    base.selectedSessionId.value = 'session-2'; base.messageInput.value = 'new draft';
    pending.resolve(); await sending;
    expect(base.messageInput.value).toBe('new draft');
  });

  it('restores a failed new-session command and clears a successful fork command', async () => {
    const execute = vi.fn(async (action: KimiWebSlashAction) => {
      if (action.kind === 'new') throw new Error('Could not create session');
    });
    const { base, runtime, api } = createKimiRuntime({ executeKimiWebSlashCommand: execute });
    base.messageInput.value = '/new';
    await runtime.sendMessage();
    expect(base.messageInput.value).toBe('/new');
    expect(api.sendPrompt).not.toHaveBeenCalled();
    base.messageInput.value = '/fork';
    await runtime.sendMessage();
    expect(base.messageInput.value).toBe('');
    expect(execute).toHaveBeenCalledWith({ kind: 'fork' });
  });

  it('sends the wire model alias without the UI provider prefix', async () => {
    const { base, runtime, api } = createKimiRuntime();
    base.selectedModel.value = 'managed:kimi-code/kimi-code/kimi-for-coding-highspeed';
    base.modelOptions.value = [{ id: base.selectedModel.value, providerID: 'managed:kimi-code', modelID: 'kimi-code/kimi-for-coding-highspeed' }];
    await runtime.sendMessage();
    expect(api.updateProfile).toHaveBeenCalledWith('session-1', { agent_config: { model: 'kimi-code/kimi-for-coding-highspeed', thinking: 'high' } });
  });

  it('resets an explicit effort to the selected models server default', async () => {
    const { base, runtime, api } = createKimiRuntime();
    base.selectedThinking.value = undefined;
    const model = { id: base.selectedModel.value, providerID: 'kimi', modelID: 'k3', variants: { low: { default: false }, high: { default: true } } };
    base.modelOptions.value = [model];
    await runtime.sendMessage();
    expect(api.updateProfile).toHaveBeenCalledWith('session-1', { agent_config: { model: 'k3', thinking: 'high' } });
  });

  it('does not send into a newly selected session after an old profile update', async () => {
    const { base, runtime, api } = createKimiRuntime();
    api.updateProfile.mockImplementationOnce(async () => {
      base.selectedSessionId.value = 'session-2';
      base.messageInput.value = 'new draft';
      return {};
    });
    await runtime.sendMessage();
    expect(api.sendPrompt).not.toHaveBeenCalled();
    expect(base.messageInput.value).toBe('new draft');
    expect(base.clearComposerDraftForCurrentContext).not.toHaveBeenCalled();
  });

  it('shows a profile error without posting a prompt', async () => {
    const { base, runtime, api } = createKimiRuntime();
    api.updateProfile.mockRejectedValueOnce(new KimiWebError(40001, 'model rejected'));
    await runtime.sendMessage();
    expect(api.sendPrompt).not.toHaveBeenCalled();
    expect(base.setSendStatusKey).toHaveBeenLastCalledWith('app.error.sendFailed', { message: 'KimiWebError: model rejected' });
    expect(base.messageInput.value).toBe('hello world');
  });

  it('uploads attachments before dispatching the kimi-web prompt parts', async () => {
    const { base, runtime, api } = createKimiRuntime();
    base.messageInput.value = 'hi';
    base.attachments.value = [imageAttachment()];

    await runtime.sendMessage();

    expect(api.uploadFile).toHaveBeenCalledTimes(1);
    expect(api.uploadFile.mock.invocationCallOrder[0]).toBeLessThan(
      api.sendPrompt.mock.invocationCallOrder[0] ?? 0,
    );
    expect(api.sendPrompt).toHaveBeenCalledWith('session-1', {
      content: [
        { type: 'text', text: 'hi' },
        { type: 'image', source: { kind: 'file', file_id: 'file-image.png' }, name: 'image.png' },
      ],
    });
    expect(base.attachments.value).toEqual([]);
    expect(base.setSendStatusKey).toHaveBeenLastCalledWith('app.status.sent');
  });

  it('does not gate kimi-web sends on OpenCode model availability', async () => {
    const base = createBaseParams();
    base.selectedModel.value = 'kimi-code/k3';
    base.modelOptions.value = [];
    base.isProviderEnabled = () => false;
    base.isModelAvailable = () => false;
    const api = createKimiWebApi();
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref<BackendKind>('kimi-web'),
      openCodeApi: { sendPromptAsync: vi.fn().mockResolvedValue(undefined) },
      codexApi: createCodexApi({ activeThreadId: '', threads: [] }),
      kimiWebApi: api,
    });

    await runtime.sendMessage();

    expect(api.sendPrompt).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed kimi-web upload without sending the prompt', async () => {
    const { base, runtime, api } = createKimiRuntime();
    api.uploadFile.mockRejectedValueOnce(new KimiWebError(40001, 'upload denied'));
    base.attachments.value = [imageAttachment()];

    await runtime.sendMessage();

    expect(api.sendPrompt).not.toHaveBeenCalled();
    expect(base.attachments.value).toHaveLength(1);
    expect(base.setSendStatusKey).toHaveBeenLastCalledWith('app.error.sendFailed', {
      message: 'KimiWebError: upload denied',
    });
    expect(base.isSending.value).toBe(false);
  });

  it('presents a queued kimi-web prompt as pending instead of sent', async () => {
    const { base, runtime, api } = createKimiRuntime();
    api.sendPrompt.mockResolvedValueOnce({
      prompt_id: 'msg_02',
      user_message_id: 'msg_02',
      status: 'queued',
    });

    await runtime.sendMessage();

    expect(base.setSendStatusKey).toHaveBeenLastCalledWith('app.status.sending');
    expect(base.setSendStatusKey.mock.calls.map(([key]) => key)).not.toContain('app.status.sent');
    expect(base.attachments.value).toEqual([]);
  });

  it('presents a blocked kimi-web prompt as not sent', async () => {
    const { base, runtime, api } = createKimiRuntime();
    api.sendPrompt.mockResolvedValueOnce({
      prompt_id: 'msg_03',
      user_message_id: 'msg_03',
      status: 'blocked',
    });

    await runtime.sendMessage();

    expect(base.setSendStatusKey).toHaveBeenLastCalledWith('app.error.actionDisabled', {
      action: 'app.actions.sending',
    });
    expect(base.setSendStatusKey.mock.calls.map(([key]) => key)).not.toContain('app.status.sent');
  });

  it('fails closed when the kimi-web client is not wired instead of using the OpenCode path', async () => {
    const base = createBaseParams();
    const sendPromptAsync = vi.fn();
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref<BackendKind>('kimi-web'),
      openCodeApi: { sendPromptAsync },
      codexApi: createCodexApi({ activeThreadId: '', threads: [] }),
    });

    await runtime.sendMessage();

    expect(sendPromptAsync).not.toHaveBeenCalled();
    expect(base.setSendStatusKey).toHaveBeenLastCalledWith('app.error.unavailable', {
      action: 'Kimi Web',
    });
  });

  it('drops a kimi-web send whose upload resolves after the backend fence moved', async () => {
    const activeBackendKind = ref<BackendKind>('kimi-web');
    const { base, runtime, api } = createKimiRuntime({ activeBackendKind });
    const upload = deferred<KimiWebUploadedFile>();
    api.uploadFile.mockReturnValueOnce(upload.promise);
    base.attachments.value = [imageAttachment()];

    const sending = runtime.sendMessage();
    await vi.waitFor(() => expect(api.uploadFile).toHaveBeenCalledTimes(1));
    activeBackendKind.value = 'opencode';
    upload.resolve({ id: 'file-x', name: 'image.png', media_type: 'image/png', size: 3 });
    await sending;

    expect(api.sendPrompt).not.toHaveBeenCalled();
    expect(base.setSendStatusKey).toHaveBeenCalledTimes(1);
    expect(base.attachments.value).toHaveLength(1);
    expect(base.clearComposerDraftForCurrentContext).not.toHaveBeenCalled();
    expect(base.isSending.value).toBe(false);
  });

  it('drops the kimi-web success commit after a backend switch', async () => {
    const activeBackendKind = ref<BackendKind>('kimi-web');
    const { base, runtime, api } = createKimiRuntime({ activeBackendKind });
    base.attachments.value = [imageAttachment()];
    const prompt = deferred<KimiWebPromptAccepted>();
    api.sendPrompt.mockReturnValueOnce(prompt.promise);

    const sending = runtime.sendMessage();
    await vi.waitFor(() => expect(api.sendPrompt).toHaveBeenCalledTimes(1));
    activeBackendKind.value = 'opencode';
    prompt.resolve({ prompt_id: 'msg_09', user_message_id: 'msg_09', status: 'running' });
    await sending;

    expect(base.setSendStatusKey).toHaveBeenCalledTimes(1);
    expect(base.attachments.value).toHaveLength(1);
    expect(base.clearComposerDraftForCurrentContext).not.toHaveBeenCalled();
    expect(base.isSending.value).toBe(false);
  });
});

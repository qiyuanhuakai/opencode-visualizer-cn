import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { BackendMessageSendParams, SendPreflight } from '../../composables/backendMessageSend.types';
import { runOpenCodeSend } from '../../composables/backendMessageSend.openCode';
import { createBaseParams, createCodexApi, deferred } from '../../composables/useBackendMessageSend.test-helpers';
import type { BackendKind } from '../types';
import type { ComposerAttachment } from '../../types/composer';
import {
  createKimiWebClient,
  KimiWebError,
  type KimiWebPromptAccepted,
  type KimiWebUploadedFile,
  type KimiWebUploadFileInput,
} from '../../utils/kimiWeb';
import {
  abortKimiWebPrompt,
  runKimiWebSend,
  steerKimiWebPrompts,
  type KimiWebSendApi,
} from './backendMessageSend.kimiWeb';

function createParams(): BackendMessageSendParams {
  return {
    ...createBaseParams(),
    activeBackendKind: ref<BackendKind>('kimi-web'),
    openCodeApi: { sendPromptAsync: vi.fn().mockResolvedValue(undefined) },
    codexApi: createCodexApi({ activeThreadId: '', threads: [] }),
  };
}

function createPreflight(overrides: Partial<SendPreflight> = {}): SendPreflight {
  return {
    backend: 'kimi-web',
    sessionId: 'session-1',
    text: 'hello world',
    transformedText: 'hello world',
    hasText: true,
    attachments: [],
    selectedModel: 'kimi-code/k3',
    selectedMode: 'build',
    selectedThinking: undefined,
    modelProvider: undefined,
    modelId: undefined,
    codexDirectory: '',
    slash: null,
    commandMatch: null,
    transformText: (value: string) => value,
    ...overrides,
  };
}

function createApi() {
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
  const updateProfile = vi.fn().mockResolvedValue({});
  const api = { uploadFile, sendPrompt, steer, abortPrompt, updateProfile } satisfies KimiWebSendApi;
  return { api, uploadFile, sendPrompt, steer, abortPrompt, updateProfile };
}

function imageAttachment(): ComposerAttachment {
  return {
    id: 'i1',
    filename: 'shot.png',
    mime: 'image/png',
    dataUrl: 'data:image/png;base64,AAEC',
  };
}

describe('kimi-web send module', () => {
  it('applies the captured model and thinking before sending', async () => {
    const params = createParams();
    const { api, updateProfile, sendPrompt } = createApi();
    await runKimiWebSend(params, createPreflight({ selectedThinking: 'high' }), { isCurrent: () => true }, api);
    expect(updateProfile).toHaveBeenCalledWith('session-1', { agent_config: { model: 'kimi-code/k3', thinking: 'high' } });
    expect(updateProfile.mock.invocationCallOrder[0]).toBeLessThan(sendPrompt.mock.invocationCallOrder[0] ?? 0);
  });

  it('does not send when profile configuration fails', async () => {
    const { api, updateProfile, sendPrompt } = createApi();
    updateProfile.mockRejectedValueOnce(new KimiWebError(40001, 'model rejected'));
    await expect(runKimiWebSend(createParams(), createPreflight(), { isCurrent: () => true }, api)).rejects.toThrow('model rejected');
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('does not send or read a new selection when the profile response becomes stale', async () => {
    const params = createParams();
    const { api, updateProfile, sendPrompt } = createApi();
    let current = true;
    updateProfile.mockImplementationOnce(async () => {
      current = false;
      params.selectedSessionId.value = 'session-2';
      params.selectedModel.value = 'other/model';
      return {};
    });
    await expect(runKimiWebSend(params, createPreflight(), { isCurrent: () => current }, api)).resolves.toEqual({ kind: 'stale' });
    expect(updateProfile).toHaveBeenCalledWith('session-1', { agent_config: { model: 'kimi-code/k3' } });
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('does not post a prompt while the selected sessions mode mutation is pending', async () => {
    // Given: the selected session has a pending mode write.
    const readiness = vi.fn(() => false);
    const params: BackendMessageSendParams = {
      ...createParams(),
      isKimiWebSessionModeReady: readiness,
    };
    params.attachments.value = [imageAttachment()];
    params.messageInput.value = '';
    const { api, uploadFile, sendPrompt } = createApi();

    // When: send reaches the kimi boundary while the mode write is pending.
    const refused = await runKimiWebSend(
      params,
      createPreflight({ attachments: params.attachments.value }),
      { isCurrent: () => true },
      api,
    );

    // Then: neither uploads nor the prompt overtake the mode mutation, and the draft is intact.
    expect(refused).toEqual({ kind: 'stale' });
    expect(uploadFile).not.toHaveBeenCalled();
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(params.messageInput.value).toBe('hello world');
    expect(params.attachments.value).toEqual([imageAttachment()]);

    // Given: a later send starts ready, but a mode write begins during attachment upload.
    const upload = deferred<KimiWebUploadedFile>();
    uploadFile.mockReturnValueOnce(upload.promise);
    readiness.mockReturnValue(true);
    params.messageInput.value = '';
    const sending = runKimiWebSend(
      params,
      createPreflight({ attachments: params.attachments.value }),
      { isCurrent: () => true },
      api,
    );
    await vi.waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1));

    // When: readiness changes before the prompt request is posted.
    readiness.mockReturnValue(false);
    upload.resolve({ id: 'file-x', name: 'shot.png', media_type: 'image/png', size: 3 });

    // Then: readiness is re-evaluated immediately before sendPrompt.
    await expect(sending).resolves.toEqual({ kind: 'stale' });
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(params.messageInput.value).toBe('hello world');
    expect(params.attachments.value).toEqual([imageAttachment()]);
  });

  it('a failed mode change does not silently send a waiting prompt', async () => {
    // Given: a send attempt observes a pending mode mutation that will fail.
    let modePending = true;
    const params: BackendMessageSendParams = {
      ...createParams(),
      isKimiWebSessionModeReady: () => !modePending,
    };
    const { api, sendPrompt } = createApi();
    const failedModeWrite = deferred<void>();
    params.messageInput.value = '';

    // When: send is refused and the mode write subsequently rejects.
    const sending = runKimiWebSend(params, createPreflight(), { isCurrent: () => true }, api);
    const modeFailure = failedModeWrite.promise.catch(() => {
      modePending = false;
    });
    failedModeWrite.reject(new KimiWebError(40001, 'mode rejected'));
    await modeFailure;

    // Then: the refused attempt is never queued or posted after failure.
    await expect(sending).resolves.toEqual({ kind: 'stale' });
    expect(sendPrompt).not.toHaveBeenCalled();
    expect(params.messageInput.value).toBe('hello world');
  });

  it('builds a text part plus a formatted note for line-comment attachments without uploading', async () => {
    // Given: a prompt with an editor-selection attachment (no bytes, only a range).
    const params = createParams();
    const { api, uploadFile, sendPrompt } = createApi();
    const preflight = createPreflight({
      attachments: [
        {
          id: 'comment-1',
          filename: 'app.ts:10-12',
          mime: 'text/plain',
          dataUrl: '',
          lineComment: { path: 'app/app.ts', startLine: 10, endLine: 12, text: 'needs a guard' },
        },
      ],
    });

    // When: the prompt is sent through the kimi-web runner.
    const result = await runKimiWebSend(params, preflight, { isCurrent: () => true }, api);

    // Then: the note rides as text and nothing is uploaded.
    expect(result).toEqual({
      kind: 'accepted',
      promptId: 'msg_01',
      userMessageId: 'msg_01',
      status: 'running',
    });
    expect(uploadFile).not.toHaveBeenCalled();
    expect(sendPrompt).toHaveBeenCalledWith('session-1', {
      content: [
        { type: 'text', text: 'hello world' },
        { type: 'text', text: 'app/app.ts:10-12:needs a guard' },
      ],
    });
  });

  it('uploads every attachment before the prompt and references the returned file ids', async () => {
    // Given: an image and a text document attachment.
    const params = createParams();
    const { api, uploadFile, sendPrompt } = createApi();
    const doc: ComposerAttachment = {
      id: 'd1',
      filename: 'notes.md',
      mime: 'text/markdown',
      dataUrl: 'data:text/markdown,hello',
    };
    const preflight = createPreflight({ attachments: [imageAttachment(), doc] });

    // When: the prompt is sent.
    await runKimiWebSend(params, preflight, { isCurrent: () => true }, api);

    // Then: both uploads finish before the prompt request starts.
    expect(uploadFile).toHaveBeenCalledTimes(2);
    expect(uploadFile.mock.invocationCallOrder[1]).toBeLessThan(
      sendPrompt.mock.invocationCallOrder[0] ?? 0,
    );
    const firstInput = uploadFile.mock.calls[0]?.[0];
    expect(firstInput?.name).toBe('shot.png');
    expect(firstInput?.file.type).toBe('image/png');
    expect(firstInput?.file.size).toBe(3);
    const secondInput = uploadFile.mock.calls[1]?.[0];
    expect(secondInput?.file.type).toBe('text/markdown');
    expect(secondInput?.file.size).toBe(5);
    expect(sendPrompt).toHaveBeenCalledWith('session-1', {
      content: [
        { type: 'text', text: 'hello world' },
        { type: 'image', source: { kind: 'file', file_id: 'file-shot.png' }, name: 'shot.png' },
        {
          type: 'file',
          file_id: 'file-notes.md',
          name: 'notes.md',
          media_type: 'text/markdown',
          size: 5,
        },
      ],
    });
  });

  it('does not send the prompt when an attachment upload fails', async () => {
    // Given: the file endpoint rejects before any prompt exists.
    const params = createParams();
    const { api, uploadFile, sendPrompt } = createApi();
    uploadFile.mockRejectedValueOnce(new KimiWebError(40001, 'upload denied'));

    // When / Then: the upload failure surfaces and the prompt is never sent.
    await expect(
      runKimiWebSend(params, createPreflight({ attachments: [imageAttachment()] }), { isCurrent: () => true }, api),
    ).rejects.toThrow('upload denied');
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('stops before the prompt when the guard expires during an upload', async () => {
    // Given: an upload still in flight when the backend fence moves.
    const params = createParams();
    const { api, uploadFile, sendPrompt } = createApi();
    const upload = deferred<KimiWebUploadedFile>();
    uploadFile.mockReturnValueOnce(upload.promise);
    let current = true;
    const guard = { isCurrent: () => current };

    // When: the guard is dropped before the upload resolves.
    const sending = runKimiWebSend(params, createPreflight({ attachments: [imageAttachment()] }), guard, api);
    await vi.waitFor(() => expect(uploadFile).toHaveBeenCalledTimes(1));
    current = false;
    upload.resolve({ id: 'file-x', name: 'shot.png', media_type: 'image/png', size: 3 });

    // Then: the obsolete response is discarded and no prompt is sent.
    await expect(sending).resolves.toEqual({ kind: 'stale' });
    expect(sendPrompt).not.toHaveBeenCalled();
  });

  it('propagates the queued/blocked acceptance status from the server', async () => {
    const params = createParams();
    const { api, sendPrompt } = createApi();
    sendPrompt.mockResolvedValueOnce({
      prompt_id: 'msg_02',
      user_message_id: 'msg_02',
      status: 'blocked',
    });

    const result = await runKimiWebSend(params, createPreflight(), { isCurrent: () => true }, api);

    expect(result).toEqual({
      kind: 'accepted',
      promptId: 'msg_02',
      userMessageId: 'msg_02',
      status: 'blocked',
    });
  });

  it('fails closed when a kimi-web preflight reaches the OpenCode runner', async () => {
    // Given: a kimi-web preflight that should never dispatch through OpenCode.
    const sendPromptAsync = vi.fn();
    const params: BackendMessageSendParams = {
      ...createBaseParams(),
      activeBackendKind: ref<BackendKind>('kimi-web'),
      openCodeApi: { sendPromptAsync },
      codexApi: createCodexApi({ activeThreadId: '', threads: [] }),
    };

    // When: the OpenCode runner receives it.
    const result = await runOpenCodeSend(params, createPreflight(), { isCurrent: () => true });

    // Then: it refuses instead of silently sending an OpenCode prompt.
    expect(result).toEqual({ kind: 'stale' });
    expect(sendPromptAsync).not.toHaveBeenCalled();
  });
});

describe('kimi-web steer', () => {
  it('steers queued prompts through the prompts:steer tail', async () => {
    const { api, steer } = createApi();

    const result = await steerKimiWebPrompts({
      api,
      sessionId: 'session-1',
      promptIds: ['msg_01', 'msg_02'],
    });

    expect(steer).toHaveBeenCalledWith('session-1', ['msg_01', 'msg_02']);
    expect(result).toEqual({ kind: 'steered', promptIds: ['msg_01', 'msg_02'] });
  });

  it('drops a steer response whose guard expired while the request was in flight', async () => {
    const { api, steer } = createApi();
    let current = true;
    steer.mockImplementation(async (_sessionId, promptIds) => {
      current = false;
      return { steered: true as const, prompt_ids: promptIds };
    });

    const result = await steerKimiWebPrompts({
      api,
      sessionId: 'session-1',
      promptIds: ['msg_01'],
      guard: { isCurrent: () => current },
    });

    expect(result).toEqual({ kind: 'stale' });
  });

  it('routes steer and prompt abort through the measured REST tails', async () => {
    // Given: the real Todo 8 client on a recorded fetch boundary.
    const calls: Array<{ url: string; method?: string; body?: string }> = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method,
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      const data = url.includes(':steer')
        ? { steered: true, prompt_ids: ['msg_01'] }
        : { aborted: true, at_seq: 3 };
      return {
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () => JSON.stringify({ code: 0, msg: 'success', data }),
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response;
    });
    const client = createKimiWebClient({
      baseUrl: 'http://localhost:23004/kimi-web',
      fetcher: fetcher as unknown as typeof fetch,
    });

    // When: steer and prompt abort run without a WS channel.
    await steerKimiWebPrompts({ api: client, sessionId: 'session-1', promptIds: ['msg_01'] });
    await abortKimiWebPrompt({ api: client, sessionId: 'session-1', promptId: 'msg_01' });

    // Then: the wire paths are the measured `:steer` / `:abort` tails.
    expect(calls[0]).toMatchObject({
      url: 'http://localhost:23004/kimi-web/api/v1/sessions/session-1/prompts:steer',
      method: 'POST',
    });
    expect(JSON.parse(calls[0]?.body ?? '')).toEqual({ prompt_ids: ['msg_01'] });
    expect(calls[1]).toMatchObject({
      url: 'http://localhost:23004/kimi-web/api/v1/sessions/session-1/prompts/msg_01:abort',
      method: 'POST',
    });
  });
});

describe('kimi-web abort', () => {
  it('aborts through the WS frame and skips the REST tail on ack success', async () => {
    const { api, abortPrompt } = createApi();
    const channel = { abort: vi.fn().mockResolvedValue({ id: 'c1', code: 0 }), isConnected: () => true };

    const result = await abortKimiWebPrompt({
      api,
      channel,
      sessionId: 'session-1',
      promptId: 'msg_01',
    });

    expect(channel.abort).toHaveBeenCalledWith('session-1', 'msg_01');
    expect(result).toEqual({ kind: 'aborted', transport: 'ws' });
    expect(abortPrompt).not.toHaveBeenCalled();
  });

  it('falls back to the REST prompt abort when the WS frame fails', async () => {
    const { api, abortPrompt } = createApi();
    const channel = {
      abort: vi.fn().mockRejectedValue(new Error('Kimi Web WebSocket is not connected.')),
      isConnected: () => true,
    };

    const result = await abortKimiWebPrompt({
      api,
      channel,
      sessionId: 'session-1',
      promptId: 'msg_01',
    });

    expect(abortPrompt).toHaveBeenCalledWith('session-1', 'msg_01');
    expect(result).toEqual({ kind: 'aborted', transport: 'rest', atSeq: 12 });
  });

  it('uses the REST tail directly when the socket is not connected', async () => {
    const { api, abortPrompt } = createApi();
    const channel = { abort: vi.fn(), isConnected: () => false };

    const result = await abortKimiWebPrompt({
      api,
      channel,
      sessionId: 'session-1',
      promptId: 'msg_01',
    });

    expect(channel.abort).not.toHaveBeenCalled();
    expect(abortPrompt).toHaveBeenCalledWith('session-1', 'msg_01');
    expect(result).toEqual({ kind: 'aborted', transport: 'rest', atSeq: 12 });
  });

  it('drops the abort result when the fence moves while the WS ack is in flight', async () => {
    const { api, abortPrompt } = createApi();
    let current = true;
    const channel = {
      abort: vi.fn().mockImplementation(async () => {
        current = false;
        return { id: 'c1', code: 0 };
      }),
    };

    const result = await abortKimiWebPrompt({
      api,
      channel,
      sessionId: 'session-1',
      promptId: 'msg_01',
      guard: { isCurrent: () => current },
    });

    expect(result).toEqual({ kind: 'stale' });
    expect(abortPrompt).not.toHaveBeenCalled();
  });
});

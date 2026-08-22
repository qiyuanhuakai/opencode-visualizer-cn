import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useBackendMessageSend } from './useBackendMessageSend';
import { createBaseParams } from './useBackendMessageSend.test-helpers';

describe('useBackendMessageSend', () => {
  it('sends Codex prompts with image attachments through runtime', async () => {
    const base = createBaseParams();
    base.attachments.value = [
      { id: 'a1', filename: 'img.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AA==' },
    ];
    const codexApi = {
      activeThreadId: ref('session-1'),
      threads: ref([{ id: 'session-1', modelProvider: 'provider' }]),
      collaborationModes: ref([]),
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      refreshThreads: vi.fn().mockResolvedValue(undefined),
      selectModel: vi.fn(),
    };
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
    const codexApi = {
      activeThreadId: ref('session-1'),
      threads: ref([{ id: 'session-1', modelProvider: 'provider' }]),
      collaborationModes: ref([{ mode: 'plan', name: 'Plan' }]),
      sendPrompt: vi.fn().mockResolvedValue(undefined),
      refreshThreads: vi.fn().mockResolvedValue(undefined),
      selectModel: vi.fn(),
    };
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
      codexApi: {
        activeThreadId: ref(''),
        threads: ref([]),
        collaborationModes: ref([]),
        sendPrompt: vi.fn(),
        refreshThreads: vi.fn(),
        selectModel: vi.fn(),
      },
      sendCommand,
    });

    await runtime.sendMessage();

    expect(sendCommand).toHaveBeenCalledWith('session-1', { name: 'fix' }, 'issue');
    expect(sendPromptAsync).not.toHaveBeenCalled();
  });

  it('sends OpenCode prompt payloads through sendPromptAsync', async () => {
    const base = createBaseParams();
    const sendPromptAsync = vi.fn().mockResolvedValue(undefined);
    const runtime = useBackendMessageSend({
      ...base,
      activeBackendKind: ref('opencode'),
      openCodeApi: { sendPromptAsync },
      codexApi: {
        activeThreadId: ref(''),
        threads: ref([]),
        collaborationModes: ref([]),
        sendPrompt: vi.fn(),
        refreshThreads: vi.fn(),
        selectModel: vi.fn(),
      },
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
      codexApi: {
        activeThreadId: ref(''),
        threads: ref([]),
        collaborationModes: ref([]),
        sendPrompt: vi.fn(),
        refreshThreads: vi.fn(),
        selectModel: vi.fn(),
      },
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

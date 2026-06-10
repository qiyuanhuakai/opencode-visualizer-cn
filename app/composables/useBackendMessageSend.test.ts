import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useBackendMessageSend } from './useBackendMessageSend';
import type { ComposerAttachment } from '../types/composer';

function createBaseParams() {
  return {
    codexProjectId: 'codex',
    selectedSessionId: ref('session-1'),
    selectedModel: ref('provider/model-1'),
    selectedMode: ref('build'),
    selectedThinking: ref<string | undefined>('high'),
    activeDirectory: ref('/repo'),
    messageInput: ref('hello world'),
    attachments: ref<ComposerAttachment[]>([]),
    recentUserInputs: [] as Array<{ text: string; time: number }>,
    filteredSessions: ref([{ id: 'session-1' }]),
    canSend: ref(true),
    isSending: ref(false),
    codexPendingSessionLock: ref(''),
    modelOptions: ref([{ id: 'provider/model-1', providerID: 'provider', modelID: 'model-1' }]),
    commands: ref([{ name: 'fix' }]),
    agents: ref([{ name: 'build' }]),
    providerConfig: ref<Record<string, unknown> | null>(null),
    hiddenModels: ref<string[]>([]),
    parseSkill: () => [],
    availableSkills: ref([]),
    ensureConnectionReady: () => true,
    translate: (key: string) => key,
    toErrorMessage: (error: unknown) => String(error),
    parseSlashCommand: (input: string) => {
      const trimmed = input.trim();
      if (!trimmed.startsWith('/')) return null;
      const parts = trimmed.slice(1).split(/\s+/, 2);
      return { name: parts[0] || '', arguments: parts[1] || '' };
    },
    findCommandByName: (name: string) => name === 'fix' ? { name: 'fix' } : null,
    findAgentByName: (name: string) => name === 'build' ? { name: 'build' } : null,
    parseAtAgent: () => null,
    runDebugCommand: (args: string) => ({ ok: true, message: args }),
    openShellFromInput: vi.fn().mockResolvedValue(true),
    clearComposerDraftForCurrentContext: vi.fn(),
    enableFollow: vi.fn(),
    setSendStatusKey: vi.fn(),
    setSendStatusText: vi.fn(),
    pickPreferredSessionId: (list: Array<{ id: string }>) => list[0]?.id || '',
    normalizeProjectDirectoryForActiveBackend: (directory: string) => directory,
    parseProviderModelKey: (value: string) => {
      const [providerID = '', modelID = ''] = value.split('/');
      return { providerID, modelID };
    },
    syncCodexActiveProviderModel: vi.fn().mockResolvedValue(undefined),
    shouldStartNewCodexThreadForProvider: () => false,
    isProviderEnabled: () => true,
    isModelAvailable: () => true,
    ensureSelectedModelAvailable: vi.fn(),
    requireSelectedWorktree: () => '/repo',
    sendCommand: vi.fn().mockResolvedValue(undefined),
    buildLineCommentFileUrl: (path: string, startLine: number, endLine: number) => `${path}:${startLine}-${endLine}`,
    formatCommentNote: (path: string, startLine: number, endLine: number, text: string) => `${path}:${startLine}-${endLine}:${text}`,
  };
}

describe('useBackendMessageSend', () => {
  it('sends Codex prompts with image attachments through runtime', async () => {
    const base = createBaseParams();
    base.attachments.value = [{ id: 'a1', filename: 'img.png', mime: 'image/png', dataUrl: 'data:image/png;base64,AA==' }];
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
      collaborationModes: ref([{ id: 'plan', name: 'Plan' }]),
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
      collaborationMode: 'plan',
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

  it('attaches $skill-name tokens as {type:"skill"} items before text on Codex backend', async () => {
    const base = createBaseParams();
    base.messageInput.value = '$skill-creator add a new skill for CI';
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
      availableSkills: ref([
        { name: 'skill-creator', description: 'd', enabled: true, path: '/abs/skill-creator/SKILL.md' },
      ]),
      parseSkill: (input: string) => {
        const m = input.match(/\$([\w-]+)/);
        if (!m) return [];
        return m[1] === 'skill-creator'
          ? [{ name: 'skill-creator', path: '/abs/skill-creator/SKILL.md' }]
          : [];
      },
    });

    await runtime.sendMessage();

    const opts = codexApi.sendPrompt.mock.calls[0]?.[1] as {
      input?: Array<{ type: string; name?: string; path?: string; text?: string }>;
    };
    expect(opts.input).toBeDefined();
    expect(opts.input?.[0]).toEqual({
      type: 'skill',
      name: 'skill-creator',
      path: '/abs/skill-creator/SKILL.md',
    });
    expect(opts.input?.[1]).toMatchObject({
      type: 'text',
      text: '$skill-creator add a new skill for CI',
    });
  });

  it('does not attach skill items when no $token is present in the Codex message', async () => {
    const base = createBaseParams();
    base.messageInput.value = 'just a regular message';
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
      availableSkills: ref([
        { name: 'skill-creator', description: 'd', enabled: true, path: '/abs/skill-creator/SKILL.md' },
      ]),
      parseSkill: () => [],
    });

    await runtime.sendMessage();

    const opts = codexApi.sendPrompt.mock.calls[0]?.[1] as {
      input?: Array<{ type: string }>;
    };
    expect(opts.input?.some((item) => item.type === 'skill')).toBe(false);
  });

  it('does not attach skill items on OpenCode backend even with $token present', async () => {
    const base = createBaseParams();
    base.messageInput.value = '$skill-creator hello';
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
      availableSkills: ref([
        { name: 'skill-creator', description: 'd', enabled: true, path: '/abs/skill-creator/SKILL.md' },
      ]),
      parseSkill: () => [{ name: 'skill-creator', path: '/abs/skill-creator/SKILL.md' }],
    });

    await runtime.sendMessage();

    const payload = sendPromptAsync.mock.calls[0]?.[1] as { parts: Array<Record<string, unknown>> };
    expect(payload.parts.some((part) => part.type === 'skill')).toBe(false);
  });
});

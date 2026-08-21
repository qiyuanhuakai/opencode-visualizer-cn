import { ref } from 'vue';
import { vi } from 'vitest';
import type { ComposerAttachment } from '../types/composer';
import type { CodexSkill } from '../backends/codex/codexAdapter';
import type { ParsedSkill } from '../utils/parseSkill';
import type { TextTransformer } from '../utils/textTransformers';

export function createBaseParams() {
  return {
    codexProjectId: 'codex',
    selectedSessionId: ref('session-1'),
    selectedModel: ref('provider/model-1'),
    selectedMode: ref('build'),
    selectedThinking: ref<string | undefined>('high'),
    activeDirectory: ref('/repo'),
    messageInput: ref('hello world'),
    textTransformersEnabled: ref(false),
    textTransformers: ref<TextTransformer[]>([]),
    attachments: ref<ComposerAttachment[]>([]),
    recentUserInputs: [] as Array<{ text: string; time: number }>,
    filteredSessions: ref([{ id: 'session-1' }]),
    canSend: ref(true),
    isSending: ref(false),
    codexPendingSessionLock: ref(''),
    modelOptions: ref([{ id: 'provider/model-1', providerID: 'provider', modelID: 'model-1' }]),
    providerConfig: ref<Record<string, unknown> | null>(null),
    parseSkill: (_input: string, _skills: ReadonlyArray<CodexSkill>): ParsedSkill[] => [],
    availableSkills: ref<CodexSkill[]>([]),
    ensureConnectionReady: () => true,
    translate: (key: string) => key,
    toErrorMessage: (error: unknown) => String(error),
    parseSlashCommand: (input: string) => {
      const trimmed = input.trim();
      if (!trimmed.startsWith('/')) return null;
      const parts = trimmed.slice(1).split(/\s+/, 2);
      return { name: parts[0] || '', arguments: parts[1] || '' };
    },
    findCommandByName: (name: string) => (name === 'fix' ? { name: 'fix' } : null),
    findAgentByName: (name: string) => (name === 'build' ? { name: 'build' } : null),
    parseAtAgent: (_input: string): { agent: string; text: string } | null => null,
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
    syncCodexActiveProviderModel: vi.fn().mockResolvedValue(null),
    shouldStartNewCodexThreadForProvider: () => false,
    isProviderEnabled: () => true,
    isModelAvailable: () => true,
    ensureSelectedModelAvailable: vi.fn(),
    requireSelectedWorktree: () => '/repo',
    sendCommand: vi.fn().mockResolvedValue(undefined),
    buildLineCommentFileUrl: (path: string, startLine: number, endLine: number) =>
      `${path}:${startLine}-${endLine}`,
    formatCommentNote: (path: string, startLine: number, endLine: number, text: string) =>
      `${path}:${startLine}-${endLine}:${text}`,
    resolveAgentMode: (mode: string) => mode,
    buildAcpMentionContextParts: vi.fn().mockResolvedValue([]),
  };
}

export function createCodexApi() {
  return {
    activeThreadId: ref('session-1'),
    threads: ref([{ id: 'session-1', modelProvider: 'provider' }]),
    collaborationModes: ref([]),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    refreshThreads: vi.fn().mockResolvedValue(undefined),
    selectModel: vi.fn(),
  };
}

export function createOpenCodeApi(sendPromptAsync = vi.fn().mockResolvedValue(undefined)) {
  return { sendPromptAsync };
}

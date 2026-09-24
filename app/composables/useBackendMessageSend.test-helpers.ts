import { ref } from 'vue';
import { vi } from 'vitest';
import type { ComposerAttachment } from '../types/composer';
import type { CodexSkill } from '../backends/codex/codexAdapter';
import type { ParsedSkill } from '../utils/parseSkill';
import type { TextTransformer } from '../utils/textTransformers';

type CodexApiFixtureOptions = {
  readonly activeThreadId?: string;
  readonly threads?: Array<{ id: string; modelProvider: string }>;
  readonly collaborationModes?: Array<{ mode: string; name: string }>;
};

export type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
};

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
    openForgePanel: vi.fn().mockResolvedValue(true),
    clearComposerDraftForCurrentContext: vi.fn(),
    persistComposerDraftForCurrentContext: vi.fn(),
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

export function createCodexApi(options: CodexApiFixtureOptions = {}) {
  return {
    activeThreadId: ref(options.activeThreadId ?? 'session-1'),
    threads: ref(options.threads ?? [{ id: 'session-1', modelProvider: 'provider' }]),
    collaborationModes: ref(options.collaborationModes ?? []),
    sendPrompt: vi.fn().mockResolvedValue(undefined),
    refreshThreads: vi.fn().mockResolvedValue(undefined),
    selectModel: vi.fn(),
  };
}

export function deferred<T>(): Deferred<T> {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

export function imageAttachment(): ComposerAttachment {
  return {
    id: 'image',
    filename: 'image.png',
    mime: 'image/png',
    dataUrl: 'data:image/png;base64,AA==',
  };
}

export function createOpenCodeApi(sendPromptAsync = vi.fn().mockResolvedValue(undefined)) {
  return { sendPromptAsync };
}

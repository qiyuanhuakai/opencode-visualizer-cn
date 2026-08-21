import type { Ref } from 'vue';
import type { BackendKind } from '../backends/types';
import type { ComposerAttachment } from '../types/composer';
import type {
  CodexCollaborationModePayload,
  CodexSkill,
  CodexTurnInputItem,
} from '../backends/codex/codexAdapter';
import type { ParsedSkill } from '../utils/parseSkill';
import type { TextTransformer } from '../utils/textTransformers';

export type ModelOption = {
  readonly id: string;
  readonly modelID: string;
  readonly providerID?: string;
};

export type FilteredSession = {
  readonly id: string;
};

export type CommandInfo = {
  readonly name: string;
  readonly agent?: string;
  readonly model?: string;
};

export type AgentInfo = {
  readonly name: string;
};

export type ParsedSlashCommand = {
  readonly name: string;
  readonly arguments: string;
};

export type OpenCodeApiLike = {
  readonly sendPromptAsync: (
    sessionId: string,
    payload: {
      readonly directory: string;
      readonly agent: string;
      readonly model: { readonly providerID?: string; readonly modelID: string };
      readonly variant?: string;
      readonly parts: Record<string, unknown>[];
    },
  ) => Promise<unknown>;
};

export type CodexApiLike = {
  readonly activeThreadId: Ref<string>;
  readonly threads: Ref<
    ReadonlyArray<{ readonly id: string; readonly modelProvider?: string | null }>
  >;
  readonly collaborationModes: Ref<
    ReadonlyArray<{
      readonly mode: string;
      readonly name: string;
      readonly model?: string | null;
      readonly reasoningEffort?: string | null;
    }>
  >;
  readonly sendPrompt: (
    prompt: string,
    options: {
      readonly threadId?: string;
      readonly forceNewThread?: boolean;
      readonly cwd?: string;
      readonly model?: string;
      readonly effort?: string;
      readonly collaborationMode?: CodexCollaborationModePayload;
      readonly input?: CodexTurnInputItem[];
    },
  ) => Promise<unknown>;
  readonly refreshThreads: () => Promise<unknown>;
  readonly selectModel: (modelKey: string) => void;
};

export type BackendMessageSendParams = {
  readonly activeBackendKind: Ref<BackendKind>;
  readonly codexProjectId: string;
  readonly selectedSessionId: Ref<string>;
  readonly selectedModel: Ref<string>;
  readonly selectedMode: Ref<string>;
  readonly selectedThinking: Ref<string | undefined>;
  readonly activeDirectory: Ref<string>;
  readonly messageInput: Ref<string>;
  readonly textTransformersEnabled: Ref<boolean>;
  readonly textTransformers: Ref<TextTransformer[]>;
  readonly attachments: Ref<ComposerAttachment[]>;
  readonly recentUserInputs: { text: string; time: number }[];
  readonly filteredSessions: Ref<FilteredSession[]>;
  readonly canSend: Ref<boolean>;
  readonly isSending: Ref<boolean>;
  readonly codexPendingSessionLock: Ref<string>;
  readonly modelOptions: Ref<ModelOption[]>;
  readonly providerConfig: Ref<Record<string, unknown> | null>;
  readonly openCodeApi: OpenCodeApiLike;
  readonly codexApi: CodexApiLike;
  readonly ensureConnectionReady: (action: string) => boolean;
  readonly translate: (key: string, params?: Record<string, unknown>) => string;
  readonly toErrorMessage: (error: unknown) => string;
  readonly parseSlashCommand: (input: string) => ParsedSlashCommand | null;
  readonly findCommandByName: (name: string) => CommandInfo | null;
  readonly findAgentByName: (name: string) => AgentInfo | null;
  readonly parseAtAgent: (
    input: string,
  ) => { readonly agent: string; readonly text: string } | null;
  readonly parseSkill?: (input: string, skills: ReadonlyArray<CodexSkill>) => ParsedSkill[];
  readonly availableSkills?: Ref<CodexSkill[]>;
  readonly runDebugCommand: (args: string) => { readonly ok: boolean; readonly message: string };
  readonly openShellFromInput: (input: string) => Promise<boolean>;
  readonly clearComposerDraftForCurrentContext: () => void;
  readonly enableFollow: () => void;
  readonly setSendStatusKey: (key: string, params?: Record<string, unknown>) => void;
  readonly setSendStatusText: (text: string) => void;
  readonly pickPreferredSessionId: (list: FilteredSession[]) => string;
  readonly normalizeProjectDirectoryForActiveBackend: (directory: string) => string;
  readonly parseProviderModelKey: (value: string) => {
    readonly providerID: string;
    readonly modelID: string;
  };
  readonly syncCodexActiveProviderModel: (
    providerID: string,
    modelID: string,
  ) => Promise<Record<string, unknown> | null>;
  readonly shouldStartNewCodexThreadForProvider: (sessionId: string, providerID: string) => boolean;
  readonly isProviderEnabled: (providerId: string) => boolean;
  readonly isModelAvailable: (modelId: string) => boolean;
  readonly ensureSelectedModelAvailable: () => void;
  readonly requireSelectedWorktree: (context: 'send') => string;
  readonly sendCommand: (
    sessionId: string,
    command: CommandInfo,
    commandArgs: string,
  ) => Promise<void>;
  readonly buildLineCommentFileUrl: (path: string, startLine: number, endLine: number) => string;
  readonly formatCommentNote: (
    path: string,
    startLine: number,
    endLine: number,
    text: string,
  ) => string;
  readonly resolveAgentMode: (mode: string) => string;
  readonly buildAcpMentionContextParts: (text: string) => Promise<Array<Record<string, unknown>>>;
};

export type SendPreflight = {
  readonly backend: BackendKind;
  readonly sessionId: string;
  readonly text: string;
  readonly transformedText: string;
  readonly hasText: boolean;
  readonly attachments: readonly ComposerAttachment[];
  readonly selectedModel: string;
  readonly selectedMode: string;
  readonly selectedThinking: string | undefined;
  readonly modelProvider: string | undefined;
  readonly modelId: string | undefined;
  readonly codexDirectory: string;
  readonly slash: ParsedSlashCommand | null;
  readonly commandMatch: CommandInfo | null;
  readonly transformText: (value: string) => string;
};

export type RequestGuard = {
  readonly isCurrent: () => boolean;
};

export type LocalSlashResult = 'not-handled' | 'handled' | 'stale';

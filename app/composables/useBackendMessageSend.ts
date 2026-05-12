import type { Ref } from 'vue';
import type { BackendKind } from '../backends/types';
import type { ComposerAttachment } from '../types/composer';
import type { CodexTurnInputItem } from '../backends/codex/codexAdapter';

type ModelOption = {
  id: string;
  modelID: string;
  providerID?: string;
};

type FilteredSession = {
  id: string;
};

type CommandInfo = {
  name: string;
  agent?: string;
  model?: string;
};

type AgentInfo = {
  name: string;
};

type OpenCodeApiLike = {
  sendPromptAsync: (sessionId: string, payload: {
    directory: string;
    agent: string;
    model: { providerID?: string; modelID: string };
    variant?: string;
    parts: Record<string, unknown>[];
  }) => Promise<unknown>;
};

type CodexApiLike = {
  activeThreadId: Ref<string>;
  threads: Ref<Array<{ id: string; modelProvider?: string | null }>>;
  sendPrompt: (prompt: string, options: {
    threadId?: string;
    forceNewThread?: boolean;
    cwd?: string;
    model?: string;
    effort?: string;
    input?: CodexTurnInputItem[];
  }) => Promise<unknown>;
  refreshThreads: () => Promise<unknown>;
  selectModel: (modelKey: string) => void;
};

export function useBackendMessageSend(params: {
  activeBackendKind: Ref<BackendKind>;
  codexProjectId: string;
  selectedSessionId: Ref<string>;
  selectedModel: Ref<string>;
  selectedMode: Ref<string>;
  selectedThinking: Ref<string | undefined>;
  activeDirectory: Ref<string>;
  messageInput: Ref<string>;
  attachments: Ref<ComposerAttachment[]>;
  recentUserInputs: { text: string; time: number }[];
  filteredSessions: Ref<FilteredSession[]>;
  canSend: Ref<boolean>;
  isSending: Ref<boolean>;
  codexPendingSessionLock: Ref<string>;
  modelOptions: Ref<ModelOption[]>;
  commands: Ref<CommandInfo[]>;
  agents: Ref<AgentInfo[]>;
  providerConfig: Ref<Record<string, unknown> | null>;
  hiddenModels: Ref<string[]>;
  openCodeApi: OpenCodeApiLike;
  codexApi: CodexApiLike;
  ensureConnectionReady: (action: string) => boolean;
  translate: (key: string, params?: Record<string, unknown>) => string;
  toErrorMessage: (error: unknown) => string;
  parseSlashCommand: (input: string) => { name: string; arguments: string } | null;
  findCommandByName: (name: string) => CommandInfo | null;
  findAgentByName: (name: string) => AgentInfo | null;
  parseAtAgent: (input: string) => { agent: string; text: string } | null;
  runDebugCommand: (args: string) => { ok: boolean; message: string };
  openShellFromInput: (input: string) => Promise<boolean>;
  clearComposerDraftForCurrentContext: () => void;
  enableFollow: () => void;
  setSendStatusKey: (key: string, params?: Record<string, unknown>) => void;
  setSendStatusText: (text: string) => void;
  pickPreferredSessionId: (list: FilteredSession[]) => string;
  normalizeProjectDirectoryForActiveBackend: (directory: string) => string;
  parseProviderModelKey: (value: string) => { providerID: string; modelID: string };
  syncCodexActiveProviderModel: (providerID: string, modelID: string) => Promise<void>;
  shouldStartNewCodexThreadForProvider: (sessionId: string, providerID: string) => boolean;
  isProviderEnabled: (providerId: string) => boolean;
  isModelAvailable: (modelId: string) => boolean;
  ensureSelectedModelAvailable: () => void;
  requireSelectedWorktree: (context: 'send') => string;
  sendCommand: (sessionId: string, command: CommandInfo, commandArgs: string) => Promise<void>;
  buildLineCommentFileUrl: (path: string, startLine: number, endLine: number) => string;
  formatCommentNote: (path: string, startLine: number, endLine: number, text: string) => string;
}) {
  function appendRecentInput(text: string) {
    if (!text) return;
    params.recentUserInputs.push({ text, time: Date.now() });
    while (params.recentUserInputs.length > 20) params.recentUserInputs.shift();
  }

  async function sendMessage() {
    if (!params.ensureConnectionReady(params.translate('app.actions.sending'))) return;
    if (!params.canSend.value) return;

    const text = params.messageInput.value.trim();
    const hasText = text.length > 0;
    const hasAttachments = params.attachments.value.length > 0;
    let sessionId = params.selectedSessionId.value;
    if ((!hasText && !hasAttachments) || !sessionId) return;

    if (!params.filteredSessions.value.some((session) => session.id === sessionId)) {
      const fallbackId = params.pickPreferredSessionId(params.filteredSessions.value);
      const fallback = fallbackId
        ? params.filteredSessions.value.find((session) => session.id === fallbackId)
        : params.filteredSessions.value[0];
      if (!fallback) {
        params.setSendStatusKey('app.error.noSessionSelected');
        return;
      }
      params.selectedSessionId.value = fallback.id;
      sessionId = fallback.id;
    }

    const slash = hasText ? params.parseSlashCommand(text) : null;
    const commandMatch = slash ? params.findCommandByName(slash.name) : null;

    if (params.activeBackendKind.value === 'codex') {
      const codexDirectory = params.normalizeProjectDirectoryForActiveBackend(params.activeDirectory.value.trim());
      appendRecentInput(hasText ? text : '');
      params.messageInput.value = '';
      params.enableFollow();
      params.isSending.value = true;
      params.setSendStatusKey('app.status.sending');
      try {
        if (slash && slash.name.toLowerCase() === 'shell') {
          if (!await params.openShellFromInput(slash.arguments ?? '')) return;
          params.setSendStatusKey('app.status.shellReady');
          params.clearComposerDraftForCurrentContext();
          return;
        }
        if (slash && slash.name.toLowerCase() === 'debug') {
          const debugResult = params.runDebugCommand(slash.arguments ?? '');
          params.setSendStatusText(debugResult.message);
          params.clearComposerDraftForCurrentContext();
          return;
        }

        const atAgent = hasText ? params.parseAtAgent(text) : null;
        const messageText = atAgent ? atAgent.text : text;
        const codexInput: CodexTurnInputItem[] = [];
        if (messageText) codexInput.push({ type: 'text', text: messageText });
        for (const item of params.attachments.value) {
          if (item.lineComment) {
            codexInput.push({
              type: 'text',
              text: params.formatCommentNote(
                item.lineComment.path,
                item.lineComment.startLine,
                item.lineComment.endLine,
                item.lineComment.text,
              ),
            });
            continue;
          }
          if (!item.mime.startsWith('image/')) {
            params.setSendStatusKey('app.error.unsupportedAttachment');
            return;
          }
          codexInput.push({ type: 'image', url: item.dataUrl });
        }

        const prompt = codexInput
          .filter((item): item is Extract<CodexTurnInputItem, { type: 'text' }> => item.type === 'text')
          .map((item) => item.text)
          .join('\n\n');
        const selectedInfo = params.modelOptions.value.find((model) => model.id === params.selectedModel.value);
        const selectedModelIDs = selectedInfo
          ? { providerID: selectedInfo.providerID?.trim() ?? '', modelID: selectedInfo.modelID.trim() }
          : params.parseProviderModelKey(params.selectedModel.value);
        const selectedCodexModelKey = selectedInfo?.id || params.selectedModel.value.trim();
        const selectedCodexModel = selectedModelIDs.modelID || (!selectedCodexModelKey.includes('/') ? selectedCodexModelKey : undefined);
        const selectedCodexProvider = selectedModelIDs.providerID || (selectedCodexModel ? params.codexProjectId : '');
        const startNewCodexThread = selectedCodexProvider
          ? params.shouldStartNewCodexThreadForProvider(sessionId, selectedCodexProvider)
          : false;
        if (selectedCodexProvider && selectedCodexModel) {
          await params.syncCodexActiveProviderModel(selectedCodexProvider, selectedCodexModel);
        }
        if (selectedCodexModelKey) params.codexApi.selectModel(selectedCodexModelKey);
        await params.codexApi.sendPrompt(prompt, {
          threadId: startNewCodexThread ? undefined : sessionId,
          forceNewThread: startNewCodexThread,
          cwd: codexDirectory,
          model: selectedCodexModel,
          effort: params.selectedThinking.value,
          input: codexInput,
        });
        await params.codexApi.refreshThreads();
        if (params.codexApi.activeThreadId.value) {
          if (startNewCodexThread) params.codexPendingSessionLock.value = params.codexApi.activeThreadId.value;
          params.selectedSessionId.value = params.codexApi.activeThreadId.value;
        }
        params.attachments.value = [];
        params.clearComposerDraftForCurrentContext();
        params.setSendStatusKey('app.status.sent');
      } catch (error) {
        params.setSendStatusKey('app.error.sendFailed', { message: params.toErrorMessage(error) });
      } finally {
        params.isSending.value = false;
      }
      return;
    }

    const selectedInfo = params.modelOptions.value.find((model) => model.id === params.selectedModel.value);
    const selectedModelIDs = params.parseProviderModelKey(params.selectedModel.value);
    const providerID = selectedInfo?.providerID ?? (selectedModelIDs.providerID || undefined);
    const modelID = selectedInfo?.modelID ?? (selectedModelIDs.modelID || undefined);
    if (!providerID || !modelID || !params.isProviderEnabled(providerID) || !params.isModelAvailable(params.selectedModel.value)) {
      params.ensureSelectedModelAvailable();
      params.setSendStatusText('Select an enabled provider/model before sending.');
      return;
    }

    appendRecentInput(hasText ? text : '');
    params.messageInput.value = '';
    params.enableFollow();
    params.isSending.value = true;
    params.setSendStatusKey('app.status.sending');
    try {
      if (slash && slash.name.toLowerCase() === 'shell') {
        if (!await params.openShellFromInput(slash.arguments ?? '')) return;
        params.setSendStatusKey('app.status.shellReady');
        params.clearComposerDraftForCurrentContext();
        return;
      }
      if (slash && slash.name.toLowerCase() === 'debug') {
        const debugResult = params.runDebugCommand(slash.arguments ?? '');
        params.setSendStatusText(debugResult.message);
        params.clearComposerDraftForCurrentContext();
        return;
      }
      if (slash && commandMatch) {
        await params.sendCommand(sessionId, commandMatch, slash.arguments ?? '');
        params.setSendStatusKey('app.status.sent');
        params.clearComposerDraftForCurrentContext();
        return;
      }

      const atAgent = hasText ? params.parseAtAgent(text) : null;
      const agentMatch = atAgent ? params.findAgentByName(atAgent.agent) : null;
      const directory = params.requireSelectedWorktree('send');
      if (!directory) return;
      const parts: Array<Record<string, unknown>> = [];
      const messageText = atAgent ? atAgent.text : text;
      if (hasText && messageText) parts.push({ type: 'text', text: messageText });
      if (hasAttachments) {
        for (const item of params.attachments.value) {
          if (item.lineComment) {
            parts.push({
              type: 'text',
              text: params.formatCommentNote(
                item.lineComment.path,
                item.lineComment.startLine,
                item.lineComment.endLine,
                item.lineComment.text,
              ),
            });
            parts.push({
              type: 'file',
              mime: 'text/plain',
              url: params.buildLineCommentFileUrl(
                item.lineComment.path,
                item.lineComment.startLine,
                item.lineComment.endLine,
              ),
              filename: item.filename.split(':')[0] || item.filename,
            });
          } else {
            parts.push({
              type: 'file',
              mime: item.mime,
              url: item.dataUrl,
              filename: item.filename,
            });
          }
        }
      }
      await params.openCodeApi.sendPromptAsync(sessionId, {
        directory,
        agent: agentMatch?.name ?? params.selectedMode.value,
        model: {
          providerID,
          modelID: modelID || '',
        },
        variant: params.selectedThinking.value,
        parts,
      });
      params.setSendStatusKey('app.status.sent');
      params.attachments.value = [];
      params.clearComposerDraftForCurrentContext();
    } catch (error) {
      params.setSendStatusKey('app.error.sendFailed', { message: params.toErrorMessage(error) });
    } finally {
      params.isSending.value = false;
    }
  }

  return {
    sendMessage,
  };
}

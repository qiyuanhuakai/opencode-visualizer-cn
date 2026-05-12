import { computed, ref, watch, type Ref } from 'vue';
import type { BackendKind } from '../backends/types';
import type { CodexCanonicalHistoryEntry } from '../backends/codex/normalize';
import type { MessageDiffEntry } from '../types/message';
import type { AssistantMessageInfo, MessagePart, ReasoningPart, ToolPart, UserMessageInfo } from '../types/sse';

type SharedMessageStore = {
  loadHistory: (entries: unknown[]) => void;
  updateMessage: (info: AssistantMessageInfo | UserMessageInfo) => void;
  updatePart: (part: MessagePart) => void;
  removeMessage: (id: string) => void;
};

type CodexMessageBridgeApi = {
  realtimeHistoryQueue: Ref<CodexCanonicalHistoryEntry[]>;
  realtimeMessageAliases: Ref<Record<string, string>>;
  realtimeStreamingPart: Ref<{ info: AssistantMessageInfo | UserMessageInfo; part: MessagePart } | null>;
  realtimeReasoningPart: Ref<{ info: AssistantMessageInfo | UserMessageInfo; part: ReasoningPart } | null>;
  realtimeToolParts: Ref<Array<{ info: AssistantMessageInfo | UserMessageInfo; part: ToolPart }>>;
  tokenUsage: Ref<unknown>;
  diffState: Ref<{ threadId: string; turnId: string; diff: string } | null>;
};

function parseCodexDiffEntries(diffText: string): MessageDiffEntry[] {
  const trimmed = diffText.trim();
  if (!trimmed) return [];
  const chunks = trimmed.split(/(?=^diff --git )/m).map((chunk) => chunk.trim()).filter(Boolean);
  if (chunks.length === 0) return [{ file: 'changes.diff', diff: trimmed }];
  return chunks.map((chunk, index) => {
    const match = chunk.match(/^diff --git a\/(.+?) b\/(.+)$/m);
    const file = match?.[2] || match?.[1] || `changes-${index + 1}.diff`;
    return { file, diff: chunk };
  });
}

function buildRealtimeQueueSignature(queue: CodexCanonicalHistoryEntry[]) {
  return queue.map((entry) => `${entry.info.id}:${entry.parts.map((part) => {
    if (part.type === 'tool') {
      const output = part.state.status === 'completed'
        ? part.state.output
        : part.state.status === 'error'
          ? part.state.error
          : part.state.status === 'running'
            ? part.state.metadata?.output || ''
            : '';
      return `${part.id}:${part.state.status}:${output}`;
    }
    if (part.type === 'text' || part.type === 'reasoning') return `${part.id}:${part.text}`;
    return part.id;
  }).join(',')}`).join('|');
}

export function useCodexMessageBridge(params: {
  activeBackendKind: Ref<BackendKind>;
  selectedSessionId: Ref<string>;
  codexPendingSessionLock: Ref<string>;
  history: Ref<CodexCanonicalHistoryEntry[]>;
  codexApi: CodexMessageBridgeApi;
  msg: SharedMessageStore;
  syncRealtimeToolWindows: (entries: CodexCanonicalHistoryEntry[]) => void;
  updateReasoningExpiry: (sessionId: string, state: 'idle' | 'busy') => void;
}) {
  const lastRealtimeQueueSignature = ref('');

  function matchesActiveCodexRealtimeSession(sessionId: string) {
    const target = params.selectedSessionId.value;
    if (!target) return false;
    if (sessionId === target) return true;
    return Boolean(
      params.codexPendingSessionLock.value
      && sessionId === 'codex-pending'
      && target === params.codexPendingSessionLock.value,
    );
  }

  function findCodexHistoryMessage<TMessage extends AssistantMessageInfo | UserMessageInfo>(
    predicate: (info: AssistantMessageInfo | UserMessageInfo) => info is TMessage,
  ): TMessage | null {
    const history = params.history.value;
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const entry = history[index];
      if (!entry) continue;
      const info = entry.info as AssistantMessageInfo | UserMessageInfo;
      if (predicate(info)) return info;
    }
    return null;
  }

  function applyCodexTokenUsageToSharedMessages(rawUsage: unknown) {
    const usage = rawUsage && typeof rawUsage === 'object' ? rawUsage as Record<string, unknown> : null;
    if (!usage) return;
    const assistantInfo = findCodexHistoryMessage((info): info is AssistantMessageInfo => info.role === 'assistant');
    if (!assistantInfo) return;
    const input = typeof usage.inputTokens === 'number' ? usage.inputTokens : 0;
    const output = typeof usage.outputTokens === 'number' ? usage.outputTokens : 0;
    const reasoning = typeof usage.reasoningTokens === 'number' ? usage.reasoningTokens : 0;
    const total = typeof usage.totalTokens === 'number' ? usage.totalTokens : input + output + reasoning;
    params.msg.updateMessage({
      ...assistantInfo,
      tokens: {
        ...assistantInfo.tokens,
        input,
        output,
        reasoning,
        total,
        cache: assistantInfo.tokens.cache,
      },
    });
  }

  function applyCodexDiffStateToSharedMessages(state: { threadId: string; turnId: string; diff: string } | null) {
    if (!state?.turnId || !state.diff.trim()) return;
    const userInfo = findCodexHistoryMessage((info): info is UserMessageInfo => info.role === 'user' && info.id.startsWith(`${state.turnId}:user:`));
    if (!userInfo) return;
    params.msg.updateMessage({
      ...userInfo,
      summary: {
        ...userInfo.summary,
        diffs: parseCodexDiffEntries(state.diff).map((entry) => ({
          file: entry.file,
          patch: entry.diff,
          additions: 0,
          deletions: 0,
        })),
      },
    });
  }

  function reapplyCodexSharedBackfill() {
    if (params.activeBackendKind.value !== 'codex') return;
    if (!params.selectedSessionId.value) return;
    applyCodexTokenUsageToSharedMessages(params.codexApi.tokenUsage.value);
    applyCodexDiffStateToSharedMessages(params.codexApi.diffState.value);
  }

  watch(params.history, (history) => {
    if (params.activeBackendKind.value !== 'codex') return;
    if (!params.selectedSessionId.value) return;
    params.msg.loadHistory(history);
    reapplyCodexSharedBackfill();
  });

  const realtimeQueueSignature = computed(() => buildRealtimeQueueSignature(params.codexApi.realtimeHistoryQueue.value));

  watch(realtimeQueueSignature, (signature) => {
    if (params.activeBackendKind.value !== 'codex') return;
    if (!params.selectedSessionId.value) return;
    if (!signature || signature === lastRealtimeQueueSignature.value) {
      lastRealtimeQueueSignature.value = signature;
      return;
    }
    lastRealtimeQueueSignature.value = signature;
    if (params.codexApi.realtimeHistoryQueue.value.length === 0) return;
    for (const [provisionalId, finalizedId] of Object.entries(params.codexApi.realtimeMessageAliases.value)) {
      if (!provisionalId || !finalizedId || provisionalId === finalizedId) continue;
      params.msg.removeMessage(provisionalId);
    }
    const realtimeEntries = params.codexApi.realtimeHistoryQueue.value.filter((entry) => matchesActiveCodexRealtimeSession(entry.info.sessionID));
    for (const entry of realtimeEntries) {
      params.msg.updateMessage(entry.info as AssistantMessageInfo | UserMessageInfo);
      for (const part of entry.parts) params.msg.updatePart(part);
    }
    params.syncRealtimeToolWindows(realtimeEntries);
  });

  watch(params.selectedSessionId, () => {
    lastRealtimeQueueSignature.value = '';
  });

  watch(params.codexApi.realtimeStreamingPart, (streaming) => {
    if (params.activeBackendKind.value !== 'codex') return;
    if (!params.selectedSessionId.value || !streaming) return;
    if (!matchesActiveCodexRealtimeSession(streaming.info.sessionID)) return;
    params.msg.updateMessage(streaming.info);
    params.msg.updatePart(streaming.part);
    if (streaming.part.type === 'text' && streaming.part.time?.end) {
      params.updateReasoningExpiry(streaming.part.sessionID, 'idle');
    }
  });

  watch(params.codexApi.realtimeReasoningPart, (reasoning) => {
    if (params.activeBackendKind.value !== 'codex') return;
    if (!params.selectedSessionId.value || !reasoning) return;
    if (!matchesActiveCodexRealtimeSession(reasoning.info.sessionID)) return;
    params.msg.updateMessage(reasoning.info);
    params.msg.updatePart(reasoning.part);
    params.updateReasoningExpiry(reasoning.part.sessionID, reasoning.part.time?.end ? 'idle' : 'busy');
  });

  watch(params.codexApi.realtimeToolParts, (toolParts) => {
    if (params.activeBackendKind.value !== 'codex') return;
    if (!params.selectedSessionId.value) return;
    for (const { info, part } of toolParts.filter(({ info }) => matchesActiveCodexRealtimeSession(info.sessionID))) {
      params.msg.updateMessage(info);
      params.msg.updatePart(part);
    }
  }, { deep: true });

  watch(params.codexApi.tokenUsage, (usage) => {
    if (params.activeBackendKind.value !== 'codex') return;
    if (!params.selectedSessionId.value) return;
    applyCodexTokenUsageToSharedMessages(usage);
  }, { deep: true });

  watch(params.codexApi.diffState, (state) => {
    if (params.activeBackendKind.value !== 'codex') return;
    if (!params.selectedSessionId.value) return;
    applyCodexDiffStateToSharedMessages(state);
  }, { deep: true });

  return {
    matchesActiveCodexRealtimeSession,
    reapplyCodexSharedBackfill,
    resetRealtimeQueueSignature() {
      lastRealtimeQueueSignature.value = '';
    },
  };
}

import { computed, ref, watch, type Ref } from 'vue';
import type { BackendKind } from '../backends/types';
import type { CodexCanonicalHistoryEntry } from '../backends/codex/normalize';
import { codexSubagentWindowEntries } from '../utils/codexSubagentWindowEntries';
import type { MessageDiffEntry } from '../types/message';
import type { AssistantMessageInfo, MessagePart, ReasoningPart, TextPart, ToolPart, UserMessageInfo } from '../types/sse';

type SharedMessageStore = {
  loadHistory: (entries: unknown[]) => void;
  updateMessage: (info: AssistantMessageInfo | UserMessageInfo) => void;
  updatePart: (part: MessagePart) => void;
  removeMessage: (id: string) => void;
};

type CodexMessageBridgeApi = {
  realtimeHistoryQueue: Ref<CodexCanonicalHistoryEntry[]>;
  realtimeMessageAliases: Ref<Record<string, string>>;
  realtimeCompletedPart?: Ref<{ info: AssistantMessageInfo | UserMessageInfo; part: MessagePart } | null>;
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
  return JSON.stringify(queue);
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
  onLiveReasoning?: (info: AssistantMessageInfo | UserMessageInfo, part: ReasoningPart) => void;
  onLiveSubagent?: (info: AssistantMessageInfo, part: TextPart) => void;
}) {
  const lastRealtimeQueueSignature = ref('');
  const publishedMessages = new Map<string, string>();
  const publishedParts = new Map<string, string>();
  const liveWindowParts = new Map<string, string>();

  function publishLiveWindow(info: AssistantMessageInfo | UserMessageInfo, part: MessagePart) {
    if (part.type !== 'reasoning' && !(part.type === 'tool' && part.tool === 'task')) return;
    const key = `${info.sessionID}:${part.id}`;
    const signature = JSON.stringify(part);
    if (liveWindowParts.get(key) === signature) return;
    liveWindowParts.set(key, signature);
    if (part.type === 'reasoning') {
      if (part.text.trim()) params.onLiveReasoning?.(info, part);
    } else if (info.role === 'assistant') {
      for (const child of codexSubagentWindowEntries(info, part)) {
        params.onLiveSubagent?.(child.info, child.part);
      }
    }
  }

  function updateMessage(info: AssistantMessageInfo | UserMessageInfo) {
    const signature = JSON.stringify(info);
    if (publishedMessages.get(info.id) === signature) return;
    publishedMessages.set(info.id, signature);
    params.msg.updateMessage(info);
  }

  function updatePart(part: MessagePart) {
    const signature = JSON.stringify(part);
    if (publishedParts.get(part.id) === signature) return;
    publishedParts.set(part.id, signature);
    params.msg.updatePart(part);
  }

  function resetPublishedState() {
    lastRealtimeQueueSignature.value = '';
    liveWindowParts.clear();
    publishedMessages.clear();
    publishedParts.clear();
  }

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
    publishedMessages.clear();
    publishedParts.clear();
    for (const entry of history) {
      publishedMessages.set(entry.info.id, JSON.stringify(entry.info));
      for (const part of entry.parts) publishedParts.set(part.id, JSON.stringify(part));
    }
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
    const queuedIds = new Set(params.codexApi.realtimeHistoryQueue.value.map(entry => entry.info.id));
    for (const id of publishedMessages.keys()) {
      if (id.startsWith('pending-turn:') && !queuedIds.has(id)
        && !params.codexApi.realtimeMessageAliases.value[id]) {
        params.msg.removeMessage(id);
        publishedMessages.delete(id);
      }
    }
    if (params.codexApi.realtimeHistoryQueue.value.length === 0) return;
    for (const [provisionalId, finalizedId] of Object.entries(params.codexApi.realtimeMessageAliases.value)) {
      if (!provisionalId || !finalizedId || provisionalId === finalizedId) continue;
      params.msg.removeMessage(provisionalId);
      publishedMessages.delete(provisionalId);
    }
    const realtimeEntries = params.codexApi.realtimeHistoryQueue.value.filter((entry) => matchesActiveCodexRealtimeSession(entry.info.sessionID));
    for (const entry of realtimeEntries) {
      updateMessage(entry.info);
      for (const part of entry.parts) {
        updatePart(part);
      }
    }
    params.syncRealtimeToolWindows(realtimeEntries);
  });

  watch([params.selectedSessionId, params.activeBackendKind], resetPublishedState, { flush: 'sync' });

  watch(params.codexApi.realtimeStreamingPart, (streaming) => {
    if (params.activeBackendKind.value !== 'codex') return;
    if (!params.selectedSessionId.value || !streaming) return;
    if (!matchesActiveCodexRealtimeSession(streaming.info.sessionID)) return;
    updateMessage(streaming.info);
    updatePart(streaming.part);
    if (!params.onLiveReasoning && streaming.part.type === 'text' && streaming.part.time?.end) {
      params.updateReasoningExpiry(streaming.part.sessionID, 'idle');
    }
  });

  watch(params.codexApi.realtimeReasoningPart, (reasoning) => {
    if (params.activeBackendKind.value !== 'codex') return;
    if (!params.selectedSessionId.value || !reasoning) return;
    if (!matchesActiveCodexRealtimeSession(reasoning.info.sessionID)) return;
    updateMessage(reasoning.info);
    updatePart(reasoning.part);
    publishLiveWindow(reasoning.info, reasoning.part);
    if (!params.onLiveReasoning) params.updateReasoningExpiry(reasoning.part.sessionID, reasoning.part.time?.end ? 'idle' : 'busy');
  });

  if (params.codexApi.realtimeCompletedPart) {
    watch(params.codexApi.realtimeCompletedPart, (entry) => {
      if (params.activeBackendKind.value !== 'codex' || !entry) return;
      if (!matchesActiveCodexRealtimeSession(entry.info.sessionID)) return;
      publishLiveWindow(entry.info, entry.part);
    }, { flush: 'sync' });
  }

  watch(params.codexApi.realtimeToolParts, (toolParts) => {
    if (params.activeBackendKind.value !== 'codex') return;
    if (!params.selectedSessionId.value) return;
    for (const { info, part } of toolParts.filter(({ info }) => matchesActiveCodexRealtimeSession(info.sessionID))) {
      updateMessage(info);
      updatePart(part);
      publishLiveWindow(info, part);
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
      resetPublishedState();
    },
  };
}

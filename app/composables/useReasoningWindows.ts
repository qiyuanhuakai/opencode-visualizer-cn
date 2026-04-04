import { type Component, type Ref } from 'vue';
import type {
  MessagePart,
  MessagePartDeltaPacket,
  MessagePartUpdatedPacket,
  MessageUpdatedPacket,
} from '../types/sse';
import type { SessionScope } from './useGlobalEvents';
import type { useFloatingWindows } from './useFloatingWindows';
import { useStreamingWindowManager } from './useStreamingWindowManager';

export type ReasoningFinish = {
  id: string;
  time: number;
};

type UseReasoningWindowsOptions = {
  scope?: SessionScope;
  selectedSessionId: Ref<string>;
  fw: ReturnType<typeof useFloatingWindows>;
  reasoningComponent: Component;
  theme: () => string;
  reasoningCloseDelayMs: number;
  resolveModelName?: (providerID: string, modelID: string) => string | undefined;
  suppressAutoWindows?: Ref<boolean>;
  t: (key: string, values?: Record<string, string | number>) => string;
};

const REASONING_WINDOW_PREFIX = 'reasoning:';
const REASONING_WINDOW_COLOR = '#8b5cf6';

export function useReasoningWindows(options: UseReasoningWindowsOptions) {
  const {
    selectedSessionId,
    fw,
    reasoningComponent,
    theme,
    reasoningCloseDelayMs,
    resolveModelName,
    suppressAutoWindows,
    t,
  } = options;
  let boundScope = options.scope;

  const lastReasoningMessageIdByKey = new Map<string, string>();
  const activeReasoningMessageIdByKey = new Map<string, string>();
  const finishedReasoningByKey = new Map<string, ReasoningFinish>();

  const manager = useStreamingWindowManager({
    selectedSessionId,
    fw,
    component: reasoningComponent,
    theme,
    closeDelayMs: reasoningCloseDelayMs,
    prefix: REASONING_WINDOW_PREFIX,
    color: REASONING_WINDOW_COLOR,
    suppressAutoWindows,
  });

  function getReasoningKey(sessionId?: string) {
    return sessionId ?? selectedSessionId.value ?? 'main';
  }

  function getReasoningFinish(reasoningKey: string, messageId?: string) {
    const finished = finishedReasoningByKey.get(reasoningKey);
    if (!finished) return null;
    if (messageId && finished.id !== messageId) return null;
    const activeId = activeReasoningMessageIdByKey.get(reasoningKey);
    if (activeId && finished.id !== activeId) return null;
    return finished;
  }

  function markReasoningFinished(sessionId?: string, messageId?: string) {
    const resolvedSessionId = sessionId ?? selectedSessionId.value;
    const reasoningKey = getReasoningKey(resolvedSessionId);
    const activeId = activeReasoningMessageIdByKey.get(reasoningKey);
    const resolvedMessageId = messageId ?? activeId;
    if (!resolvedMessageId) return false;
    if (activeId && resolvedMessageId !== activeId) return false;
    finishedReasoningByKey.set(reasoningKey, { id: resolvedMessageId, time: Date.now() });
    return true;
  }

  function clearReasoningCloseTimer(reasoningKey: string) {
    manager.clearCloseTimer(reasoningKey);
  }

  function clearReasoningCloseTimerForSession(sessionId?: string) {
    clearReasoningCloseTimer(getReasoningKey(sessionId));
  }

  function closeReasoningWindow(sessionId: string) {
    manager.closeWindow(sessionId);
  }

  function updateReasoningExpiry(sessionId: string | undefined, status: 'busy' | 'idle') {
    if (!sessionId && !selectedSessionId.value) return;
    const targetSessionId = sessionId ?? selectedSessionId.value;
    if (!targetSessionId) return;
    const reasoningKey = getReasoningKey(targetSessionId);
    const finish = getReasoningFinish(reasoningKey);
    const isFinished = Boolean(finish);
    if (status === 'idle' && !isFinished) return;
    if (status === 'busy' && isFinished) return;

    if (status === 'idle' && isFinished) {
      closeReasoningWindow(targetSessionId);
    }
  }

  function scheduleReasoningClose(sessionId?: string) {
    const resolvedSessionId = sessionId ?? selectedSessionId.value;
    if (!resolvedSessionId) return;
    manager.scheduleClose(resolvedSessionId);
  }

  function reset() {
    manager.reset();
    lastReasoningMessageIdByKey.clear();
    activeReasoningMessageIdByKey.clear();
    finishedReasoningByKey.clear();
  }

  function handleReasoningPart(part: MessagePart) {
    if (part.type !== 'reasoning') return;

    const resolvedSessionId = part.sessionID || selectedSessionId.value;
    const reasoningKey = getReasoningKey(resolvedSessionId);
    const messageId = part.messageID;
    const partId = part.id;
    const messageText = part.text || '';

    clearReasoningCloseTimerForSession(resolvedSessionId);
    if (finishedReasoningByKey.has(reasoningKey)) {
      finishedReasoningByKey.delete(reasoningKey);
    }

    activeReasoningMessageIdByKey.set(reasoningKey, messageId);
    lastReasoningMessageIdByKey.set(reasoningKey, messageId);

    manager.upsertEntry(resolvedSessionId, partId, messageText);

    const messageInfo = manager.acc.getMessage(messageId)?.info;
    const isSubagent = resolvedSessionId !== selectedSessionId.value;
    let modelLabel: string | undefined;
    if (messageInfo?.role === 'assistant') {
      const displayName = resolveModelName?.(messageInfo.providerID, messageInfo.modelID);
      modelLabel = displayName || messageInfo.modelID;
    }
    const titleTag = modelLabel
      ? isSubagent
        ? `[subagent: ${modelLabel}]`
        : `[${modelLabel}]`
      : isSubagent
        ? '[subagent]'
        : undefined;
    const title = titleTag
      ? t('app.windowTitles.reasoningWithTag', { tag: titleTag })
      : t('app.windowTitles.reasoningSimple');

    manager.openWindow(resolvedSessionId, title);

    if (part.time?.end) {
      markReasoningFinished(resolvedSessionId, messageId);
      scheduleReasoningClose(resolvedSessionId);
    }
  }

  function subscribe(scope: SessionScope) {
    boundScope = scope;
    manager.subscribe(scope, {
      onPartUpdated: (packet: MessagePartUpdatedPacket) => {
        handleReasoningPart(packet.part);
      },
      onPartDelta: (packet: MessagePartDeltaPacket) => {
        if (packet.field !== 'text') return;
        const accumulated = manager.acc.getMessage(packet.messageID);
        const part = accumulated?.parts.get(packet.partID);
        if (!part) return;
        handleReasoningPart(part);
      },
      onMessageUpdated: (packet: MessageUpdatedPacket) => {
        if (packet.info.role !== 'assistant') return;

        const resolvedSessionId = packet.info.sessionID || selectedSessionId.value;
        const messageId = packet.info.id;

        if (packet.info.time.completed || packet.info.error) {
          markReasoningFinished(resolvedSessionId, messageId);
          scheduleReasoningClose(resolvedSessionId);
        }
      },
    });
  }

  if (boundScope) subscribe(boundScope);

  return {
    lastReasoningMessageIdByKey,
    activeReasoningMessageIdByKey,
    finishedReasoningByKey,
    getReasoningKey,
    getReasoningFinish,
    markReasoningFinished,
    clearReasoningCloseTimer,
    clearReasoningCloseTimerForSession,
    updateReasoningExpiry,
    scheduleReasoningClose,
    reset,
    bindScope: subscribe,
  };
}

export type UseReasoningWindowsReturn = ReturnType<typeof useReasoningWindows>;

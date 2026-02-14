import { onUnmounted, reactive, type Component, type Ref } from 'vue';
import type { MessagePartDeltaPacket, MessagePartUpdatedPacket, MessageUpdatedPacket } from '../types/sse';
import type { SessionScope } from './useGlobalEvents';
import type { useFloatingWindows } from './useFloatingWindows';

export type ReasoningFinish = {
  id: string;
  time: number;
};

type ReasoningEntry = {
  id: string;
  text: string;
};

type UseReasoningWindowsOptions = {
  scope?: SessionScope;
  selectedSessionId: Ref<string>;
  fw: ReturnType<typeof useFloatingWindows>;
  reasoningComponent: Component;
  theme: () => string;
  reasoningCloseDelayMs: number;
};

const REASONING_WINDOW_PREFIX = 'reasoning:';
const REASONING_WINDOW_COLOR = '#8b5cf6';

export function useReasoningWindows(options: UseReasoningWindowsOptions) {
  const { selectedSessionId, fw, reasoningComponent, theme, reasoningCloseDelayMs } = options;
  let boundScope = options.scope;

  const entriesBySession = reactive(new Map<string, ReasoningEntry[]>());

  const reasoningCloseTimers = new Map<string, number>();
  const lastReasoningMessageIdByKey = new Map<string, string>();
  const activeReasoningMessageIdByKey = new Map<string, string>();
  const finishedReasoningByKey = new Map<string, ReasoningFinish>();

  function getReasoningKey(sessionId?: string) {
    return sessionId ?? selectedSessionId.value ?? 'main';
  }

  function getWindowKey(sessionId?: string) {
    return `${REASONING_WINDOW_PREFIX}${sessionId || 'main'}`;
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
    const existing = reasoningCloseTimers.get(reasoningKey);
    if (existing === undefined) return;
    window.clearTimeout(existing);
    reasoningCloseTimers.delete(reasoningKey);
  }

  function clearReasoningCloseTimerForSession(sessionId?: string) {
    clearReasoningCloseTimer(getReasoningKey(sessionId));
  }

  function closeReasoningWindow(sessionId: string) {
    const windowKey = getWindowKey(sessionId);
    if (fw.has(windowKey)) {
      void fw.close(windowKey);
    }
    entriesBySession.delete(sessionId);
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
    const reasoningKey = getReasoningKey(resolvedSessionId);
    clearReasoningCloseTimer(reasoningKey);
    if (!resolvedSessionId) return;
    const timer = window.setTimeout(() => {
      reasoningCloseTimers.delete(reasoningKey);
      closeReasoningWindow(resolvedSessionId);
    }, reasoningCloseDelayMs);
    reasoningCloseTimers.set(reasoningKey, timer);
  }

  function reset() {
    reasoningCloseTimers.forEach((timer) => {
      window.clearTimeout(timer);
    });
    reasoningCloseTimers.clear();
    lastReasoningMessageIdByKey.clear();
    activeReasoningMessageIdByKey.clear();
    finishedReasoningByKey.clear();
    entriesBySession.clear();
    fw.entries.value.forEach((entry) => {
      if (!entry.key.startsWith(REASONING_WINDOW_PREFIX)) return;
      void fw.close(entry.key);
    });
  }

  const unsubs: Array<() => void> = [];

  function subscribe(scope: SessionScope) {
    unsubs.forEach((fn) => fn());
    unsubs.length = 0;
    boundScope = scope;

    unsubs.push(
      scope.on('message.part.updated', (packet: MessagePartUpdatedPacket) => {
        if (packet.part.type !== 'reasoning') return;

        const part = packet.part;
        const resolvedSessionId = part.sessionID || selectedSessionId.value;
        const reasoningKey = getReasoningKey(resolvedSessionId);
        const messageId = part.messageID;
        const partId = part.id;
        const messageText = part.text || '';
        const windowKey = getWindowKey(resolvedSessionId);

        clearReasoningCloseTimerForSession(resolvedSessionId);
        if (finishedReasoningByKey.has(reasoningKey)) {
          finishedReasoningByKey.delete(reasoningKey);
        }

        activeReasoningMessageIdByKey.set(reasoningKey, messageId);
        lastReasoningMessageIdByKey.set(reasoningKey, messageId);

        let sessionEntries = entriesBySession.get(resolvedSessionId);
        if (!sessionEntries) {
          sessionEntries = [];
          entriesBySession.set(resolvedSessionId, sessionEntries);
        }
        const existingIndex = sessionEntries.findIndex((e) => e.id === partId);
        if (existingIndex >= 0) {
          sessionEntries[existingIndex] = { id: partId, text: messageText };
        } else {
          sessionEntries.push({ id: partId, text: messageText });
        }

        const firstLine = messageText.split('\n')[0]?.trim() || 'Reasoning';

        void fw.open(windowKey, {
          component: reasoningComponent,
          props: {
            entries: [...sessionEntries],
            theme: theme(),
          },
          title: `🤔 ${firstLine}`,
          scroll: 'follow',
          resizable: true,
          closable: false,
          color: REASONING_WINDOW_COLOR,
          variant: 'message',
          expiresAt: Number.MAX_SAFE_INTEGER,
          width: 600,
          height: 400,
        });

        if (part.time?.end) {
          markReasoningFinished(resolvedSessionId, messageId);
          scheduleReasoningClose(resolvedSessionId);
        }
      }),
    );

    unsubs.push(
      scope.on('message.part.delta', (packet: MessagePartDeltaPacket) => {
        if (packet.field !== 'text') return;

        const resolvedSessionId = packet.sessionID || selectedSessionId.value;
        const sessionEntries = entriesBySession.get(resolvedSessionId);
        if (!sessionEntries) return;
        const existing = sessionEntries.find((e) => e.id === packet.partID);
        if (!existing) return;

        existing.text += packet.delta;

        const windowKey = getWindowKey(resolvedSessionId);
        if (fw.has(windowKey)) {
          const firstLine = sessionEntries[0]?.text.split('\n')[0]?.trim() || 'Reasoning';
          void fw.open(windowKey, {
            component: reasoningComponent,
            props: {
              entries: [...sessionEntries],
              theme: theme(),
            },
            title: `🤔 ${firstLine}`,
            scroll: 'follow',
            resizable: true,
            closable: false,
            color: REASONING_WINDOW_COLOR,
            variant: 'message',
            expiresAt: Number.MAX_SAFE_INTEGER,
            width: 600,
            height: 400,
          });
        }
      }),
    );

    unsubs.push(
      scope.on('message.updated', (packet: MessageUpdatedPacket) => {
        if (packet.info.role !== 'assistant') return;

        const resolvedSessionId = packet.info.sessionID || selectedSessionId.value;
        const messageId = packet.info.id;

        if (packet.info.time.completed || packet.info.error) {
          markReasoningFinished(resolvedSessionId, messageId);
          scheduleReasoningClose(resolvedSessionId);
        }
      }),
    );
  }

  if (boundScope) subscribe(boundScope);

  onUnmounted(() => {
    unsubs.forEach((fn) => fn());
    unsubs.length = 0;
    reasoningCloseTimers.forEach((timer) => {
      window.clearTimeout(timer);
    });
    reasoningCloseTimers.clear();
  });

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

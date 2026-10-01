import { onUnmounted, reactive, watch, type Component, type Ref } from 'vue';
import type {
  MessagePartDeltaPacket,
  MessagePartUpdatedPacket,
  MessageUpdatedPacket,
} from '../types/sse';
import type { SessionScope } from './useGlobalEvents';
import type { useFloatingWindows } from './useFloatingWindows';
import { useDeltaAccumulator } from './useDeltaAccumulator';

type StreamingWindowEntry = {
  id: string;
  text: string;
  completed?: boolean;
};

export type StreamingWindowConfig = {
  selectedSessionId: Ref<string>;
  fw: ReturnType<typeof useFloatingWindows>;
  component: Component;
  theme: () => string;
  closeDelayMs: number;
  prefix: string;
  color?: string;
  suppressAutoWindows?: Ref<boolean>;
  width?: number;
  height?: number;
};

export function useStreamingWindowManager(config: StreamingWindowConfig) {
  const acc = useDeltaAccumulator();
  const entriesBySession = reactive(new Map<string, StreamingWindowEntry[]>());
  const closeTimers = new Map<string, number>();
  const completions = new Map<string, true>();

  function rememberCompletion(sessionId: string, messageId: string, partId?: string) {
    completions.set(JSON.stringify([sessionId, messageId, partId ?? null]), true);
    if (completions.size > 256) {
      const oldest = completions.keys().next().value;
      if (oldest !== undefined) completions.delete(oldest);
    }
  }

  function hasCompletion(sessionId: string, messageId: string, partId: string) {
    return completions.has(JSON.stringify([sessionId, messageId, null]))
      || completions.has(JSON.stringify([sessionId, messageId, partId]));
  }

  function getWindowKey(sessionId: string) {
    return `${config.prefix}${sessionId}`;
  }

  function clearCloseTimer(sessionId: string) {
    const existing = closeTimers.get(sessionId);
    if (existing === undefined) return;
    window.clearTimeout(existing);
    closeTimers.delete(sessionId);
  }

  function scheduleClose(sessionId: string) {
    if (closeTimers.has(sessionId)) return;
    if (!entriesBySession.has(sessionId) && !config.fw.has(getWindowKey(sessionId))) return;
    const timer = window.setTimeout(() => {
      closeTimers.delete(sessionId);
      closeWindow(sessionId);
    }, config.closeDelayMs);
    closeTimers.set(sessionId, timer);
  }

  function closeWindow(sessionId: string) {
    const windowKey = getWindowKey(sessionId);
    if (config.fw.has(windowKey)) {
      void config.fw.close(windowKey);
    }
    entriesBySession.delete(sessionId);
  }

  function resetWindows() {
    closeTimers.forEach((timer) => window.clearTimeout(timer));
    closeTimers.clear();
    entriesBySession.clear();
    const keysToClose: string[] = [];
    for (const entry of config.fw.entries.value) {
      if (entry.key.startsWith(config.prefix)) {
        keysToClose.push(entry.key);
      }
    }
    if (keysToClose.length > 0) {
      const keySet = new Set(keysToClose);
      config.fw.closeAll({ exclude: (key) => !keySet.has(key) });
    }
  }

  function reset() {
    completions.clear();
    resetWindows();
  }

  function upsertEntry(sessionId: string, partId: string, text: string, completed?: boolean) {
    let sessionEntries = entriesBySession.get(sessionId);
    if (!sessionEntries) {
      sessionEntries = [];
      entriesBySession.set(sessionId, sessionEntries);
    }
    const existingIndex = sessionEntries.findIndex((e) => e.id === partId);
    if (existingIndex >= 0) {
      sessionEntries[existingIndex] = { id: partId, text, completed };
    } else {
      sessionEntries.push({ id: partId, text, completed });
    }
    return sessionEntries;
  }

  function openWindow(sessionId: string, title: string) {
    if (config.suppressAutoWindows?.value) return;
    const windowKey = getWindowKey(sessionId);
    void config.fw.open(windowKey, {
      autoOpen: true,
      component: config.component,
      props: {
        entries: [...(entriesBySession.get(sessionId) ?? [])],
        theme: config.theme(),
      },
      title,
      scroll: 'follow',
      resizable: true,
      closable: false,
      color: config.color,
      variant: 'message',
      expiresAt: Number.MAX_SAFE_INTEGER,
      width: config.width ?? 600,
      height: config.height ?? 400,
      afterClose: () => {
        entriesBySession.delete(sessionId);
        clearCloseTimer(sessionId);
      },
    });
  }

  if (config.suppressAutoWindows) {
    watch(config.suppressAutoWindows, (suppressed) => {
      if (suppressed) resetWindows();
    }, { flush: 'sync' });
  }

  const unsubs: Array<() => void> = [];

  function subscribe(
    scope: SessionScope,
    handlers: {
      onPartUpdated: (packet: MessagePartUpdatedPacket) => void;
      onPartDelta: (packet: MessagePartDeltaPacket) => void;
      onMessageUpdated: (packet: MessageUpdatedPacket) => void;
    },
  ) {
    unsubs.forEach((fn) => fn());
    unsubs.length = 0;

    unsubs.push(scope.on('message.part.updated', handlers.onPartUpdated));
    unsubs.push(scope.on('message.part.delta', handlers.onPartDelta));
    unsubs.push(scope.on('message.updated', handlers.onMessageUpdated));
  }

  onUnmounted(() => {
    unsubs.forEach((fn) => fn());
    unsubs.length = 0;
    closeTimers.forEach((timer) => window.clearTimeout(timer));
    closeTimers.clear();
  });

  function markSessionCompleted(sessionId: string) {
    const sessionEntries = entriesBySession.get(sessionId);
    if (!sessionEntries) return;
    for (let i = 0; i < sessionEntries.length; i++) {
      const entry = sessionEntries[i];
      if (!entry.completed) sessionEntries[i] = { ...entry, completed: true };
    }
  }

  return {
    acc,
    entriesBySession,
    closeTimers,
    getWindowKey,
    clearCloseTimer,
    scheduleClose,
    closeWindow,
    reset,
    upsertEntry,
    rememberCompletion,
    hasCompletion,
    markSessionCompleted,
    openWindow,
    subscribe,
  };
}

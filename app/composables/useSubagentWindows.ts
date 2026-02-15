import { onUnmounted, reactive, type Component, type Ref } from 'vue';
import type { MessagePart, MessagePartDeltaPacket, MessagePartUpdatedPacket, MessageUpdatedPacket } from '../types/sse';
import type { SessionScope } from './useGlobalEvents';
import type { useFloatingWindows } from './useFloatingWindows';
import { useDeltaAccumulator } from './useDeltaAccumulator';

type SubagentEntry = {
  id: string;
  text: string;
};

type UseSubagentWindowsOptions = {
  scope?: SessionScope;
  selectedSessionId: Ref<string>;
  fw: ReturnType<typeof useFloatingWindows>;
  subagentComponent: Component;
  theme: () => string;
  closeDelayMs: number;
  resolveModelName?: (providerID: string, modelID: string) => string | undefined;
};

const SUBAGENT_WINDOW_PREFIX = 'subagent:';
const SUBAGENT_WINDOW_COLOR = '#0ea5e9';

export function useSubagentWindows(options: UseSubagentWindowsOptions) {
  const { selectedSessionId, fw, subagentComponent, theme, closeDelayMs, resolveModelName } = options;
  let boundScope = options.scope;
  const acc = useDeltaAccumulator();

  const entriesBySession = reactive(new Map<string, SubagentEntry[]>());

  const closeTimers = new Map<string, number>();
  const activeMessageIdBySession = new Map<string, string>();

  function getWindowKey(sessionId: string) {
    return `${SUBAGENT_WINDOW_PREFIX}${sessionId}`;
  }

  function clearCloseTimer(sessionId: string) {
    const existing = closeTimers.get(sessionId);
    if (existing === undefined) return;
    window.clearTimeout(existing);
    closeTimers.delete(sessionId);
  }

  function closeWindow(sessionId: string) {
    const windowKey = getWindowKey(sessionId);
    if (fw.has(windowKey)) {
      void fw.close(windowKey);
    }
    entriesBySession.delete(sessionId);
    activeMessageIdBySession.delete(sessionId);
  }

  function scheduleClose(sessionId: string) {
    clearCloseTimer(sessionId);
    const timer = window.setTimeout(() => {
      closeTimers.delete(sessionId);
      closeWindow(sessionId);
    }, closeDelayMs);
    closeTimers.set(sessionId, timer);
  }

  function reset() {
    closeTimers.forEach((timer) => {
      window.clearTimeout(timer);
    });
    closeTimers.clear();
    activeMessageIdBySession.clear();
    entriesBySession.clear();
    fw.entries.value.forEach((entry) => {
      if (!entry.key.startsWith(SUBAGENT_WINDOW_PREFIX)) return;
      void fw.close(entry.key);
    });
  }

  function handleTextPart(part: MessagePart) {
    if (part.type !== 'text') return;

    const resolvedSessionId = part.sessionID || selectedSessionId.value;
    if (resolvedSessionId === selectedSessionId.value) return;

    const messageId = part.messageID;
    const partId = part.id;
    const messageText = part.text || '';
    const windowKey = getWindowKey(resolvedSessionId);

    clearCloseTimer(resolvedSessionId);
    activeMessageIdBySession.set(resolvedSessionId, messageId);

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

    const messageInfo = acc.getMessage(messageId)?.info;
    let modelLabel: string | undefined;
    let agentLabel: string | undefined;
    if (messageInfo?.role === 'assistant') {
      const displayName = resolveModelName?.(messageInfo.providerID, messageInfo.modelID);
      modelLabel = displayName || messageInfo.modelID;
      if (messageInfo.agent) {
        agentLabel = messageInfo.agent.charAt(0).toUpperCase() + messageInfo.agent.slice(1);
      }
    }
    const agentPart = agentLabel ? `Agent ${agentLabel} ` : '';
    const title = modelLabel
      ? `🤖 [${modelLabel}] ${agentPart}Working...`
      : `🤖 ${agentPart}Working...`;

    void fw.open(windowKey, {
      component: subagentComponent,
      props: {
        entries: [...sessionEntries],
        theme: theme(),
      },
      title,
      scroll: 'follow',
      resizable: true,
      closable: false,
      color: SUBAGENT_WINDOW_COLOR,
      variant: 'message',
      expiresAt: Number.MAX_SAFE_INTEGER,
      width: 600,
      height: 400,
    });
  }

  const unsubs: Array<() => void> = [];

  function subscribe(scope: SessionScope) {
    unsubs.forEach((fn) => fn());
    unsubs.length = 0;
    boundScope = scope;

    unsubs.push(
      scope.on('message.part.updated', (packet: MessagePartUpdatedPacket) => {
        handleTextPart(packet.part);
      }),
    );

    unsubs.push(
      scope.on('message.part.delta', (packet: MessagePartDeltaPacket) => {
        if (packet.field !== 'text') return;
        const accumulated = acc.getMessage(packet.messageID);
        const part = accumulated?.parts.get(packet.partID);
        if (!part) return;
        handleTextPart(part);
      }),
    );

    unsubs.push(
      scope.on('message.updated', (packet: MessageUpdatedPacket) => {
        if (packet.info.role !== 'assistant') return;

        const resolvedSessionId = packet.info.sessionID || selectedSessionId.value;
        if (resolvedSessionId === selectedSessionId.value) return;

        if (packet.info.time.completed || packet.info.error) {
          scheduleClose(resolvedSessionId);
        }
      }),
    );
  }

  if (boundScope) subscribe(boundScope);

  onUnmounted(() => {
    unsubs.forEach((fn) => fn());
    unsubs.length = 0;
    closeTimers.forEach((timer) => {
      window.clearTimeout(timer);
    });
    closeTimers.clear();
  });

  return {
    reset,
    bindScope: subscribe,
  };
}

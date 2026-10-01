import { type Component, type Ref } from 'vue';
import type {
  MessageInfo,
  MessagePart,
  MessagePartDeltaPacket,
  MessagePartUpdatedPacket,
  MessageUpdatedPacket,
} from '../types/sse';
import type { SessionScope } from './useGlobalEvents';
import type { useFloatingWindows } from './useFloatingWindows';
import { useStreamingWindowManager } from './useStreamingWindowManager';

type UseSubagentWindowsOptions = {
  scope?: SessionScope;
  selectedSessionId: Ref<string>;
  fw: ReturnType<typeof useFloatingWindows>;
  subagentComponent: Component;
  theme: () => string;
  closeDelayMs: number;
  resolveModelName?: (providerID: string, modelID: string) => string | undefined;
  suppressAutoWindows?: Ref<boolean>;
};

const SUBAGENT_WINDOW_PREFIX = 'subagent:';
export function useSubagentWindows(options: UseSubagentWindowsOptions) {
  const {
    selectedSessionId,
    fw,
    subagentComponent,
    theme,
    closeDelayMs,
    resolveModelName,
    suppressAutoWindows,
  } = options;
  let boundScope = options.scope;

  const activeMessageIdBySession = new Map<string, string>();

  const manager = useStreamingWindowManager({
    selectedSessionId,
    fw,
    component: subagentComponent,
    theme,
    closeDelayMs,
    prefix: SUBAGENT_WINDOW_PREFIX,
    suppressAutoWindows,
  });

  function reset() {
    manager.reset();
    activeMessageIdBySession.clear();
  }

  function handleTextPart(part: MessagePart, info?: MessageInfo) {
    if (part.type !== 'text') return;
    if (suppressAutoWindows?.value) return;

    const resolvedSessionId = part.sessionID || selectedSessionId.value;
    if (resolvedSessionId === selectedSessionId.value) return;

    const messageId = part.messageID;
    const partId = part.id;
    const messageText = part.text || '';

    const messageInfo = info ?? manager.acc.getMessage(messageId)?.info;
    const previous = manager.entriesBySession.get(resolvedSessionId)?.find(entry => entry.id === partId);
    const activeId = activeMessageIdBySession.get(resolvedSessionId);
    const knownCompleted = manager.hasCompletion(resolvedSessionId, messageId, partId);
    if (knownCompleted && (!previous || activeId !== messageId)) return;
    if (previous && activeId && activeId !== messageId) return;
    const completed = knownCompleted || part.time?.end !== undefined || previous?.completed === true
      || (messageInfo?.role === 'assistant' && (messageInfo.time.completed !== undefined || !!messageInfo.error));
    if (completed) manager.rememberCompletion(resolvedSessionId, messageId, partId);
    if (messageInfo?.role === 'assistant' && (messageInfo.time.completed !== undefined || messageInfo.error)) {
      manager.rememberCompletion(resolvedSessionId, messageId);
    }
    if (!completed) manager.clearCloseTimer(resolvedSessionId);
    activeMessageIdBySession.set(resolvedSessionId, messageId);

    manager.upsertEntry(resolvedSessionId, partId, messageText, completed);

    let modelLabel: string | undefined;
    let agentLabel: string | undefined;
    if (messageInfo?.role === 'assistant') {
      const displayName = resolveModelName?.(messageInfo.providerID, messageInfo.modelID);
      modelLabel = displayName || messageInfo.modelID;
      if (messageInfo.agent) {
        agentLabel = messageInfo.mode === 'codex' ? messageInfo.agent
          : messageInfo.agent.charAt(0).toUpperCase() + messageInfo.agent.slice(1);
      }
    }
    const agentPart = agentLabel ? `Agent ${agentLabel} ` : '';
    const title = modelLabel
      ? `🤖 [${modelLabel}] ${agentPart}Working...`
      : `🤖 ${agentPart}Working...`;

    if (completed) manager.markSessionCompleted(resolvedSessionId);
    manager.openWindow(resolvedSessionId, title);

    if (completed) {
      manager.scheduleClose(resolvedSessionId);
    }
  }

  function subscribe(scope: SessionScope) {
    boundScope = scope;
    manager.subscribe(scope, {
      onPartUpdated: (packet: MessagePartUpdatedPacket) => {
        handleTextPart(packet.part);
      },
      onPartDelta: (packet: MessagePartDeltaPacket) => {
        if (packet.field !== 'text') return;
        const accumulated = manager.acc.getMessage(packet.messageID);
        const part = accumulated?.parts.get(packet.partID);
        if (!part) return;
        handleTextPart(part);
      },
      onMessageUpdated: (packet: MessageUpdatedPacket) => {
        if (packet.info.role !== 'assistant') return;

        const resolvedSessionId = packet.info.sessionID || selectedSessionId.value;
        if (resolvedSessionId === selectedSessionId.value) return;

        if (packet.info.time.completed !== undefined || packet.info.error) {
          manager.rememberCompletion(resolvedSessionId, packet.info.id);
          const activeId = activeMessageIdBySession.get(resolvedSessionId);
          if (activeId && activeId !== packet.info.id) return;
          manager.markSessionCompleted(resolvedSessionId);
          manager.scheduleClose(resolvedSessionId);
        }
      },
    });
  }

  if (boundScope) subscribe(boundScope);

  return {
    reset,
    entriesBySession: manager.entriesBySession,
    bindScope: subscribe,
    handlePart: handleTextPart,
  };
}

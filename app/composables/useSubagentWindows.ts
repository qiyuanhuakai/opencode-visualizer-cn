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
const SUBAGENT_WINDOW_COLOR = '#0ea5e9';

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
    color: SUBAGENT_WINDOW_COLOR,
    suppressAutoWindows,
  });

  function reset() {
    manager.reset();
    activeMessageIdBySession.clear();
  }

  function handleTextPart(part: MessagePart) {
    if (part.type !== 'text') return;

    const resolvedSessionId = part.sessionID || selectedSessionId.value;
    if (resolvedSessionId === selectedSessionId.value) return;

    const messageId = part.messageID;
    const partId = part.id;
    const messageText = part.text || '';

    manager.clearCloseTimer(resolvedSessionId);
    activeMessageIdBySession.set(resolvedSessionId, messageId);

    manager.upsertEntry(resolvedSessionId, partId, messageText);

    const messageInfo = manager.acc.getMessage(messageId)?.info;
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

    manager.openWindow(resolvedSessionId, title);

    if (part.time?.end) {
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

        if (packet.info.time.completed || packet.info.error) {
          manager.scheduleClose(resolvedSessionId);
        }
      },
    });
  }

  if (boundScope) subscribe(boundScope);

  return {
    reset,
    bindScope: subscribe,
  };
}

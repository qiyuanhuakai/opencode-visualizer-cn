import type { BackendSessionInfo } from '../types/backend-domain';
import type { MessageInfo, MessagePart } from '../types/sse';
import type { AcpClientEvent, AcpPermissionRequest } from '../backends/acp/acpClient';

type AcpEventSource = {
  onEvent(handler: (event: AcpClientEvent) => void): () => void;
};

type AcpMessageBridgeBinding = {
  bind(source: AcpEventSource): void;
  stop(): void;
};

export function syncAcpMessageBridge(
  bridge: AcpMessageBridgeBinding,
  backendKind: 'opencode' | 'codex' | 'acp',
  source?: AcpEventSource,
) {
  if (backendKind === 'acp' && source) bridge.bind(source);
  else bridge.stop();
}

export function useAcpMessageBridge(options: {
  msg: {
    updateMessage(info: MessageInfo): void;
    updatePart(part: MessagePart): void;
  };
  upsertPermissionEntry(request: AcpPermissionRequest): void;
  onSessionUpdated(info: BackendSessionInfo): void;
  onSessionDeleted?(sessionId: string): void;
  onCommandsUpdated?(commands: Array<Record<string, unknown>>): void;
  onConfigUpdated?(options: unknown[]): void;
  onToolPart?(part: MessagePart): void;
}) {
  let unsubscribe: (() => void) | undefined;

  function stop() {
    unsubscribe?.();
    unsubscribe = undefined;
  }

  function bind(source: AcpEventSource) {
    stop();
    unsubscribe = source.onEvent((event) => {
      if (event.type === 'message.updated') {
        options.msg.updateMessage(event.info);
      } else if (event.type === 'message.part.updated') {
        options.msg.updatePart(event.part);
        if (!event.replay && event.part.type === 'tool') options.onToolPart?.(event.part);
      } else if (event.type === 'permission.asked') {
        options.upsertPermissionEntry(event.request);
      } else if (event.type === 'session.updated') {
        options.onSessionUpdated(event.info);
      } else if (event.type === 'commands.updated') {
        options.onCommandsUpdated?.(event.commands);
      } else if (event.type === 'config.updated') {
        options.onConfigUpdated?.(event.options);
      } else {
        options.onSessionDeleted?.(event.sessionId);
      }
    });
  }

  return { bind, stop };
}

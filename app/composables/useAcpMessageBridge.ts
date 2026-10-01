import type { BackendKind } from '../backends/types';
import type { BackendSessionInfo } from '../types/backend-domain';
import type { MessageInfo, MessagePart, ToolPart } from '../types/sse';
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
  backendKind: BackendKind,
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
  onTaskCompleted?(completion: { sessionId: string; completionId: string }): void;
  onCommandsUpdated?(commands: Array<Record<string, unknown>>): void;
  onConfigUpdated?(options: unknown[]): void;
  onToolPart?(part: MessagePart): void;
  onReconcileToolPart?(part: ToolPart): void;
}) {
  let unsubscribe: (() => void) | undefined;
  const toolSignatures = new Map<string, string>();

  function stop() {
    unsubscribe?.();
    unsubscribe = undefined;
    toolSignatures.clear();
  }

  function bind(source: AcpEventSource) {
    stop();
    unsubscribe = source.onEvent((event) => {
      if (event.type === 'message.updated') {
        options.msg.updateMessage(event.info);
      } else if (event.type === 'message.part.updated') {
        options.msg.updatePart(event.part);
        if (event.part.type === 'tool') {
          const signature = JSON.stringify(event.part);
          if (toolSignatures.get(event.part.id) !== signature) {
            if (event.replay && event.part.state.status !== 'completed' && event.part.state.status !== 'error') return;
            toolSignatures.set(event.part.id, signature);
            if (event.replay) options.onReconcileToolPart?.(event.part);
            else options.onToolPart?.(event.part);
          }
        }
      } else if (event.type === 'permission.asked') {
        options.upsertPermissionEntry(event.request);
      } else if (event.type === 'session.updated') {
        options.onSessionUpdated(event.info);
      } else if (event.type === 'commands.updated') {
        options.onCommandsUpdated?.(event.commands);
      } else if (event.type === 'config.updated') {
        options.onConfigUpdated?.(event.options);
      } else if (event.type === 'session.promptCompleted') {
        options.onTaskCompleted?.({
          sessionId: event.sessionId,
          completionId: event.completionId,
        });
      } else if (event.type === 'session.deleted') {
        options.onSessionDeleted?.(event.sessionId);
      }
    });
  }

  return { bind, stop };
}

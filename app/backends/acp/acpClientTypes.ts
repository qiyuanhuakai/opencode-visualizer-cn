import type { BackendSessionInfo } from '../../types/backend-domain';
import type { MessagePart } from '../../types/sse';
import type { CodexWebSocketConstructor } from '../codex/jsonRpcClient';
import type { AcpHistoryEntry } from './history';
import type { AcpPermissionRequest } from './permissionStore';

export type AcpClientEvent =
  | { type: 'message.updated'; info: AcpHistoryEntry['info'] }
  | { type: 'message.part.updated'; part: MessagePart }
  | { type: 'permission.asked'; request: AcpPermissionRequest }
  | { type: 'commands.updated'; commands: Array<Record<string, unknown>> }
  | { type: 'config.updated'; options: unknown[] }
  | { type: 'session.updated'; info: BackendSessionInfo }
  | { type: 'session.deleted'; sessionId: string };

export type AcpClientOptions = {
  url: string;
  bridgeUrl?: string;
  bridgeToken?: string;
  agentId: string;
  now?: () => number;
  webSocketCtor?: CodexWebSocketConstructor;
};

export type AcpPromptPayload = {
  directory: string;
  agent: string;
  model: { providerID?: string; modelID: string };
  variant?: string;
  parts: Array<Record<string, unknown>>;
};

import type {
  ApprovalDecision,
  ApprovalKind,
  BridgeErrorData,
  PluginInfo,
  ProviderInfo,
  SessionInfo,
  UsageInfo,
} from './models';

export type BridgeEventPayloadMap = {
  'bridge.ready': {
    version: string;
    startedAt: number;
  };
  'bridge.degraded': {
    healthy: boolean;
    notes: string[];
  };
  'provider.updated': {
    provider: ProviderInfo;
  };
  'plugin.updated': {
    plugin: PluginInfo;
  };
  'session.created': {
    session: SessionInfo;
  };
  'session.updated': {
    session: SessionInfo;
  };
  'session.completed': {
    sessionID: string;
    status: 'completed' | 'cancelled' | 'error';
  };
  'session.error': {
    sessionID: string;
    error: BridgeErrorData;
  };
  'message.started': {
    sessionID: string;
    messageID: string;
    role: 'assistant' | 'user' | 'system';
  };
  'message.delta': {
    sessionID: string;
    messageID: string;
    delta: string;
  };
  'message.completed': {
    sessionID: string;
    messageID: string;
    text: string;
    usage?: UsageInfo;
  };
  'tool.started': {
    sessionID: string;
    toolCallID: string;
    toolName: string;
    title?: string;
    metadata?: Record<string, unknown>;
  };
  'tool.completed': {
    sessionID: string;
    toolCallID: string;
    toolName: string;
    output?: unknown;
  };
  'tool.failed': {
    sessionID: string;
    toolCallID: string;
    toolName: string;
    error: BridgeErrorData;
  };
  'approval.requested': {
    sessionID: string;
    requestID: string;
    kind: ApprovalKind;
    title: string;
    details?: string;
    metadata?: Record<string, unknown>;
  };
  'approval.resolved': {
    sessionID: string;
    requestID: string;
    decision: ApprovalDecision;
  };
};

export type BridgeEventType = keyof BridgeEventPayloadMap;

export type BridgeEvent<T extends BridgeEventType = BridgeEventType> = {
  id: string;
  type: T;
  time: number;
  sessionID?: string;
  providerID?: string;
  pluginID?: string;
  data: BridgeEventPayloadMap[T];
};

export type BridgeEventSink = {
  emit<T extends BridgeEventType>(event: BridgeEvent<T>): void | Promise<void>;
};

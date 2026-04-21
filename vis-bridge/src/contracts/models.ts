export type ProviderCapabilities = {
  streaming: boolean;
  resume: boolean;
  approval: boolean;
  tools: boolean;
  structuredOutput: boolean;
};

export type ProviderInfo = {
  id: string;
  label: string;
  available: boolean;
  version?: string;
  reason?: string;
  capabilities: ProviderCapabilities;
};

export type PluginContribution = 'tool' | 'command' | 'context' | 'status' | 'metrics';

export type PluginSource = 'bridge-config' | 'project-config' | 'discovery';

export type PluginInfo = {
  id: string;
  label: string;
  source: PluginSource;
  available: boolean;
  loaded: boolean;
  path?: string;
  reason?: string;
  contributes: PluginContribution[];
};

export type SessionStatus =
  | 'idle'
  | 'running'
  | 'awaiting-approval'
  | 'completed'
  | 'error'
  | 'cancelled';

export type BridgeErrorData = {
  code: string;
  message: string;
  providerID?: string;
  pluginID?: string;
  sessionID?: string;
  details?: Record<string, unknown>;
};

export type UsageInfo = {
  input?: number;
  output?: number;
  reasoning?: number;
  cacheRead?: number;
  cacheWrite?: number;
  contextLimit?: number;
};

export type SessionInfo = {
  id: string;
  providerID: string;
  directory?: string;
  title?: string;
  model?: string;
  status: SessionStatus;
  createdAt: number;
  updatedAt: number;
  pluginIDs: string[];
  lastError?: BridgeErrorData;
  metadata: Record<string, unknown>;
};

export type BridgeHealth = {
  healthy: boolean;
  version: string;
  startedAt: number;
  uptimeMs: number;
  providers: { available: number; total: number };
  plugins: { available: number; total: number };
  degraded: boolean;
  notes: string[];
};

export type ApprovalDecision = 'once' | 'always' | 'reject';

export type ApprovalKind = 'permission' | 'tool' | 'command';

export type ApprovalRequest = {
  requestID: string;
  sessionID: string;
  kind: ApprovalKind;
  title: string;
  details?: string;
  metadata?: Record<string, unknown>;
};

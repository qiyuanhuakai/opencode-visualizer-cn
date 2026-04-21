import type {
  ApprovalRequest,
  ApprovalDecision,
  BridgeHealth,
  PluginInfo,
  ProviderInfo,
  SessionInfo,
} from './models';

export type CreateSessionRequest = {
  providerID: string;
  directory?: string;
  title?: string;
  model?: string;
  pluginIDs?: string[];
  metadata?: Record<string, unknown>;
};

export type SendPromptRequest = {
  prompt: string;
  attachments?: Array<{
    type: string;
    name?: string;
    path?: string;
    content?: string;
  }>;
  metadata?: Record<string, unknown>;
};

export type ResolveApprovalRequest = {
  requestID: string;
  decision: ApprovalDecision;
};

export type PromptAcceptedResponse = {
  accepted: boolean;
  sessionID: string;
  turnID: string;
};

export type ApprovalAcceptedResponse = {
  accepted: boolean;
  sessionID: string;
  requestID: string;
};

export type CancelAcceptedResponse = {
  accepted: boolean;
  sessionID: string;
};

export type BridgeApi = {
  getHealth(): Promise<BridgeHealth>;
  listProviders(): Promise<ProviderInfo[]>;
  listPlugins(query?: { directory?: string; providerID?: string }): Promise<PluginInfo[]>;
  listSessions(query?: { directory?: string; providerID?: string; status?: string }): Promise<SessionInfo[]>;
  createSession(body: CreateSessionRequest): Promise<SessionInfo>;
  getSession(sessionID: string): Promise<SessionInfo>;
  sendPrompt(sessionID: string, body: SendPromptRequest): Promise<PromptAcceptedResponse>;
  resolveApproval(
    sessionID: string,
    body: ResolveApprovalRequest,
  ): Promise<ApprovalAcceptedResponse>;
  cancelSession(sessionID: string): Promise<CancelAcceptedResponse>;
  deleteSession(sessionID: string): Promise<boolean>;
};

export type PendingApprovalState = ApprovalRequest & {
  providerID?: string;
};

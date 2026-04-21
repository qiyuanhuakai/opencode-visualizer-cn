import type { ResolveApprovalRequest, SendPromptRequest } from '../contracts/api';
import type { BridgeEventSink } from '../contracts/events';
import type { ProviderInfo, SessionInfo } from '../contracts/models';

export type ProviderProbeContext = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

export type ProviderSessionContext = {
  session: SessionInfo;
  eventSink: BridgeEventSink;
  signal?: AbortSignal;
};

export type ProviderSessionRuntime = {
  sendPrompt(body: SendPromptRequest): Promise<{ turnID: string }>;
  resolveApproval(body: ResolveApprovalRequest): Promise<void>;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
};

export type ProviderModule = {
  readonly id: string;
  readonly label: string;
  probe(context?: ProviderProbeContext): Promise<ProviderInfo>;
  createSession(context: ProviderSessionContext): Promise<ProviderSessionRuntime>;
  resumeSession?(context: ProviderSessionContext): Promise<ProviderSessionRuntime>;
};

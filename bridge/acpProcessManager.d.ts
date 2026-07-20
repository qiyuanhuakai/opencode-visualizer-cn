import type { AcpAgentConfig } from './bridgeConfig.js';

export type AcpClient = {
  send(message: string): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (message: string) => void): unknown;
  on(event: 'close', listener: () => void): unknown;
  off(event: 'message', listener: (message: string) => void): unknown;
  off(event: 'close', listener: () => void): unknown;
};

export type AcpProcessStatus = {
  id: string;
  name: string;
  kind: 'acp';
  command: string;
  args: string[];
  enabled: boolean;
  state: 'disabled' | 'stopped' | 'starting' | 'running' | 'stopping' | 'error';
  owned: boolean;
  connected: boolean;
  droppedFrames: number;
  pid?: number;
  error?: string;
};

export type AcpProcessManager = {
  reconcile(agents: AcpAgentConfig[]): Promise<AcpProcessStatus[]>;
  attach(id: string, client: AcpClient): void;
  getStatus(): AcpProcessStatus[];
  stopAll(): Promise<void>;
};

export type AcpClientRequest = Record<string, unknown> & {
  id: string | number;
  method: string;
};

export type AcpProcessManagerOptions = {
  handleClientRequest?: ((
    request: AcpClientRequest,
    context: { agentId: string },
  ) => Promise<unknown> | unknown) & {
    observeClientMessage?: (message: Record<string, unknown>, context: { agentId: string }) => void;
    observeAgentMessage?: (message: Record<string, unknown>, context: { agentId: string }) => void;
  };
};

export function createAcpProcessManager(options?: AcpProcessManagerOptions): AcpProcessManager;

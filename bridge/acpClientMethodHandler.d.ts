import type { AcpClientRequest } from './acpProcessManager.js';

export type AcpClientMethodContext = { agentId: string };
export type AcpObservedMessage = Record<string, unknown> & {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
};

export type AcpClientMethodHandler = {
  (request: AcpClientRequest, context: AcpClientMethodContext): Promise<unknown>;
  observeClientMessage(message: AcpObservedMessage, context: AcpClientMethodContext): void;
  observeAgentMessage(message: AcpObservedMessage, context: AcpClientMethodContext): void;
  stopAll(): Promise<void>;
};

export function createAcpClientMethodHandler(options?: object): AcpClientMethodHandler;

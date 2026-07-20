import type { Server } from 'node:http';
import type { BridgeRuntime } from './bridge/bridgeRuntime.js';
import type { AcpAgentActions } from './bridge/acpAgentActions.js';

export type VisBridgeServerOptions = {
  host?: string;
  path: string;
  target: string;
  bridgeToken?: string;
  upstreamAuthorization?: string;
  ptyModule?: unknown;
  runtime?: BridgeRuntime;
  agentActions?: AcpAgentActions;
};

export function createVisBridgeServer(options: VisBridgeServerOptions): Server;
export function main(): void;

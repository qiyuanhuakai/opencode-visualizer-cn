import type { Server } from 'node:http';
import type { BridgeRuntime } from './bridge/bridgeRuntime.js';
import type { AcpAgentActions } from './bridge/acpAgentActions.js';

export type VisBridgeServerOptions = {
  host?: string;
  port?: number;
  path: string;
  target: string;
  bridgeToken?: string;
  upstreamAuthorization?: string;
  ptyModule?: unknown;
  runtime?: BridgeRuntime;
  agentActions?: AcpAgentActions;
};

export type VisBridgeServer = Server & {
  stopOwnedProcesses(): Promise<void>;
};

export function createVisBridgeServer(options: VisBridgeServerOptions): VisBridgeServer;
export type VisBridgeServerCliOptions = {
  readonly command: 'start' | 'restart' | '__daemon';
  readonly help: boolean;
  readonly serverArgs: readonly string[];
  readonly host: string;
  readonly port: number;
  readonly path: string;
  readonly target: string;
  readonly bridgeToken?: string;
  readonly upstreamAuthorization?: string;
  readonly configPath?: string;
};

export type VisBridgeStopCliOptions = {
  readonly command: 'stop';
  readonly help: boolean;
  readonly serverArgs: readonly [];
};

export function parseCliOptions(
  argv?: readonly string[],
  env?: NodeJS.ProcessEnv,
): VisBridgeServerCliOptions | VisBridgeStopCliOptions;
export function main(): Promise<void>;

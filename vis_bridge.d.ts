import type { Server } from 'node:http';

export type VisBridgeServerOptions = {
  host?: string;
  path: string;
  target: string;
  bridgeToken?: string;
  upstreamAuthorization?: string;
  ptyModule?: unknown;
};

export function createVisBridgeServer(options: VisBridgeServerOptions): Server;
export function main(): void;

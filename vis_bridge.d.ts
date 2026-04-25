import type { Server } from 'node:http';

export type VisBridgeServerOptions = {
  path: string;
  target: string;
  bridgeToken?: string;
  upstreamAuthorization?: string;
};

export function createVisBridgeServer(options: VisBridgeServerOptions): Server;
export function main(): void;

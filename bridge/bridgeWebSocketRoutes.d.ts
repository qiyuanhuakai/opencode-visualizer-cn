import type { RawHttpSocket } from './bridgeHttp.js';

export type UpgradeRequest = {
  readonly url?: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
};

export function handlePtyUpgrade(
  request: UpgradeRequest,
  socket: RawHttpSocket,
  head: Buffer,
  options: Readonly<Record<string, unknown>>,
  manager: { attach(id: string, socket: RawHttpSocket, head: Buffer): boolean },
): boolean;

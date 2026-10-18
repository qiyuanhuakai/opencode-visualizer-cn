export type RelaySpawnSpec = {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string | undefined>;
  readonly cwd?: string;
};
export type RelayOwnedProcess = {
  readonly id: string;
  readonly pid: number | undefined;
  readonly child: unknown;
  readonly owned: true;
};
export type ProcessRelay = {
  spawnOwned(spec: RelaySpawnSpec): RelayOwnedProcess;
  isOwned(id: string): boolean;
  ownedIds(): readonly string[];
  pids(): readonly (number | undefined)[];
  send(id: string, data: string | Buffer): void;
  onMessage(id: string, handler: (payload: Buffer) => void): void;
  onExit(id: string, handler: (code: number | null) => void): void;
  terminate(id: string): Promise<boolean>;
  terminateAll(): Promise<void>;
};
export type ProcessRelayOptions = {
  readonly spawn?: (command: string, args: readonly string[], options: Record<string, unknown>) => unknown;
  readonly stopProcessTree?: (child: unknown, options?: unknown) => unknown;
  readonly platform?: string;
  readonly maxFrameBytes?: number;
};
export const RELAY_MAX_FRAME_BYTES: number;
export function encodeRelayFrame(data: string | Buffer, options?: { readonly maxFrameBytes?: number }): Buffer;
export function decodeRelayFrames(buffer: Buffer, options?: { readonly maxFrameBytes?: number }): {
  frames: Buffer[];
  remaining: Buffer;
};
export function createProcessRelay(options?: ProcessRelayOptions): ProcessRelay;

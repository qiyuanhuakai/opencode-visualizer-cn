import type { RelayBinding, RelayHandshake } from './relayHandshake.js';

export const RELAY_TAG: {
  readonly control: 1;
  readonly data: 2;
  readonly storageRequest: 3;
  readonly storageAck: 4;
};
export const RELAY_STORAGE_OPS: readonly string[];
export const RELAY_ROLES: readonly string[];

export function encodeRelayMessage(
  tag: number,
  payload: string | Buffer | unknown,
  options?: { readonly maxFrameBytes?: number },
): Buffer;

export function decodeRelayMessages(
  buffer: Buffer,
  options?: { readonly maxFrameBytes?: number },
): { messages: readonly { readonly tag: number; readonly payload: Buffer }[]; remaining: Buffer };

export interface RelayStorageRequest {
  readonly id: string;
  readonly op: string;
  readonly params: Record<string, unknown>;
}

export interface RelayChannel {
  readonly role: string;
  readonly binding: RelayBinding;
  readonly ready: Promise<{ readonly role: string; readonly binding: RelayBinding }>;
  state(): string;
  onData(handler: (payload: Buffer) => void): RelayChannel;
  onControl(handler: (message: unknown) => void): RelayChannel;
  onStorageRequest(handler: (request: RelayStorageRequest) => unknown): RelayChannel;
  onClose(handler: () => void): RelayChannel;
  sendData(payload: Buffer): void;
  sendControl(message: unknown): void;
  requestStore(
    op: string,
    params?: Record<string, unknown>,
  ): Promise<{ readonly ok: boolean; readonly durable?: boolean; readonly value?: unknown }>;
  close(): void;
}

export function createRelayChannel(
  stream: unknown,
  options: { handshake: RelayHandshake; role: string; timeoutMs?: number },
): RelayChannel;

export function dispatchStoreOperation(
  store: unknown,
  request: { readonly op: string; readonly params?: Record<string, unknown> },
): Promise<{ readonly ok: boolean; readonly durable: boolean; readonly value?: unknown }>;

export interface ComputeRelay {
  readonly mode: string;
  state(): string;
  connectionCount(): number;
  jobBindings(): readonly RelayBinding[];
  onConnection(handler: (channel: RelayChannel) => void): ComputeRelay;
  listen(): Promise<{ readonly mode: string; readonly host?: string; readonly port?: number; readonly path?: string }>;
  close(): Promise<void>;
}

export function createComputeRelay(options: {
  handshake: RelayHandshake;
  mode: string;
  host?: string;
  port?: number;
  socketPath?: string;
  timeoutMs?: number;
  createServer?: () => unknown;
}): ComputeRelay;

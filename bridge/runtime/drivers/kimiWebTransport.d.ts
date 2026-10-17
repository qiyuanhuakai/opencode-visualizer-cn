import type { JsonValue } from '../../../shared/runtime/capabilities.js';
import type { KimiFrame, NativeRecord } from '../../../shared/runtime/native/kimiWeb/protocol.js';
export interface PreparedKimiRequest { send(signal?: AbortSignal): Promise<JsonValue> }
/** One raw native response body; `release` drops the driver's slot and settles the request. */
export interface KimiRawResponse {
  readonly body: AsyncIterable<Uint8Array>;
  release(): void;
}
export interface KimiWebTransport {
  request(method: string, path: string, body?: JsonValue, signal?: AbortSignal): Promise<JsonValue>;
  prepare(method: string, path: string, body?: JsonValue): Promise<PreparedKimiRequest>;
  stream(path: string, signal?: AbortSignal): Promise<KimiRawResponse | null>;
  open(onFrame: (frame: KimiFrame, generation: number) => void, onDisconnect: (generation: number) => void): Promise<{ readonly generation: number; readonly hello: NativeRecord }>;
  control(type: string, payload?: NativeRecord, options?: Readonly<{ readonly destructive?: boolean }>): Promise<{ readonly payload: NativeRecord; readonly resync: readonly string[] }>;
  disconnect(): Promise<void>; close(): Promise<void>;
  readonly connected: boolean; readonly generation: number;
  readonly heartbeats: { readonly pings: number; readonly pongs: number };
}
export function createKimiWebTransport(options: { readonly endpoint: string; readonly getAuthorization: () => string | Promise<string>; readonly deadlineMs?: number }): KimiWebTransport;

import type { JsonValue } from '../../../shared/runtime/capabilities.js';
import type { KimiFrame, NativeRecord } from '../../../shared/runtime/native/kimiWeb/protocol.js';
export interface PreparedKimiRequest { send(signal?: AbortSignal): Promise<JsonValue> }
export interface KimiWebTransport {
  request(method: string, path: string, body?: JsonValue, signal?: AbortSignal): Promise<JsonValue>;
  prepare(method: string, path: string, body?: JsonValue): Promise<PreparedKimiRequest>;
  open(onFrame: (frame: KimiFrame, generation: number) => void, onDisconnect: (generation: number) => void): Promise<{ readonly generation: number; readonly hello: NativeRecord }>;
  control(type: string, payload?: NativeRecord): Promise<{ readonly payload: NativeRecord; readonly resync: readonly string[] }>;
  disconnect(): Promise<void>; close(): Promise<void>;
  readonly connected: boolean; readonly generation: number;
  readonly heartbeats: { readonly pings: number; readonly pongs: number };
}
export function createKimiWebTransport(options: { readonly endpoint: string; readonly getAuthorization: () => string | Promise<string>; readonly deadlineMs?: number }): KimiWebTransport;

import type { JsonValue } from '../../../shared/runtime/capabilities.js';
import type { InspectionState } from '../../../shared/runtime/harnessContract.js';
export interface OwnedDshEndpoint { readonly state: InspectionState; readonly origin?: string; readonly nativeVersion?: string; readonly ownership?: 'owned' | 'borrowed'; readonly generation?: number }
export interface DshLease { readonly origin: string; readonly authority: string; readonly generation: number }
export interface DshAuth { getCookie(authority: string): Promise<string>; invalidate(authority: string): unknown }
export interface TransportOptions { readonly getOwnedEndpoint: () => OwnedDshEndpoint | undefined; readonly auth: DshAuth; readonly deadlineMs?: number }
export interface PreparedRpc { readonly lease: DshLease; send(signal?: AbortSignal): Promise<JsonValue> }
export interface DshStream { readonly streamId: string; cancel(): void }
export interface DshMux {
  readonly lease: DshLease; readonly connectionId: string;
  open(endpoint: string, args: JsonValue, callbacks?: { readonly onItem?: (value: JsonValue) => void; readonly onEnd?: (error?: Error) => void }): DshStream;
  close(): void;
}
export interface DshTransport {
  capture(): DshLease;
  assertCurrent(lease: DshLease): void;
  prepare(method: string, args: JsonValue, options?: { readonly signal?: AbortSignal; readonly maxBytes?: number }): Promise<PreparedRpc>;
  call(method: string, args: JsonValue, options?: { readonly signal?: AbortSignal; readonly maxBytes?: number }): Promise<JsonValue>;
  connect(options?: { readonly onDisconnect?: (error: Error) => void }): Promise<DshMux>;
  close(): void;
}
export function createDshTransport(options: TransportOptions): DshTransport;

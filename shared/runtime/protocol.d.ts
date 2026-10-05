import type { EnvironmentId, InstanceId } from './identity.js';
import type { Capabilities, ErrorCode, JsonValue, Method } from './capabilities.js';
export { ProtocolError, ERROR_CODES } from './capabilities.js';
export { createProtocolState } from './protocolState.js';
export const PROTOCOL_VERSION: 1;
/** Stream/store owners enforce these budgets; codecs enforce frame/chunk sizes. */
export const LIMITS: Readonly<{ jsonBytes: 1048576; binaryBytes: 65536; channelCredits: 4; bulkChannels: 4; outboundBytes: 8388608; snapshotTtlMs: 60000; snapshotTokens: 3; replayBytes: 67108864; replayAgeMs: 86400000 }>;
export type Binding = { readonly target: EnvironmentId; readonly epoch: string; readonly generation: number };
type Envelope = Binding & { readonly version: 1 };
export type Hello = Envelope & { readonly kind: 'hello'; readonly instanceId: InstanceId; readonly capabilities: Capabilities };
export type Request = Envelope & { readonly kind: 'request'; readonly id: string; readonly method: Method; readonly params: Readonly<Record<string, JsonValue>>; readonly idempotencyKey?: string };
export type Result = Envelope & { readonly kind: 'result'; readonly id: string } & (
  | { readonly ok: true; readonly phase: 'read' | 'native-executed'; readonly result: JsonValue }
  | { readonly ok: true; readonly phase: 'durable-accepted'; readonly result: { readonly operationId: string } }
  | { readonly ok: false; readonly typedError: { readonly code: ErrorCode; readonly message: string } }
);
/** scope is the canonical entity identity used for revision fencing. */
export type RuntimeEvent = Envelope & { readonly kind: 'event'; readonly seq: number; readonly entityRevision: number; readonly scope: string; readonly type: string; readonly payload: JsonValue };
export type Snapshot = Envelope & { readonly kind: 'snapshot'; readonly token: string; readonly revision: number; readonly watermark: number; readonly expiresAt: number; readonly items: readonly JsonValue[]; readonly cursor: string | null };
export type Replay = Envelope & { readonly kind: 'replay'; readonly after: number; readonly through: number; readonly events: readonly RuntimeEvent[] };
export type Frame = Hello | Request | Result | RuntimeEvent | Snapshot | Replay;
export type Chunk = { readonly channelId: number; readonly offset: number; readonly length: number };
export type BinaryInput = { readonly channelId: number; readonly offset: number; readonly data: Uint8Array };
export type BinaryChunk = Chunk & { readonly data: Uint8Array };
export function parseBinding(input: unknown): Binding;
/** Returns a deeply frozen JSON value; both encode and decode call this validator. */
export function validateFrame(input: unknown): Frame;
export function encodeFrame(input: unknown): string;
export function decodeFrame(text: string): Frame;
export function validateChunk(input: unknown): Chunk;
/** 24-byte big-endian RVB1/channel-u32/offset-u64/length-u32/reserved-zero-u32 header. */
export function encodeBinary(input: BinaryInput): Uint8Array;
export function decodeBinary(bytes: Uint8Array): BinaryChunk;

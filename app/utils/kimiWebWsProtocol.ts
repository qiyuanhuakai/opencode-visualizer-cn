/**
 * Wire vocabulary and transport addressing for the kimi web WebSocket
 * protocol, plus the pure parsing and cursor bookkeeping shared by the client
 * and its close classifier.
 *
 * Shapes are the measured ones from
 * `.omo/evidence/kimi-web-adapt/task-26/REPLAY-BOUNDARY-CONTRACT.md`:
 * control frames carry a client `id` and the server answers `ack`; durable
 * frames carry `{seq, epoch}`; volatile frames add `volatile:true` and deltas
 * add `offset`; the application heartbeat is `{type:'ping', payload:{nonce}}`.
 */

import { appendCodexBridgeToken } from '../backends/codex/bridgeUrl';

/** Appends the bridge token exactly like the WS upgrade authorization expects. */
export function kimiWebWsUrl(bridgeUrl: string, bridgeToken?: string) {
  const trimmed = bridgeUrl.trim();
  if (!trimmed) throw new Error('Kimi Web bridge URL is required.');
  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`Unsupported Kimi Web bridge URL protocol: ${parsed.protocol}`);
  }
  return appendCodexBridgeToken(parsed.toString(), bridgeToken);
}

/** Derives the bridge REST proxy root from the WS bridge URL (`…/kimi-web/ws` → `…/kimi-web`). */
export function kimiWebProxyHttpUrl(wsUrl: string) {
  const parsed = new URL(wsUrl);
  if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
  else if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
  else throw new Error(`Unsupported Kimi Web bridge URL protocol: ${parsed.protocol}`);
  parsed.search = '';
  const segments = parsed.pathname.split('/').filter(Boolean);
  if (segments[segments.length - 1] === 'ws') segments.pop();
  parsed.pathname = `/${segments.join('/')}`;
  return parsed.toString();
}

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

/** Per-session replay cursor; `epoch` is per-session (never shared). */
export type KimiWebWsCursor = { seq: number; epoch: string };

/** Parsed server frame. */
export type KimiWebWsFrame = {
  type: string;
  id?: string;
  code?: number;
  msg?: string;
  seq?: number;
  epoch?: string;
  volatile?: boolean;
  offset?: number;
  session_id?: string;
  timestamp?: string;
  payload?: unknown;
};

export type KimiWebWsAck = {
  id: string;
  code: number;
  msg?: string;
  payload?: Record<string, unknown>;
};

export type KimiWebWsHello = {
  connectionId?: string;
  protocolVersion?: number;
  heartbeatMs?: number;
  maxEventBufferSize?: number;
  capabilities?: Record<string, boolean>;
};

export type KimiWebWsResyncRequest = {
  sessionId: string;
  reason: string;
  currentSeq?: number;
  epoch?: string;
  /** `frame` = standalone `resync_required`; `ack` = `ack.payload.resync_required[]`. */
  source: 'frame' | 'ack';
};

export type KimiWebWsErrorCode =
  | 'not-connected'
  | 'ack-failed'
  | 'ack-timeout'
  | 'connection-failed'
  | 'disposed';

export class KimiWebWsError extends Error {
  readonly code: KimiWebWsErrorCode;
  readonly ack?: KimiWebWsAck;

  constructor(
    code: KimiWebWsErrorCode,
    message: string,
    options: { ack?: KimiWebWsAck; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'KimiWebWsError';
    this.code = code;
    this.ack = options.ack;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

export type KimiWebWsSocketEvent = {
  data?: unknown;
  code?: number;
  reason?: string;
  wasClean?: boolean;
};

/** Minimal structural view of the DOM WebSocket. */
export type KimiWebWsSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(
    type: 'message' | 'error' | 'close',
    listener: (event: KimiWebWsSocketEvent) => void,
  ): void;
};

export type KimiWebWsSocketCtor = new (url: string) => KimiWebWsSocket;

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

/** Parses one text frame; non-JSON payloads and non-frames return null. */
export function parseFrameText(text: string): KimiWebWsFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const frame = asRecord(parsed);
  return frame && typeof frame.type === 'string' ? (frame as KimiWebWsFrame) : null;
}

export function readServerHello(frame: KimiWebWsFrame): KimiWebWsHello {
  const payload = asRecord(frame.payload) ?? {};
  return {
    connectionId: typeof payload.ws_connection_id === 'string' ? payload.ws_connection_id : undefined,
    protocolVersion: typeof payload.protocol_version === 'number' ? payload.protocol_version : undefined,
    heartbeatMs: typeof payload.heartbeat_ms === 'number' ? payload.heartbeat_ms : undefined,
    maxEventBufferSize:
      typeof payload.max_event_buffer_size === 'number' ? payload.max_event_buffer_size : undefined,
    capabilities: asRecord(payload.capabilities) as Record<string, boolean> | undefined,
  };
}

/** Returns the heartbeat nonce to echo, or undefined when the ping is malformed. */
export function readPingNonce(payload: unknown): { nonce: unknown } | undefined {
  const record = asRecord(payload);
  return record && 'nonce' in record ? { nonce: record.nonce } : undefined;
}

export function readAckPayload(frame: KimiWebWsFrame) {
  return asRecord(frame.payload);
}

// --- Cursor bookkeeping ----------------------------------------------------
// A cursor only ever moves forward inside one epoch; a different epoch is a new
// sequence space and replaces the cursor. Volatile frames never advance it.

export type KimiWebWsCursorMap = Map<string, KimiWebWsCursor>;

export function upsertCursor(cursors: KimiWebWsCursorMap, sessionId: string, value: unknown) {
  const record = asRecord(value);
  const seq = record?.seq;
  const epoch = record?.epoch;
  if (typeof seq !== 'number' || typeof epoch !== 'string') return;
  const existing = cursors.get(sessionId);
  if (existing && existing.epoch === epoch && existing.seq > seq) return;
  cursors.set(sessionId, { seq, epoch });
}

/** Durable frames are replayable and define the reconnect cursor. */
export function trackDurableFrame(cursors: KimiWebWsCursorMap, frame: KimiWebWsFrame) {
  if (frame.volatile === true || typeof frame.session_id !== 'string') return;
  upsertCursor(cursors, frame.session_id, { seq: frame.seq, epoch: frame.epoch });
}

export function cursorsFor(cursors: KimiWebWsCursorMap, sessionIds: string[]) {
  const payload: Record<string, KimiWebWsCursor> = {};
  for (const sessionId of sessionIds) {
    const cursor = cursors.get(sessionId);
    if (cursor) payload[sessionId] = { ...cursor };
  }
  return Object.keys(payload).length > 0 ? { cursors: payload } : {};
}

/** `ack.payload.cursors[sid]` is the replay upper bound for that session. */
export function applyAckCursors(cursors: KimiWebWsCursorMap, payload: unknown) {
  const entries = asRecord(asRecord(payload)?.cursors);
  if (!entries) return;
  for (const [sessionId, cursor] of Object.entries(entries)) upsertCursor(cursors, sessionId, cursor);
}

/** `ack.code` stays 0 when replay is impossible; this list is the real signal. */
export function readAckResyncSessions(payload: unknown): string[] {
  const sessions = asRecord(payload)?.resync_required;
  if (!Array.isArray(sessions)) return [];
  return sessions.filter((sessionId): sessionId is string => typeof sessionId === 'string');
}

export function readResyncFrame(frame: KimiWebWsFrame): KimiWebWsResyncRequest | null {
  const payload = asRecord(frame.payload) ?? {};
  const sessionId =
    typeof payload.session_id === 'string' && payload.session_id ? payload.session_id : frame.session_id;
  if (typeof sessionId !== 'string' || !sessionId) return null;
  return {
    sessionId,
    reason: typeof payload.reason === 'string' ? payload.reason : 'unknown',
    currentSeq: typeof payload.current_seq === 'number' ? payload.current_seq : undefined,
    epoch: typeof payload.epoch === 'string' ? payload.epoch : undefined,
    source: 'frame',
  };
}

/**
 * dsh web wire contract — frontend types and guards.
 *
 * Every shape below is anchored to dsh@0.2.0-rc.2 and derived from:
 *   1. Live captures in `.omo/evidence/dsh-adapt/04-session-follow-full.txt`
 *      ($events ready, workspace/follow baseline, mux error frame,
 *      session/follow snapshot with 18 records).
 *   2. The typert host zod schemas shipped inside @deepseek-ai/dsh@0.2.0-rc.2
 *      (`dsh-api-session-controller` / `dsh-api-workspace-controller`
 *      `lib/typert.host.js`, plus `dsh-api-gateway/lib/index.js` frame
 *      validators).
 *   3. docs/dsh.md §5 (RPC envelope), §6 (mux frames), §8 (event contract).
 *
 * This module is intentionally self-contained: it must never import from the
 * dsh package internals. The `dsh@0.2.0-rc.2` stamp in `fixtures/*.meta.json`
 * is the only compatibility anchor — a version bump means re-capturing and
 * re-verifying these shapes, not blindly trusting them.
 *
 * Guards mirror the wire validators (including exact-key checks on mux frames),
 * so a frame dsh would reject is rejected here with a classified
 * `DshWireParseError` instead of being silently accepted.
 */

/** Protocol generation this contract was captured against. */
export const DSH_WIRE_VERSION = '0.2.0-rc.2';

// ---------------------------------------------------------------------------
// Generic JSON value codec (the wire's untyped payload carrier)
// ---------------------------------------------------------------------------

export type DshJsonValue =
  | null
  | string
  | number
  | boolean
  | readonly DshJsonValue[]
  | { readonly [key: string]: DshJsonValue };

export function isDshJsonValue(value: unknown): value is DshJsonValue {
  if (value === null) return true;
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return true;
    case 'object': {
      if (Array.isArray(value)) return value.every(isDshJsonValue);
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) return false;
      return Object.values(value).every(isDshJsonValue);
    }
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

// ---------------------------------------------------------------------------
// Classified parse errors (adversarial inputs must be rejected, not coerced)
// ---------------------------------------------------------------------------

export type DshWireErrorKind =
  | 'not-json'
  | 'not-object'
  | 'unknown-frame-type'
  | 'bad-stream-id'
  | 'missing-field'
  | 'unexpected-field'
  | 'bad-value'
  | 'version-mismatch'
  | 'fixture-unreadable';

export class DshWireParseError extends Error {
  readonly kind: DshWireErrorKind;
  readonly frame: unknown;

  constructor(kind: DshWireErrorKind, message: string, frame?: unknown) {
    super(message);
    this.name = 'DshWireParseError';
    this.kind = kind;
    this.frame = frame;
  }
}

// ---------------------------------------------------------------------------
// HTTP unary RPC envelope (docs/dsh.md §5)
// ---------------------------------------------------------------------------

export type DshRpcArgs = { readonly args: { readonly [key: string]: DshJsonValue } };

export type DshClientRequest = {
  readonly type: 'client-request';
  readonly rpcId: string;
  readonly method: string;
  readonly payload: DshRpcArgs;
};

export type DshRemoteError = {
  readonly code: string;
  readonly message: string;
  readonly details?: DshJsonValue;
};

export type DshServerResponseOk = {
  readonly type: 'server-response';
  readonly rpcId: string;
  readonly result: { readonly ok: true; readonly value: DshJsonValue };
};

export type DshServerResponseError = {
  readonly type: 'server-response';
  readonly rpcId: string;
  readonly result: { readonly ok: false; readonly error: DshRemoteError };
};

export type DshServerResponse = DshServerResponseOk | DshServerResponseError;

function isDshRpcArgs(value: unknown): value is DshRpcArgs {
  return isRecord(value) && isRecord(value.args) && Object.values(value.args).every(isDshJsonValue);
}

export function isDshClientRequest(value: unknown): value is DshClientRequest {
  if (!isRecord(value)) return false;
  return (
    value.type === 'client-request' &&
    isNonEmptyString(value.rpcId) &&
    isNonEmptyString(value.method) &&
    isDshRpcArgs(value.payload)
  );
}

export function isDshRemoteError(value: unknown): value is DshRemoteError {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.code) || typeof value.message !== 'string') return false;
  return value.details === undefined || isDshJsonValue(value.details);
}

export function isDshServerResponse(value: unknown): value is DshServerResponse {
  if (!isRecord(value)) return false;
  if (value.type !== 'server-response' || !isNonEmptyString(value.rpcId)) return false;
  const result = value.result;
  if (!isRecord(result)) return false;
  if (result.ok === true) return isDshJsonValue(result.value);
  if (result.ok === false) return isDshRemoteError(result.error);
  return false;
}

// ---------------------------------------------------------------------------
// WS mux frames (docs/dsh.md §6, dsh-api-gateway/lib/index.js validators)
// ---------------------------------------------------------------------------

export type DshMuxOpenFrame = {
  readonly type: 'open';
  readonly streamId: string;
  readonly endpoint: string;
  readonly payload: DshRpcArgs;
};

export type DshMuxItemFrame = {
  readonly type: 'item';
  readonly streamId: string;
  readonly value?: DshJsonValue;
};

export type DshMuxEndFrame = { readonly type: 'end'; readonly streamId: string };

export type DshMuxCancelFrame = { readonly type: 'cancel'; readonly streamId: string };

export type DshMuxErrorFrame = {
  readonly type: 'error';
  readonly streamId: string;
  readonly error: DshRemoteError;
};

/** Client → Host frames. */
export type DshMuxClientFrame = DshMuxOpenFrame | DshMuxItemFrame | DshMuxEndFrame | DshMuxCancelFrame;

/** Host → client frames (what fixtures capture). */
export type DshMuxServerFrame = DshMuxItemFrame | DshMuxEndFrame | DshMuxErrorFrame;

export type DshMuxFrame = DshMuxClientFrame | DshMuxServerFrame;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function exactKeysViolation(value: Record<string, unknown>, expected: readonly string[]): DshWireErrorKind | null {
  if (exactKeys(value, expected)) return null;
  return expected.some((key) => !Object.hasOwn(value, key)) ? 'missing-field' : 'unexpected-field';
}

function parseMuxStreamId(value: Record<string, unknown>, line: string): string {
  if (!isNonEmptyString(value.streamId)) {
    throw new DshWireParseError('bad-stream-id', `dsh mux frame: streamId must be a non-empty string (${line})`, value);
  }
  return value.streamId;
}

/**
 * Parse one JSONL line (one mux frame) with classified errors.
 * Mirrors `parseRemoteStreamClientMessage` + host-side frame construction:
 * exact key sets per frame type, non-empty stream ids, JSON-valued payloads.
 */
export function parseDshWireLine(line: string): DshMuxFrame {
  let decoded: unknown;
  try {
    decoded = JSON.parse(line);
  } catch {
    throw new DshWireParseError('not-json', `dsh mux frame: not JSON (${line.slice(0, 120)})`, line);
  }
  return parseDshMuxFrameValue(decoded, line);
}

/** Parse an already-decoded value as a mux frame. */
export function parseDshMuxFrameValue(value: unknown, line = '<value>'): DshMuxFrame {
  if (!isRecord(value)) {
    throw new DshWireParseError('not-object', `dsh mux frame: not an object (${line})`, value);
  }
  switch (value.type) {
    case 'open': {
      const streamId = parseMuxStreamId(value, line);
      const violation = exactKeysViolation(value, ['type', 'streamId', 'endpoint', 'payload']);
      if (violation) {
        throw new DshWireParseError(violation, 'dsh mux open frame: requires exactly type/streamId/endpoint/payload', value);
      }
      if (!isNonEmptyString(value.endpoint)) {
        throw new DshWireParseError('bad-value', 'dsh mux open frame: endpoint must be a non-empty string', value);
      }
      if (!isDshRpcArgs(value.payload)) {
        throw new DshWireParseError('bad-value', 'dsh mux open frame: payload must be { args: {...} }', value);
      }
      return { type: 'open', streamId, endpoint: value.endpoint, payload: value.payload };
    }
    case 'item': {
      const streamId = parseMuxStreamId(value, line);
      const violation = Object.hasOwn(value, 'value')
        ? exactKeysViolation(value, ['type', 'streamId', 'value'])
        : exactKeysViolation(value, ['type', 'streamId']);
      if (violation) {
        throw new DshWireParseError(violation, 'dsh mux item frame: requires type/streamId(/value)', value);
      }
      if (Object.hasOwn(value, 'value') && !isDshJsonValue(value.value)) {
        throw new DshWireParseError('bad-value', 'dsh mux item frame: value must be a JSON value', value);
      }
      return Object.hasOwn(value, 'value')
        ? { type: 'item', streamId, value: value.value as DshJsonValue }
        : { type: 'item', streamId };
    }
    case 'end':
    case 'cancel': {
      const streamId = parseMuxStreamId(value, line);
      const violation = exactKeysViolation(value, ['type', 'streamId']);
      if (violation) {
        throw new DshWireParseError(violation, `dsh mux ${value.type} frame: requires exactly type/streamId`, value);
      }
      return { type: value.type, streamId };
    }
    case 'error': {
      const streamId = parseMuxStreamId(value, line);
      const violation = exactKeysViolation(value, ['type', 'streamId', 'error']);
      if (violation) {
        throw new DshWireParseError(violation, 'dsh mux error frame: requires exactly type/streamId/error', value);
      }
      if (!isDshRemoteError(value.error)) {
        throw new DshWireParseError('bad-value', 'dsh mux error frame: error must be { code, message, details? }', value);
      }
      return { type: 'error', streamId, error: value.error };
    }
    default:
      throw new DshWireParseError('unknown-frame-type', `dsh mux frame: unknown type ${JSON.stringify(value.type)}`, value);
  }
}

export function isDshMuxServerFrame(value: unknown): value is DshMuxServerFrame {
  if (!isRecord(value)) return false;
  if (value.type === 'item') {
    if (!isNonEmptyString(value.streamId)) return false;
    return value.value === undefined || isDshJsonValue(value.value);
  }
  if (value.type === 'end') return isNonEmptyString(value.streamId);
  if (value.type === 'error') return isNonEmptyString(value.streamId) && isDshRemoteError(value.error);
  return false;
}

// ---------------------------------------------------------------------------
// $events logical stream (docs/dsh.md §8.1; ready frame captured live)
// ---------------------------------------------------------------------------

export type DshEventsReadyFrame = {
  readonly type: 'ready';
  readonly clientId: string;
  readonly host: { readonly home: string };
};

export type DshEventsEmitFrame = {
  readonly type: 'emit';
  readonly event: string;
  readonly args: readonly DshJsonValue[];
};

export type DshEventsWaterfallFrame = {
  readonly type: 'waterfall';
  readonly event: string;
  readonly eventId: string;
  readonly agentId: string;
  readonly request: DshJsonValue;
};

export type DshEventsCancelFrame = { readonly type: 'cancel'; readonly eventId: string };

export type DshEventsFrame =
  | DshEventsReadyFrame
  | DshEventsEmitFrame
  | DshEventsWaterfallFrame
  | DshEventsCancelFrame;

export function isDshEventsFrame(value: unknown): value is DshEventsFrame {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case 'ready':
      return (
        isNonEmptyString(value.clientId) &&
        isRecord(value.host) &&
        typeof value.host.home === 'string'
      );
    case 'emit':
      return isNonEmptyString(value.event) && Array.isArray(value.args) && value.args.every(isDshJsonValue);
    case 'waterfall':
      return (
        isNonEmptyString(value.event) &&
        isNonEmptyString(value.eventId) &&
        isNonEmptyString(value.agentId) &&
        isDshJsonValue(value.request)
      );
    case 'cancel':
      return isNonEmptyString(value.eventId);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Session event vocabulary (typert SessionEventMap + capture-attested extras)
// ---------------------------------------------------------------------------

/**
 * Union of session event types: the full `SessionEventMap` key set from
 * dsh-api-session-controller's typert host schema, plus `session/title-llm-request`
 * which rides the wire log in the live capture (04-session-follow-full.txt seq 14)
 * but is absent from that declaration.
 */
export const DSH_SESSION_EVENT_TYPES = [
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'developer/message',
  'system/message',
  'assistant/message',
  'assistant/attempt',
  'tool/call',
  'tool/result',
  'request/header',
  'request/context',
  'session/end-seed',
  'agent/inbox/spliced',
  'sandbox/mode',
  'approval/asked',
  'approval/decided',
  'approval/policy',
  'tool/ptc-dispatch-start',
  'tool/ptc-dispatch',
  'agent-preset/selected',
  'command/run',
  'command/done',
  'image/offload',
  'session/title',
  'session/title-llm-request',
  'todo/write',
  'model/selection',
  'subagent/descriptor',
  'permission/preset',
  'subagent/catalog',
  'compaction/start',
  'compaction/summary',
  'compaction/end',
  'compaction/prune',
  'feedback/record',
  'feedback/message-put',
  'feedback/message-delete',
  'goal/change',
  'schedule/change',
] as const;

export type DshSessionEventType = (typeof DSH_SESSION_EVENT_TYPES)[number];

export function isDshSessionEventType(value: unknown): value is DshSessionEventType {
  return typeof value === 'string' && (DSH_SESSION_EVENT_TYPES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Record envelope + session/follow frames (docs/dsh.md §8.2, typert follow result)
// ---------------------------------------------------------------------------

export type DshSessionWireEvent = {
  readonly type: DshSessionEventType;
  readonly seq: number;
  readonly time: number;
  readonly data: DshJsonValue;
  readonly ignorable?: true;
  readonly sourceEventSeqs?: DshJsonValue;
  readonly surfaceOp?: DshJsonValue;
};

export type DshSessionRecord = { readonly type: 'event'; readonly event: DshSessionWireEvent };

export function isDshSessionWireEvent(value: unknown): value is DshSessionWireEvent {
  if (!isRecord(value)) return false;
  if (!isDshSessionEventType(value.type)) return false;
  if (typeof value.seq !== 'number' || typeof value.time !== 'number') return false;
  if (!isDshJsonValue(value.data)) return false;
  if (value.ignorable !== undefined && value.ignorable !== true) return false;
  if (value.sourceEventSeqs !== undefined && !isDshJsonValue(value.sourceEventSeqs)) return false;
  if (value.surfaceOp !== undefined && !isDshJsonValue(value.surfaceOp)) return false;
  return true;
}

export function isDshSessionRecord(value: unknown): value is DshSessionRecord {
  return isRecord(value) && value.type === 'event' && isDshSessionWireEvent(value.event);
}

export type DshSessionWireHeader = {
  readonly version: number;
  readonly id: string;
  readonly createdAt: number;
  readonly cwd?: string;
  readonly parentSession?: string;
  readonly isSeeded: boolean;
  readonly origin?: 'subagent';
  readonly delegationDepth?: number;
  readonly agentPreset?: string;
};

export type DshSessionAssistantStreamBaseline = {
  readonly revision: number;
  readonly activeAttempt?: DshJsonValue;
};

export type DshSessionSnapshot = {
  readonly type: 'snapshot';
  readonly header: DshSessionWireHeader;
  readonly cursor: number;
  readonly records: readonly DshSessionRecord[];
  readonly hasMore: boolean;
  readonly projections: DshProjectionBaseline;
  readonly assistantStream?: DshSessionAssistantStreamBaseline;
};

export type DshSessionAssistantStreamFrame =
  | {
      readonly type: 'start';
      readonly attemptId: string;
      readonly revision: number;
      readonly startedAfterSeq: number;
      readonly turn: number;
      readonly step: number;
    }
  | {
      readonly type: 'chunk';
      readonly attemptId: string;
      readonly revision: number;
      readonly index: number;
      readonly time: number;
      readonly chunk: DshJsonValue;
    }
  | {
      readonly type: 'end';
      readonly attemptId: string;
      readonly revision: number;
      readonly index: number;
      readonly outcome:
        | { readonly kind: 'committed'; readonly eventType: 'assistant/message' | 'assistant/attempt'; readonly seq: number }
        | { readonly kind: 'abandoned' };
    };

export type DshSessionAssistantStreamEntry = {
  readonly type: 'assistant-stream';
  readonly frame: DshSessionAssistantStreamFrame;
};

/** `session/follow` stream value union (snapshot | event entry | assistant-stream). */
export type DshSessionFollowFrame = DshSessionSnapshot | DshSessionRecord | DshSessionAssistantStreamEntry;

function isDshSessionWireHeader(value: unknown): value is DshSessionWireHeader {
  if (!isRecord(value)) return false;
  if (typeof value.version !== 'number' || !isNonEmptyString(value.id)) return false;
  if (typeof value.createdAt !== 'number' || typeof value.isSeeded !== 'boolean') return false;
  if (value.cwd !== undefined && typeof value.cwd !== 'string') return false;
  if (value.parentSession !== undefined && typeof value.parentSession !== 'string') return false;
  if (value.origin !== undefined && value.origin !== 'subagent') return false;
  if (value.delegationDepth !== undefined && typeof value.delegationDepth !== 'number') return false;
  if (value.agentPreset !== undefined && typeof value.agentPreset !== 'string') return false;
  return true;
}

function isDshSessionAssistantStreamBaseline(value: unknown): value is DshSessionAssistantStreamBaseline {
  if (!isRecord(value)) return false;
  if (typeof value.revision !== 'number') return false;
  return value.activeAttempt === undefined || isDshJsonValue(value.activeAttempt);
}

function isDshSessionAssistantStreamFrame(value: unknown): value is DshSessionAssistantStreamFrame {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.attemptId) || typeof value.revision !== 'number') return false;
  switch (value.type) {
    case 'start':
      return (
        typeof value.startedAfterSeq === 'number' &&
        typeof value.turn === 'number' &&
        typeof value.step === 'number'
      );
    case 'chunk':
      return typeof value.index === 'number' && typeof value.time === 'number' && isDshJsonValue(value.chunk);
    case 'end': {
      if (typeof value.index !== 'number' || !isRecord(value.outcome)) return false;
      if (value.outcome.kind === 'abandoned') return true;
      if (value.outcome.kind === 'committed') {
        return (
          (value.outcome.eventType === 'assistant/message' || value.outcome.eventType === 'assistant/attempt') &&
          typeof value.outcome.seq === 'number'
        );
      }
      return false;
    }
    default:
      return false;
  }
}

export function isDshSessionSnapshot(value: unknown): value is DshSessionSnapshot {
  if (!isRecord(value) || value.type !== 'snapshot') return false;
  if (!isDshSessionWireHeader(value.header)) return false;
  if (typeof value.cursor !== 'number' || typeof value.hasMore !== 'boolean') return false;
  if (!Array.isArray(value.records) || !value.records.every(isDshSessionRecord)) return false;
  if (!isDshProjectionBaseline(value.projections)) return false;
  return value.assistantStream === undefined || isDshSessionAssistantStreamBaseline(value.assistantStream);
}

export function isDshSessionFollowFrame(value: unknown): value is DshSessionFollowFrame {
  if (!isRecord(value)) return false;
  if (value.type === 'snapshot') return isDshSessionSnapshot(value);
  if (value.type === 'event') return isDshSessionWireEvent(value.event);
  if (value.type === 'assistant-stream') return isDshSessionAssistantStreamFrame(value.frame);
  return false;
}

// ---------------------------------------------------------------------------
// workspace/follow frames (typert workspace follow result; baseline captured live)
// ---------------------------------------------------------------------------

export type DshWorkspaceItem = {
  readonly workspaceId: string;
  readonly path: string;
  readonly title: string;
  readonly sessionIds: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type DshWorkspaceBaseline = {
  readonly items: readonly DshWorkspaceItem[];
  readonly archivedSessionIds: readonly string[];
  readonly pinnedSessionIds: readonly string[];
};

export type DshWorkspaceBaselineFrame = { readonly type: 'baseline'; readonly value: DshWorkspaceBaseline };

export type DshWorkspaceUpsertFrame = { readonly type: 'upsert'; readonly workspace: DshWorkspaceItem };

export type DshWorkspaceRemoveFrame = { readonly type: 'remove'; readonly workspaceId: string };

export type DshWorkspaceOrderFrame = { readonly type: 'order'; readonly workspaceIds: readonly string[] };

export type DshWorkspaceArchivedFrame = { readonly type: 'archived'; readonly archivedSessionIds: readonly string[] };

export type DshWorkspacePinnedFrame = { readonly type: 'pinned'; readonly pinnedSessionIds: readonly string[] };

export type DshWorkspaceFollowFrame =
  | DshWorkspaceBaselineFrame
  | DshWorkspaceUpsertFrame
  | DshWorkspaceRemoveFrame
  | DshWorkspaceOrderFrame
  | DshWorkspaceArchivedFrame
  | DshWorkspacePinnedFrame;

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isDshWorkspaceItem(value: unknown): value is DshWorkspaceItem {
  if (!isRecord(value)) return false;
  return (
    isNonEmptyString(value.workspaceId) &&
    typeof value.path === 'string' &&
    typeof value.title === 'string' &&
    isStringArray(value.sessionIds) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  );
}

export function isDshWorkspaceFollowFrame(value: unknown): value is DshWorkspaceFollowFrame {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case 'baseline': {
      const baseline = value.value;
      if (!isRecord(baseline)) return false;
      return (
        Array.isArray(baseline.items) &&
        baseline.items.every(isDshWorkspaceItem) &&
        isStringArray(baseline.archivedSessionIds) &&
        isStringArray(baseline.pinnedSessionIds)
      );
    }
    case 'upsert':
      return isDshWorkspaceItem(value.workspace);
    case 'remove':
      return isNonEmptyString(value.workspaceId);
    case 'order':
      return isStringArray(value.workspaceIds);
    case 'archived':
      return isStringArray(value.archivedSessionIds);
    case 'pinned':
      return isStringArray(value.pinnedSessionIds);
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Session addresses + session/page (typert session controller page schema)
// ---------------------------------------------------------------------------

export type DshSessionAddress =
  | { readonly kind: 'session'; readonly sessionId: string }
  | {
      readonly kind: 'subagent';
      readonly parentSessionId: string;
      readonly childSessionId: string;
      readonly mode: 'one-shot' | 'continuable' | 'unknown';
    };

export function isDshSessionAddress(value: unknown): value is DshSessionAddress {
  if (!isRecord(value)) return false;
  if (value.kind === 'session') return isNonEmptyString(value.sessionId);
  if (value.kind === 'subagent') {
    return (
      isNonEmptyString(value.parentSessionId) &&
      isNonEmptyString(value.childSessionId) &&
      (value.mode === 'one-shot' || value.mode === 'continuable' || value.mode === 'unknown')
    );
  }
  return false;
}

export type DshTurnWindow = { readonly minMessages: number; readonly minTurns: number };

export type DshSessionPageRequest = {
  readonly address: DshSessionAddress;
  readonly throughSeq: number;
  readonly beforeSeq?: number;
  readonly maxMessages?: number;
  readonly turnWindow?: DshTurnWindow;
};

export function isDshSessionPageRequest(value: unknown): value is DshSessionPageRequest {
  if (!isRecord(value)) return false;
  if (!isDshSessionAddress(value.address)) return false;
  if (typeof value.throughSeq !== 'number') return false;
  if (value.beforeSeq !== undefined && typeof value.beforeSeq !== 'number') return false;
  if (value.maxMessages !== undefined && typeof value.maxMessages !== 'number') return false;
  if (value.turnWindow !== undefined) {
    const window = value.turnWindow;
    if (!isRecord(window) || typeof window.minMessages !== 'number' || typeof window.minTurns !== 'number') {
      return false;
    }
  }
  return true;
}

export type DshSessionPageResult = {
  readonly records: readonly DshSessionRecord[];
  readonly hasMore: boolean;
};

export function isDshSessionPageResult(value: unknown): value is DshSessionPageResult {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value.records) &&
    value.records.every(isDshSessionRecord) &&
    typeof value.hasMore === 'boolean'
  );
}

// ---------------------------------------------------------------------------
// session/follow open request (typert follow parameter; probe sent exactly this)
// ---------------------------------------------------------------------------

export type DshSessionFollowRequest = {
  readonly address: DshSessionAddress;
  readonly assistantStream?: true;
  readonly maxMessages?: number;
  readonly turnWindow?: DshTurnWindow;
};

// ---------------------------------------------------------------------------
// session/prompt (typert prompt parameter; request sent live in docs §9)
// ---------------------------------------------------------------------------

export type DshPromptTextPart = { readonly type: 'text'; readonly text: string };

export type DshPromptImagePart = {
  readonly type: 'image';
  readonly mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  readonly data: string;
  readonly name?: string;
};

export type DshPromptFilePart = { readonly type: 'file'; readonly receiptId: string };

export type DshPromptContentPart = DshPromptTextPart | DshPromptImagePart | DshPromptFilePart;

export type DshSessionPromptRequest = {
  readonly requestId: string;
  readonly sessionId: string;
  readonly mode: 'queue' | 'steer';
  readonly content: readonly DshPromptContentPart[];
  readonly clientTimeZone?: string;
};

export type DshSessionPromptResult = { readonly accepted: true };

function isDshPromptContentPart(value: unknown): value is DshPromptContentPart {
  if (!isRecord(value)) return false;
  switch (value.type) {
    case 'text':
      return typeof value.text === 'string';
    case 'image':
      return (
        (value.mediaType === 'image/png' ||
          value.mediaType === 'image/jpeg' ||
          value.mediaType === 'image/webp' ||
          value.mediaType === 'image/gif') &&
        typeof value.data === 'string' &&
        (value.name === undefined || typeof value.name === 'string')
      );
    case 'file':
      return isNonEmptyString(value.receiptId);
    default:
      return false;
  }
}

export function isDshSessionPromptRequest(value: unknown): value is DshSessionPromptRequest {
  if (!isRecord(value)) return false;
  if (!isNonEmptyString(value.requestId) || !isNonEmptyString(value.sessionId)) return false;
  if (value.mode !== 'queue' && value.mode !== 'steer') return false;
  if (!Array.isArray(value.content) || !value.content.every(isDshPromptContentPart)) return false;
  return value.clientTimeZone === undefined || typeof value.clientTimeZone === 'string';
}

// ---------------------------------------------------------------------------
// Projections (typert projection baseline/values; values captured live in the
// session/follow snapshot — tokenUsage/contextPressure/contextBreakdown/
// sessionStats/turnOutline/plan ride the typert record extension)
// ---------------------------------------------------------------------------

export type DshProjectionInbox = {
  readonly 'next-turn': readonly DshJsonValue[];
  readonly 'next-step': readonly DshJsonValue[];
};

export type DshProjectionTodoItem = { readonly content: string; readonly status: 'completed' | 'pending' | 'in_progress' };

export type DshProjectionModelRef = {
  readonly provider: string;
  readonly model: string;
  readonly reasoningEffort?: string;
};

export type DshProjectionModelSelection = {
  readonly lastUsed: DshProjectionModelRef | null;
  readonly next: DshProjectionModelRef | null;
};

export type DshProjectionTokenUsage = {
  readonly uncachedInputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
};

export type DshProjectionContextBreakdown = {
  readonly systemTokens: number;
  readonly toolsTokens: number;
  readonly messageTokens: number;
};

export type DshProjectionSessionStats = {
  readonly turns: number;
  readonly steps: number;
  readonly llmMs: number;
  readonly toolMs: number;
  readonly ttftMs: number;
  readonly ttftSteps: number;
  readonly decodeMs: number;
  readonly decodeTokens: number;
};

export type DshProjectionTurnOutlineEntry = {
  readonly turn: number;
  readonly seq: number;
  readonly prompt: string;
  readonly response: string;
};

export type DshProjectionImageLimits = {
  readonly maxImageBytes: number;
  readonly maxImagesPerMessage: number;
  readonly maxMessageImageBytes: number;
  readonly maxImagePixels: number;
  readonly maxImageDimension: number;
  readonly mediaTypes: readonly ('image/png' | 'image/jpeg' | 'image/webp' | 'image/gif')[];
};

export type DshProjectionKnownValues = {
  readonly inbox?: DshProjectionInbox;
  readonly agentPreset?: string | null;
  readonly title?: string | null;
  readonly todos?: readonly DshProjectionTodoItem[] | null;
  readonly sessionListMetadata?: { readonly blank: boolean; readonly lastPromptAt: number | null };
  readonly imageLimits?: DshProjectionImageLimits;
  readonly modelSelection?: DshProjectionModelSelection;
  readonly permissions?: { readonly currentValue: string };
  readonly subagentCatalog?: readonly DshJsonValue[];
  readonly subagentTiming?: DshJsonValue;
  readonly subagent?: DshJsonValue | null;
  readonly goal?: DshJsonValue | null;
  readonly userQuestions?: DshJsonValue;
  readonly tokenUsage?: DshProjectionTokenUsage;
  readonly contextPressure?: DshJsonValue;
  readonly contextBreakdown?: DshProjectionContextBreakdown;
  readonly sessionStats?: DshProjectionSessionStats;
  readonly turnOutline?: readonly DshProjectionTurnOutlineEntry[];
  readonly plan?: DshJsonValue;
};

/** Known projection keys plus the typert record extension (unknown keys stay valid JSON values). */
export type DshProjectionValues = DshProjectionKnownValues & { readonly [key: string]: DshJsonValue };

export type DshProjectionBaseline = {
  readonly asOfSeq: number;
  readonly values: DshProjectionValues;
};

function isNumberRecord(value: unknown, keys: readonly string[]): boolean {
  return isRecord(value) && keys.every((key) => typeof value[key] === 'number');
}

function isDshProjectionModelRef(value: unknown): value is DshProjectionModelRef {
  if (!isRecord(value)) return false;
  return (
    typeof value.provider === 'string' &&
    typeof value.model === 'string' &&
    (value.reasoningEffort === undefined || typeof value.reasoningEffort === 'string')
  );
}

function validateProjectionKnownKey(key: string, value: unknown): boolean {
  switch (key) {
    case 'inbox':
      return (
        isRecord(value) &&
        Array.isArray(value['next-turn']) &&
        value['next-turn'].every(isDshJsonValue) &&
        Array.isArray(value['next-step']) &&
        value['next-step'].every(isDshJsonValue)
      );
    case 'agentPreset':
    case 'title':
      return value === null || typeof value === 'string';
    case 'todos':
      return (
        value === null ||
        (Array.isArray(value) &&
          value.every(
            (entry) =>
              isRecord(entry) &&
              typeof entry.content === 'string' &&
              (entry.status === 'completed' || entry.status === 'pending' || entry.status === 'in_progress'),
          ))
      );
    case 'sessionListMetadata':
      return (
        isRecord(value) && typeof value.blank === 'boolean' && (value.lastPromptAt === null || typeof value.lastPromptAt === 'number')
      );
    case 'imageLimits':
      return (
        isNumberRecord(value, [
          'maxImageBytes',
          'maxImagesPerMessage',
          'maxMessageImageBytes',
          'maxImagePixels',
          'maxImageDimension',
        ]) &&
        Array.isArray((value as Record<string, unknown>).mediaTypes) &&
        (value as { mediaTypes: unknown[] }).mediaTypes.every((entry) =>
          ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(entry as string),
        )
      );
    case 'modelSelection':
      return (
        isRecord(value) &&
        (value.lastUsed === null || isDshProjectionModelRef(value.lastUsed)) &&
        (value.next === null || isDshProjectionModelRef(value.next))
      );
    case 'permissions':
      return isRecord(value) && typeof value.currentValue === 'string';
    case 'tokenUsage':
      return isNumberRecord(value, ['uncachedInputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']);
    case 'contextBreakdown':
      return isNumberRecord(value, ['systemTokens', 'toolsTokens', 'messageTokens']);
    case 'sessionStats':
      return isNumberRecord(value, [
        'turns',
        'steps',
        'llmMs',
        'toolMs',
        'ttftMs',
        'ttftSteps',
        'decodeMs',
        'decodeTokens',
      ]);
    case 'turnOutline':
      return (
        Array.isArray(value) &&
        value.every(
          (entry) =>
            isRecord(entry) &&
            typeof entry.turn === 'number' &&
            typeof entry.seq === 'number' &&
            typeof entry.prompt === 'string' &&
            typeof entry.response === 'string',
        )
      );
    default:
      // subagentCatalog / subagentTiming / subagent / goal / userQuestions /
      // contextPressure / plan and any future key ride the typert record
      // extension: any JSON value is acceptable.
      return isDshJsonValue(value);
  }
}

export function isDshProjectionBaseline(value: unknown): value is DshProjectionBaseline {
  if (!isRecord(value)) return false;
  if (typeof value.asOfSeq !== 'number' || !isRecord(value.values)) return false;
  return Object.entries(value.values).every(([key, entry]) => validateProjectionKnownKey(key, entry));
}

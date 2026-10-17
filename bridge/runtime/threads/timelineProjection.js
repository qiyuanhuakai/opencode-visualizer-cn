import { ProtocolError } from '../../../shared/runtime/capabilities.js';

/**
 * Turn timeline projection rules (task 32).
 *
 * Pure, storage-free projection primitives shared by the Turn service: the fixed tables, the
 * explicit-code rejections, the per-source dedup keys, the frozen read models and — the load
 * bearing part — the two sinks that keep the four turn states independent.
 *
 * `createNativeSink` receives a scope that contains NO Host state. Its type has no member that
 * can reach `accepted` or `sent`, so a native terminal event structurally cannot transition a
 * turn into the Host-accepted state: the guarantee is enforced by what the sink can see, not by
 * a comment or a later check.
 */

export const TURN_STATE_FLAGS = Object.freeze(['accepted', 'sent', 'observed', 'terminal']);
export const TIMELINE_ENTRY_KINDS = Object.freeze(['message', 'tool', 'thinking', 'interaction', 'usage']);
export const TIMELINE_TERMINAL_REASONS = Object.freeze(['completed', 'failed', 'cancelled', 'timeout', 'aborted']);
export const TURN_COMMAND_PHASES = Object.freeze(['accepted', 'sent', 'cancelled']);
/** Serialized payload ceiling per entry; an oversized message is rejected, never silently truncated. */
export const MAX_TIMELINE_ENTRY_CHARS = 262_144;
/** gaps() walks one source's [min,max] span synchronously, so an unbounded span is refused, never walked. */
export const MAX_TIMELINE_SEQ_SPAN = 1_048_576;
export const DEFAULT_TIMELINE_PAGE_LIMIT = 100;
export const MAX_TIMELINE_PAGE_LIMIT = 500;

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const MAX_TEXT_CHARS = 512;

/** Every rejection carries an explicit protocol code plus the plain rejection field. */
export class TurnError extends ProtocolError {
  constructor(code, reason) {
    super(code, `runtime.turn.${reason}`);
    this.name = 'TurnError';
    this.reason = reason;
    this.field = reason;
  }
}

function requireText(value, reason, max = MAX_TEXT_CHARS) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new TurnError('invalid_request', reason);
  }
  return value;
}

export function parseTurnId(value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new TurnError('invalid_request', 'timeline_turn_id');
  return value.toLowerCase();
}

export function parseAttempt(value) {
  if (value === undefined) return 1;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TurnError('invalid_request', 'turn_attempt');
  }
  return value;
}

export function parseOptionalTurnRef(value) {
  if (value === undefined || value === null) return null;
  try {
    return parseTurnId(value);
  } catch {
    throw new TurnError('invalid_request', 'turn_parent_turn');
  }
}

export function parseOptionalText(value, reason, max) {
  if (value === undefined || value === null) return null;
  return requireText(value, reason, max);
}

export function parseAt(value) {
  if (value === undefined) return Date.now();
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TurnError('invalid_request', 'timeline_time');
  return value;
}

export function parseSeq(value) {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TurnError('invalid_request', 'timeline_seq');
  }
  return value;
}

export function parseTimelineSource(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TurnError('invalid_request', 'timeline_source');
  }
  if (value.kind === 'host') {
    return Object.freeze({ kind: 'host', commandId: requireText(value.commandId, 'timeline_source') });
  }
  if (value.kind === 'native') {
    return Object.freeze({
      kind: 'native',
      harness: requireText(value.harness, 'timeline_source'),
      nativeEventId: requireText(value.nativeEventId, 'timeline_source'),
    });
  }
  throw new TurnError('invalid_request', 'timeline_source');
}

function parseEntryKind(value) {
  if (!TIMELINE_ENTRY_KINDS.includes(value)) throw new TurnError('invalid_request', 'timeline_entry_kind');
  return value;
}

export function parseTerminalReason(value) {
  if (!TIMELINE_TERMINAL_REASONS.includes(value)) throw new TurnError('invalid_request', 'turn_terminal_reason');
  return value;
}

/** Producer identity of a source — the grouping key history uses so sources are never concatenated. */
export function timelineSourceKey(source) {
  return source.kind === 'host' ? `host|${source.commandId}` : `native|${source.harness}`;
}

/**
 * Per-source dedup key: the same native event id from two different sources is two DIFFERENT
 * keys, so the two sources deduplicate independently instead of globally.
 */
export function timelineDedupKey(source, nativeEventId) {
  return `${timelineSourceKey(source)}\u0000${nativeEventId}`;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

export function frozenPayload(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TurnError('invalid_request', 'timeline_payload');
  }
  let clone;
  try {
    clone = structuredClone(value);
  } catch {
    throw new TurnError('invalid_request', 'timeline_payload');
  }
  let serialized;
  try {
    serialized = JSON.stringify(clone) ?? '';
  } catch {
    throw new TurnError('invalid_request', 'timeline_payload');
  }
  if (serialized.length > MAX_TIMELINE_ENTRY_CHARS) {
    throw new TurnError('invalid_request', 'timeline_payload_too_large');
  }
  return deepFreeze(clone);
}

export function entryView(entry) {
  return Object.freeze({
    entryId: entry.entryId,
    order: entry.order,
    seq: entry.seq,
    turnId: entry.turnId,
    kind: entry.kind,
    source: entry.source,
    at: entry.at,
    payload: entry.payload,
    late: entry.late,
    dedupKey: entry.dedupKey,
  });
}

/** Frozen flattened read model of one turn: the four states are independent booleans. */
export function turnView(turn) {
  return Object.freeze({
    turnId: turn.turnId,
    causedBy: turn.causedBy,
    parentTurn: turn.parentTurn,
    attempt: turn.attempt,
    sourceNativeId: turn.sourceNativeId,
    createdAt: turn.createdAt,
    accepted: turn.host.accepted,
    acceptedAt: turn.host.acceptedAt,
    acceptedBy: turn.host.acceptedBy,
    sent: turn.host.sent,
    sentAt: turn.host.sentAt,
    sentBy: turn.host.sentBy,
    observed: turn.native.observed,
    observedAt: turn.native.observedAt,
    observedBy: turn.native.observedBy,
    terminal: turn.native.terminal,
    terminalAt: turn.native.terminalAt,
    terminalReason: turn.native.terminalReason,
    terminalBy: turn.native.terminalBy,
    entryCount: turn.entries.length,
    lastOrder: turn.lastOrder,
    seqMax: turn.seqMax,
  });
}

/**
 * The entry machinery both sides share. Recording an entry never changes any of the four
 * states — it only appends to the ordered projection.
 *
 * Every native source keeps its OWN seq set: `seq` is a per-source counter, so one source's
 * missing epoch is never hidden by another source's event that happens to carry the same number.
 */
function recordEntry(scope, input) {
  const source = parseTimelineSource(input.source);
  const kind = parseEntryKind(input.kind);
  const at = parseAt(input.at);
  const seq = parseSeq(input.seq);
  const dedupKey = timelineDedupKey(source, source.kind === 'host' ? source.commandId : source.nativeEventId);
  const existingId = scope.seen.get(dedupKey);
  if (existingId !== undefined) {
    scope.markDuplicate();
    const existing = scope.entries.find((entry) => entry.entryId === existingId);
    if (existing === undefined) throw new TurnError('conflict', 'timeline_entry_missing');
    return { entry: entryView(existing), duplicate: true };
  }
  const payload = frozenPayload(input.payload);
  const late = scope.native.terminal;
  const sourceKey = timelineSourceKey(source);
  const resolvedSeq = seq > 0 ? seq : scope.nextSeq(sourceKey);
  const order = scope.nextOrder();
  const entry = Object.freeze({
    entryId: `${scope.turnId}:${order}`,
    order,
    seq: resolvedSeq,
    turnId: scope.turnId,
    kind,
    source,
    at,
    payload,
    late,
    dedupKey,
  });
  scope.entries.push(entry);
  scope.seen.set(dedupKey, entry.entryId);
  scope.noteSeq(sourceKey, resolvedSeq);
  scope.note(entry);
  if (late) scope.markLate();
  scope.publish(entry);
  return { entry: entryView(entry), duplicate: false };
}

/**
 * The native side of the boundary. The scope carries the native state slice, the entry machinery
 * and the terminal ledger — and nothing else. `accept`/`send` do not exist here, so a native
 * event cannot transition a turn into the Host-accepted state.
 */
export function createNativeSink(scope) {
  function observe(source, at) {
    if (scope.native.observed) return;
    scope.native.observed = true;
    scope.native.observedAt = at;
    scope.native.observedBy = timelineSourceKey(source);
  }

  return Object.freeze({
    observe,
    record(input) {
      const source = parseTimelineSource(input.source);
      if (source.kind === 'native') observe(source, parseAt(input.at));
      return recordEntry(scope, input);
    },
    end(input) {
      const source = parseTimelineSource(input.source);
      if (source.kind !== 'native') throw new TurnError('invalid_request', 'turn_end_source');
      const terminalReason = parseTerminalReason(input.terminalReason);
      const at = parseAt(input.at);
      observe(source, at);
      const terminalKey = `end|${timelineDedupKey(source, source.nativeEventId)}`;
      if (scope.native.terminal) {
        if (scope.terminalKeys.has(terminalKey)) {
          scope.markDuplicate();
          return { applied: false, superseded: false, duplicate: true };
        }
        scope.markSuperseded();
        return { applied: false, superseded: true, duplicate: false };
      }
      scope.native.terminal = true;
      scope.native.terminalAt = at;
      scope.native.terminalReason = terminalReason;
      scope.native.terminalBy = timelineSourceKey(source);
      scope.terminalKeys.add(terminalKey);
      return { applied: true, superseded: false, duplicate: false };
    },
  });
}

/**
 * The Host side of the boundary: the only sink that may write the Host-accepted state. A Host
 * cancel terminates the turn, but it can never mark the turn natively observed or natively ended.
 */
export function createHostSink(scope) {
  return Object.freeze({
    accept(input) {
      const commandId = requireText(input.commandId, 'turn_command_id');
      const at = parseAt(input.at);
      if (scope.host.accepted) return { applied: false, duplicate: true };
      scope.host.accepted = true;
      scope.host.acceptedAt = at;
      scope.host.acceptedBy = commandId;
      return { applied: true, duplicate: false };
    },
    send(input) {
      const commandId = requireText(input.commandId, 'turn_command_id');
      const at = parseAt(input.at);
      const wasSent = scope.host.sent;
      let entry = null;
      let duplicate = false;
      if (input.payload !== undefined) {
        const source = Object.freeze({ kind: 'host', commandId });
        const outcome = recordEntry(scope, { source, kind: 'message', at, seq: 0, payload: input.payload });
        entry = outcome.entry;
        duplicate = outcome.duplicate;
      }
      if (!wasSent) {
        scope.host.sent = true;
        scope.host.sentAt = at;
        scope.host.sentBy = commandId;
      }
      return { applied: !wasSent, duplicate, entry };
    },
    cancel(input) {
      const commandId = requireText(input.commandId, 'turn_command_id');
      const at = parseAt(input.at);
      const source = Object.freeze({ kind: 'host', commandId });
      const terminalKey = timelineDedupKey(source, 'cancel');
      if (scope.native.terminal) {
        const duplicate = scope.terminalKeys.has(terminalKey);
        if (duplicate) scope.markDuplicate();
        else scope.markSuperseded();
        return { applied: false, superseded: !duplicate, duplicate };
      }
      scope.native.terminal = true;
      scope.native.terminalAt = at;
      scope.native.terminalReason = 'cancelled';
      scope.native.terminalBy = timelineSourceKey(source);
      scope.terminalKeys.add(terminalKey);
      return { applied: true, superseded: false, duplicate: false };
    },
  });
}

/** Identity fields a re-opened turn must match exactly, or the reopen is a conflict. */
export function turnIdentity(turn) {
  return Object.freeze({
    causedBy: turn.causedBy,
    parentTurn: turn.parentTurn,
    attempt: turn.attempt,
    sourceNativeId: turn.sourceNativeId,
  });
}

export function parseTurnIdentity(input) {
  return Object.freeze({
    causedBy: parseOptionalText(input.causedBy, 'turn_caused_by'),
    parentTurn: parseOptionalTurnRef(input.parentTurn),
    attempt: parseAttempt(input.attempt),
    sourceNativeId: parseOptionalText(input.sourceNativeId, 'turn_source_native_id', 1024),
  });
}

export function sameTurnIdentity(left, right) {
  return left.causedBy === right.causedBy
    && left.parentTurn === right.parentTurn
    && left.attempt === right.attempt
    && left.sourceNativeId === right.sourceNativeId;
}

export function parseCommandPhase(value) {
  if (!TURN_COMMAND_PHASES.includes(value)) throw new TurnError('invalid_request', 'turn_command_phase');
  return value;
}

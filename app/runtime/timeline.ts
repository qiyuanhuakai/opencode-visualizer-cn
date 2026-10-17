import { ProtocolError } from '../../shared/runtime/capabilities.js';

/**
 * Causal Turn timeline and state projection (task 32).
 *
 * A Turn is projected from two ordered origins — Host commands and native events — and every
 * timeline entry carries its own complete source, so history is never a blind concatenation.
 * The four turn states (`accepted`, `sent`, `observed`, `terminal`) are INDEPENDENT: each one is
 * written by exactly one side of the boundary. The split is structural, not a comment — the
 * native path works through `NativeTurnContext`, a type that has no Host-state member at all,
 * so a native terminal event cannot reach the Host-accepted state even by accident.
 */

export const TURN_STATE_FLAGS = Object.freeze(['accepted', 'sent', 'observed', 'terminal'] as const);
export const TIMELINE_ENTRY_KINDS = Object.freeze(['message', 'tool', 'thinking', 'interaction', 'usage'] as const);
export const TIMELINE_TERMINAL_REASONS = Object.freeze(['completed', 'failed', 'cancelled', 'timeout', 'aborted'] as const);
export const TURN_COMMAND_PHASES = Object.freeze(['accepted', 'sent', 'cancelled'] as const);
/** Serialized payload ceiling per entry; an oversized message is rejected, never silently truncated. */
export const MAX_TIMELINE_ENTRY_CHARS = 262_144;
export const DEFAULT_TIMELINE_PAGE_LIMIT = 100;
export const MAX_TIMELINE_PAGE_LIMIT = 500;
export const MAX_TIMELINE_SEQ_SPAN = 1_048_576;

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const MAX_TEXT_CHARS = 512;

export type TurnStateFlag = (typeof TURN_STATE_FLAGS)[number];
export type TimelineEntryKind = (typeof TIMELINE_ENTRY_KINDS)[number];
export type TerminalReason = (typeof TIMELINE_TERMINAL_REASONS)[number];
export type TurnCommandPhase = (typeof TURN_COMMAND_PHASES)[number];

/** Every rejection carries an explicit protocol code plus the plain rejection field. */
export class TurnError extends ProtocolError {
  readonly reason: string;
  readonly field: string;

  constructor(code: 'invalid_request' | 'conflict' | 'cancelled' | 'unsupported', reason: string) {
    super(code, `runtime.turn.${reason}`);
    this.name = 'TurnError';
    this.reason = reason;
    this.field = reason;
  }
}

/** The complete origin of one timeline entry: a Host command or one native event from one harness. */
export type TimelineSource =
  | { readonly kind: 'host'; readonly commandId: string }
  | { readonly kind: 'native'; readonly harness: string; readonly nativeEventId: string };

export interface OpenTurnInput {
  readonly turnId?: string;
  readonly causedBy?: string | null;
  readonly parentTurn?: string | null;
  readonly attempt?: number;
  readonly sourceNativeId?: string | null;
}

/** Frozen read model of one turn; the four states are flat and independent. */
export interface TurnView {
  readonly turnId: string;
  readonly causedBy: string | null;
  readonly parentTurn: string | null;
  readonly attempt: number;
  readonly sourceNativeId: string | null;
  readonly createdAt: number;
  readonly accepted: boolean;
  readonly acceptedAt: number | null;
  readonly acceptedBy: string | null;
  readonly sent: boolean;
  readonly sentAt: number | null;
  readonly sentBy: string | null;
  readonly observed: boolean;
  readonly observedAt: number | null;
  readonly observedBy: string | null;
  readonly terminal: boolean;
  readonly terminalAt: number | null;
  readonly terminalReason: TerminalReason | null;
  readonly terminalBy: string | null;
  readonly entryCount: number;
  readonly lastOrder: number | null;
  readonly seqMax: number;
}

export interface TimelineEntryView {
  readonly entryId: string;
  readonly order: number;
  readonly seq: number;
  readonly turnId: string;
  readonly kind: TimelineEntryKind;
  readonly source: TimelineSource;
  readonly at: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly late: boolean;
  readonly dedupKey: string;
}

export interface TimelinePage {
  readonly entries: readonly TimelineEntryView[];
  readonly nextCursor: number | null;
  readonly total: number;
}

export interface TimelineHistoryGroup {
  readonly source: TimelineSource;
  readonly count: number;
  readonly entries: readonly TimelineEntryView[];
}

export interface TurnHistory {
  readonly turnId: string;
  readonly entryCount: number;
  readonly sources: readonly TimelineHistoryGroup[];
}

export interface TurnCommandOutcome {
  readonly turn: TurnView;
  readonly applied: boolean;
  readonly superseded: boolean;
  readonly duplicate: boolean;
  readonly entry: TimelineEntryView | null;
}

export interface TurnOutcome {
  readonly turn: TurnView;
  readonly applied: boolean;
  readonly superseded: boolean;
  readonly duplicate: boolean;
}

export interface TimelineEntryOutcome {
  readonly entry: TimelineEntryView;
  readonly duplicate: boolean;
}

export interface TurnTimelineState {
  readonly turns: number;
  readonly entries: number;
  readonly duplicates: number;
  readonly superseded: number;
  readonly late: number;
  readonly closed: boolean;
}

export interface TurnTimeline {
  open(input: OpenTurnInput): TurnView;
  command(input: {
    readonly turnId: string;
    readonly commandId: string;
    readonly phase: TurnCommandPhase;
    readonly at?: number;
    readonly payload?: Record<string, unknown>;
  }): TurnCommandOutcome;
  event(input: {
    readonly turnId: string;
    readonly source: TimelineSource;
    readonly kind: TimelineEntryKind;
    readonly at?: number;
    readonly seq?: number;
    readonly payload: Record<string, unknown>;
  }): TimelineEntryOutcome;
  end(input: {
    readonly turnId: string;
    readonly source: TimelineSource;
    readonly terminalReason: TerminalReason;
    readonly at?: number;
  }): TurnOutcome;
  turn(turnId: string): TurnView;
  turns(): readonly TurnView[];
  page(input: { readonly turnId?: string; readonly cursor?: number | null; readonly limit?: number }): TimelinePage;
  history(turnId: string): TurnHistory;
  gaps(turnId: string): readonly number[];
  close(): void;
  readonly state: TurnTimelineState;
}

function requireText(value: unknown, reason: string, max = MAX_TEXT_CHARS): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new TurnError('invalid_request', reason);
  }
  return value;
}

function parseTurnId(value: unknown): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new TurnError('invalid_request', 'timeline_turn_id');
  return value.toLowerCase();
}

function parseAttempt(value: unknown): number {
  if (value === undefined) return 1;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new TurnError('invalid_request', 'turn_attempt');
  }
  return value;
}

function parseOptionalTurnRef(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  try {
    return parseTurnId(value);
  } catch {
    throw new TurnError('invalid_request', 'turn_parent_turn');
  }
}

function parseOptionalText(value: unknown, reason: string, max?: number): string | null {
  if (value === undefined || value === null) return null;
  return requireText(value, reason, max);
}

function parseAt(value: unknown): number {
  if (value === undefined) return Date.now();
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TurnError('invalid_request', 'timeline_time');
  return value;
}

function parseSeq(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new TurnError('invalid_request', 'timeline_seq');
  }
  return value;
}

export function parseTimelineSource(value: unknown): TimelineSource {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TurnError('invalid_request', 'timeline_source');
  }
  const record = value as Record<string, unknown>;
  if (record.kind === 'host') {
    return Object.freeze({ kind: 'host', commandId: requireText(record.commandId, 'timeline_source') });
  }
  if (record.kind === 'native') {
    return Object.freeze({
      kind: 'native',
      harness: requireText(record.harness, 'timeline_source'),
      nativeEventId: requireText(record.nativeEventId, 'timeline_source'),
    });
  }
  throw new TurnError('invalid_request', 'timeline_source');
}

function parseEntryKind(value: unknown): TimelineEntryKind {
  if (!TIMELINE_ENTRY_KINDS.includes(value as TimelineEntryKind)) {
    throw new TurnError('invalid_request', 'timeline_entry_kind');
  }
  return value as TimelineEntryKind;
}

function parseTerminalReason(value: unknown): TerminalReason {
  if (!TIMELINE_TERMINAL_REASONS.includes(value as TerminalReason)) {
    throw new TurnError('invalid_request', 'turn_terminal_reason');
  }
  return value as TerminalReason;
}

/** Producer identity of a source — the grouping key history uses so sources are never concatenated. */
export function timelineSourceKey(source: TimelineSource): string {
  return source.kind === 'host' ? `host|${source.commandId}` : `native|${source.harness}`;
}

/**
 * Per-source dedup key: the same native event id from two different sources is two DIFFERENT
 * keys, so the two sources deduplicate independently instead of globally.
 */
export function timelineDedupKey(source: TimelineSource, nativeEventId: string): string {
  return `${timelineSourceKey(source)}\u0000${nativeEventId}`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

function frozenPayload(value: unknown): Readonly<Record<string, unknown>> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TurnError('invalid_request', 'timeline_payload');
  }
  let clone: Record<string, unknown>;
  try {
    clone = structuredClone(value) as Record<string, unknown>;
  } catch {
    throw new TurnError('invalid_request', 'timeline_payload');
  }
  let serialized: string;
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

interface TurnHostState {
  accepted: boolean;
  acceptedAt: number | null;
  acceptedBy: string | null;
  sent: boolean;
  sentAt: number | null;
  sentBy: string | null;
}

interface TurnNativeState {
  observed: boolean;
  observedAt: number | null;
  observedBy: string | null;
  terminal: boolean;
  terminalAt: number | null;
  terminalReason: TerminalReason | null;
  terminalBy: string | null;
}

interface InternalEntry {
  readonly entryId: string;
  readonly order: number;
  readonly seq: number;
  readonly turnId: string;
  readonly kind: TimelineEntryKind;
  readonly source: TimelineSource;
  readonly at: number;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly late: boolean;
  readonly dedupKey: string;
}

interface TurnInternals {
  readonly turnId: string;
  readonly causedBy: string | null;
  readonly parentTurn: string | null;
  readonly attempt: number;
  readonly sourceNativeId: string | null;
  readonly createdAt: number;
  readonly host: TurnHostState;
  readonly native: TurnNativeState;
  readonly entries: InternalEntry[];
  readonly seen: Map<string, string>;
  readonly terminalKeys: Set<string>;
  readonly seqsBySource: Map<string, Set<number>>;
  lastOrder: number | null;
  seqMax: number;
}

/**
 * The entry machinery both sides share. It has no access to either state slice — recording an
 * entry never changes `accepted`, `sent`, `observed` or `terminal`.
 */
interface EntryContext {
  readonly turnId: string;
  readonly entries: InternalEntry[];
  readonly seen: Map<string, string>;
  readonly seqsBySource: Map<string, Set<number>>;
  readonly native: TurnNativeState;
  nextOrder(): number;
  nextSeq(sourceKey: string): number;
  noteSeq(sourceKey: string, seq: number): void;
  note(entry: InternalEntry): void;
  publish(entry: InternalEntry): void;
  markDuplicate(): void;
  markLate(): void;
}

/**
 * The native side of the boundary. This context deliberately exposes NO Host state: its type has
 * no member that can reach `accepted` or `sent`, so a native terminal event structurally cannot
 * transition the turn into the Host-accepted state.
 */
interface NativeTurnContext extends EntryContext {
  readonly terminalKeys: Set<string>;
  markSuperseded(): void;
}

/** The Host side of the boundary: the only path that may write the Host-accepted state. */
interface HostTurnContext extends EntryContext {
  readonly host: TurnHostState;
  readonly terminalKeys: Set<string>;
  markDuplicateHost(): void;
  markSupersededHost(): void;
}

function entryView(entry: InternalEntry): TimelineEntryView {
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

function turnView(turn: TurnInternals): TurnView {
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

export function createTurnTimeline(): TurnTimeline {
  const turnsById = new Map<string, TurnInternals>();
  const allEntries: InternalEntry[] = [];
  const stats = { turns: 0, entries: 0, duplicates: 0, superseded: 0, late: 0 };
  let orderCounter = 0;
  let closed = false;

  function assertOpen(): void {
    if (closed) throw new TurnError('cancelled', 'timeline_closed');
  }

  function requireTurn(turnId: unknown): TurnInternals {
    const id = parseTurnId(turnId);
    const turn = turnsById.get(id);
    if (turn === undefined) throw new TurnError('invalid_request', 'timeline_turn_unknown');
    return turn;
  }

  function entryContext(turn: TurnInternals): EntryContext {
    return {
      turnId: turn.turnId,
      entries: turn.entries,
      seen: turn.seen,
      seqsBySource: turn.seqsBySource,
      native: turn.native,
      nextOrder: () => {
        orderCounter += 1;
        return orderCounter;
      },
      nextSeq: (sourceKey: string) => {
        const bucket = turn.seqsBySource.get(sourceKey);
        let max = 0;
        if (bucket !== undefined) for (const value of bucket) if (value > max) max = value;
        return max + 1;
      },
      noteSeq: (sourceKey: string, seq: number) => {
        let bucket = turn.seqsBySource.get(sourceKey);
        if (bucket === undefined) {
          bucket = new Set();
          turn.seqsBySource.set(sourceKey, bucket);
        }
        bucket.add(seq);
      },
      note: (entry) => {
        turn.seqMax = Math.max(turn.seqMax, entry.seq);
        turn.lastOrder = Math.max(turn.lastOrder ?? 0, entry.order);
      },
      publish: (entry) => {
        allEntries.push(entry);
        stats.entries += 1;
      },
      markDuplicate: () => { stats.duplicates += 1; },
      markLate: () => { stats.late += 1; },
    };
  }

  function nativeContext(turn: TurnInternals): NativeTurnContext {
    return {
      ...entryContext(turn),
      terminalKeys: turn.terminalKeys,
      markSuperseded: () => { stats.superseded += 1; },
    };
  }

  function hostContext(turn: TurnInternals): HostTurnContext {
    return {
      ...entryContext(turn),
      host: turn.host,
      terminalKeys: turn.terminalKeys,
      markDuplicateHost: () => { stats.duplicates += 1; },
      markSupersededHost: () => { stats.superseded += 1; },
    };
  }

  function recordEntry(context: EntryContext, input: {
    source: TimelineSource;
    kind: TimelineEntryKind;
    at: number;
    seq: number;
    payload: Record<string, unknown>;
  }): TimelineEntryOutcome {
    const dedupKey = timelineDedupKey(input.source, input.source.kind === 'host' ? input.source.commandId : input.source.nativeEventId);
    const existingId = context.seen.get(dedupKey);
    if (existingId !== undefined) {
      context.markDuplicate();
      const existing = context.entries.find((entry) => entry.entryId === existingId);
      if (existing === undefined) throw new TurnError('conflict', 'timeline_entry_missing');
      return { entry: entryView(existing), duplicate: true };
    }
    const payload = frozenPayload(input.payload);
    const late = context.native.terminal;
    const sourceKey = timelineSourceKey(input.source);
    const seq = input.seq > 0 ? input.seq : context.nextSeq(sourceKey);
    const order = context.nextOrder();
    const entry: InternalEntry = Object.freeze({
      entryId: `${context.turnId}:${order}`,
      order,
      seq,
      turnId: context.turnId,
      kind: input.kind,
      source: input.source,
      at: input.at,
      payload,
      late,
      dedupKey,
    });
    context.entries.push(entry);
    context.seen.set(dedupKey, entry.entryId);
    context.noteSeq(sourceKey, seq);
    context.note(entry);
    if (late) context.markLate();
    context.publish(entry);
    return { entry: entryView(entry), duplicate: false };
  }

  function open(input: OpenTurnInput): TurnView {
    assertOpen();
    const turnId = input.turnId === undefined ? crypto.randomUUID() : parseTurnId(input.turnId);
    const causedBy = parseOptionalText(input.causedBy, 'turn_caused_by');
    const parentTurn = parseOptionalTurnRef(input.parentTurn);
    const attempt = parseAttempt(input.attempt);
    const sourceNativeId = parseOptionalText(input.sourceNativeId, 'turn_source_native_id', 1024);
    const existing = turnsById.get(turnId);
    if (existing !== undefined) {
      const identical = existing.causedBy === causedBy
        && existing.parentTurn === parentTurn
        && existing.attempt === attempt
        && existing.sourceNativeId === sourceNativeId;
      if (!identical) throw new TurnError('conflict', 'turn_duplicate');
      return turnView(existing);
    }
    const turn: TurnInternals = {
      turnId,
      causedBy,
      parentTurn,
      attempt,
      sourceNativeId,
      createdAt: Date.now(),
      host: { accepted: false, acceptedAt: null, acceptedBy: null, sent: false, sentAt: null, sentBy: null },
      native: { observed: false, observedAt: null, observedBy: null, terminal: false, terminalAt: null, terminalReason: null, terminalBy: null },
      entries: [],
      seen: new Map(),
      terminalKeys: new Set(),
      seqsBySource: new Map(),
      lastOrder: null,
      seqMax: 0,
    };
    turnsById.set(turnId, turn);
    stats.turns += 1;
    return turnView(turn);
  }

  function command(input: {
    turnId: string;
    commandId: string;
    phase: TurnCommandPhase;
    at?: number;
    payload?: Record<string, unknown>;
  }): TurnCommandOutcome {
    assertOpen();
    const turn = requireTurn(input.turnId);
    const commandId = requireText(input.commandId, 'turn_command_id');
    if (!TURN_COMMAND_PHASES.includes(input.phase)) {
      throw new TurnError('invalid_request', 'turn_command_phase');
    }
    const at = parseAt(input.at);

    if (input.phase === 'accepted') {
      if (turn.host.accepted) {
        return { turn: turnView(turn), applied: false, superseded: false, duplicate: true, entry: null };
      }
      turn.host.accepted = true;
      turn.host.acceptedAt = at;
      turn.host.acceptedBy = commandId;
      return { turn: turnView(turn), applied: true, superseded: false, duplicate: false, entry: null };
    }

    if (input.phase === 'sent') {
      const wasSent = turn.host.sent;
      let entry: TimelineEntryView | null = null;
      let duplicate = false;
      if (input.payload !== undefined) {
        const source: TimelineSource = Object.freeze({ kind: 'host', commandId });
        const outcome = recordEntry(entryContext(turn), { source, kind: 'message', at, seq: 0, payload: input.payload });
        entry = outcome.entry;
        duplicate = outcome.duplicate;
      }
      if (!wasSent) {
        turn.host.sent = true;
        turn.host.sentAt = at;
        turn.host.sentBy = commandId;
      }
      return { turn: turnView(turn), applied: !wasSent, superseded: false, duplicate, entry };
    }

    // Host cancel: a Host command may terminate the turn; it still cannot fake acceptance.
    const context = hostContext(turn);
    const source: TimelineSource = Object.freeze({ kind: 'host', commandId });
    const terminalKey = timelineDedupKey(source, 'cancel');
    if (turn.native.terminal) {
      const duplicate = context.terminalKeys.has(terminalKey);
      if (duplicate) context.markDuplicateHost();
      else context.markSupersededHost();
      return { turn: turnView(turn), applied: false, superseded: !duplicate, duplicate, entry: null };
    }
    turn.native.terminal = true;
    turn.native.terminalAt = at;
    turn.native.terminalReason = 'cancelled';
    turn.native.terminalBy = timelineSourceKey(source);
    context.terminalKeys.add(terminalKey);
    return { turn: turnView(turn), applied: true, superseded: false, duplicate: false, entry: null };
  }

  function event(input: {
    turnId: string;
    source: TimelineSource;
    kind: TimelineEntryKind;
    at?: number;
    seq?: number;
    payload: Record<string, unknown>;
  }): TimelineEntryOutcome {
    assertOpen();
    const turn = requireTurn(input.turnId);
    const source = parseTimelineSource(input.source);
    const kind = parseEntryKind(input.kind);
    const at = parseAt(input.at);
    const seq = parseSeq(input.seq);
    if (source.kind === 'native' && !turn.native.observed) {
      turn.native.observed = true;
      turn.native.observedAt = at;
      turn.native.observedBy = timelineSourceKey(source);
    }
    return recordEntry(nativeContext(turn), { source, kind, at, seq, payload: input.payload });
  }

  function end(input: {
    turnId: string;
    source: TimelineSource;
    terminalReason: TerminalReason;
    at?: number;
  }): TurnOutcome {
    assertOpen();
    const turn = requireTurn(input.turnId);
    const source = parseTimelineSource(input.source);
    if (source.kind !== 'native') throw new TurnError('invalid_request', 'turn_end_source');
    const terminalReason = parseTerminalReason(input.terminalReason);
    const at = parseAt(input.at);
    const context = nativeContext(turn);
    if (!turn.native.observed) {
      turn.native.observed = true;
      turn.native.observedAt = at;
      turn.native.observedBy = timelineSourceKey(source);
    }
    const terminalKey = `end|${timelineDedupKey(source, source.nativeEventId)}`;
    if (turn.native.terminal) {
      if (context.terminalKeys.has(terminalKey)) {
        context.markDuplicate();
        return { turn: turnView(turn), applied: false, superseded: false, duplicate: true };
      }
      context.markSuperseded();
      return { turn: turnView(turn), applied: false, superseded: true, duplicate: false };
    }
    turn.native.terminal = true;
    turn.native.terminalAt = at;
    turn.native.terminalReason = terminalReason;
    turn.native.terminalBy = timelineSourceKey(source);
    context.terminalKeys.add(terminalKey);
    return { turn: turnView(turn), applied: true, superseded: false, duplicate: false };
  }

  function turn(turnId: string): TurnView {
    assertOpen();
    return turnView(requireTurn(turnId));
  }

  function turns(): readonly TurnView[] {
    assertOpen();
    return Object.freeze([...turnsById.values()].map(turnView));
  }

  function page(input: { turnId?: string; cursor?: number | null; limit?: number }): TimelinePage {
    assertOpen();
    const limit = input.limit === undefined ? DEFAULT_TIMELINE_PAGE_LIMIT : input.limit;
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > MAX_TIMELINE_PAGE_LIMIT) {
      throw new TurnError('invalid_request', 'timeline_limit');
    }
    const cursor = input.cursor === undefined || input.cursor === null ? 0 : input.cursor;
    if (typeof cursor !== 'number' || !Number.isInteger(cursor) || cursor < 0) {
      throw new TurnError('invalid_request', 'timeline_cursor');
    }
    const source = input.turnId === undefined ? allEntries : requireTurn(input.turnId).entries;
    const remaining = source.filter((entry) => entry.order > cursor);
    const taken = remaining.slice(0, limit);
    return Object.freeze({
      entries: Object.freeze(taken.map(entryView)),
      nextCursor: remaining.length > limit ? (taken[taken.length - 1]?.order ?? null) : null,
      total: source.length,
    });
  }

  function history(turnId: string): TurnHistory {
    assertOpen();
    const turn = requireTurn(turnId);
    const groups = new Map<string, { source: TimelineSource; entries: InternalEntry[] }>();
    for (const entry of turn.entries) {
      const key = timelineSourceKey(entry.source);
      const group = groups.get(key);
      if (group === undefined) groups.set(key, { source: entry.source, entries: [entry] });
      else group.entries.push(entry);
    }
    return Object.freeze({
      turnId: turn.turnId,
      entryCount: turn.entries.length,
      sources: Object.freeze([...groups.values()].map((group) => Object.freeze({
        source: group.source,
        count: group.entries.length,
        entries: Object.freeze(group.entries.map(entryView)),
      }))),
    });
  }

  function gaps(turnId: string): readonly number[] {
    assertOpen();
    const turn = requireTurn(turnId);
    const missing = new Set<number>();
    for (const bucket of turn.seqsBySource.values()) {
      if (bucket.size === 0) continue;
      const sorted = [...bucket].sort((left, right) => left - right);
      const first = sorted[0] as number;
      const last = sorted[sorted.length - 1] as number;
      if (last - first > MAX_TIMELINE_SEQ_SPAN) {
        throw new TurnError('invalid_request', 'timeline_seq_span');
      }
      for (let value = first; value <= last; value += 1) {
        if (!bucket.has(value)) missing.add(value);
      }
    }
    return Object.freeze([...missing].sort((left, right) => left - right));
  }

  function close(): void {
    closed = true;
    turnsById.clear();
    allEntries.length = 0;
  }

  return {
    open,
    command,
    event,
    end,
    turn,
    turns,
    page,
    history,
    gaps,
    close,
    get state() {
      return {
        turns: stats.turns,
        entries: stats.entries,
        duplicates: stats.duplicates,
        superseded: stats.superseded,
        late: stats.late,
        closed,
      };
    },
  };
}

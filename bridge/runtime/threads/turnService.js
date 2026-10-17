import { randomUUID } from 'node:crypto';
import {
  DEFAULT_TIMELINE_PAGE_LIMIT,
  MAX_TIMELINE_PAGE_LIMIT,
  TurnError,
  createHostSink,
  createNativeSink,
  entryView,
  parseAt,
  parseCommandPhase,
  parseTurnId,
  parseTurnIdentity,
  parseTimelineSource,
  sameTurnIdentity,
  turnIdentity,
  turnView,
} from './timelineProjection.js';

/**
 * Canonical Turn service (task 32). Turns are projected from two ordered origins — Host commands
 * and native events — into one paged timeline where every entry carries its complete source.
 *
 * The four turn states are independent: `accepted` and `sent` are written only through the Host
 * sink, `observed` and `terminal` only through the native sink (plus a Host cancel, which is a
 * Host command). The native sink's scope contains no Host state at all, so a native terminal
 * event structurally cannot transition a turn into the Host-accepted state.
 *
 * Deduplication is per-source: the same native event id from two different sources is tracked
 * independently, and the same (source, native event id) twice is one entry.
 */
export function createTurnService() {
  const turnsById = new Map();
  const allEntries = [];
  const stats = { turns: 0, entries: 0, duplicates: 0, superseded: 0, late: 0 };
  let orderCounter = 0;
  let closed = false;

  function assertOpen() {
    if (closed) throw new TurnError('cancelled', 'timeline_closed');
  }

  function requireTurn(turnId) {
    const id = parseTurnId(turnId);
    const turn = turnsById.get(id);
    if (turn === undefined) throw new TurnError('invalid_request', 'timeline_turn_unknown');
    return turn;
  }

  function nextOrder() {
    orderCounter += 1;
    return orderCounter;
  }

  function entryScope(turn) {
    return {
      turnId: turn.turnId,
      entries: turn.entries,
      seen: turn.seen,
      seqs: turn.seqs,
      native: turn.native,
      nextOrder,
      nextSeq() {
        let max = 0;
        for (const value of turn.seqs) if (value > max) max = value;
        return max + 1;
      },
      note(entry) {
        turn.seqMax = Math.max(turn.seqMax, entry.seq);
        turn.lastOrder = Math.max(turn.lastOrder ?? 0, entry.order);
      },
      publish(entry) {
        allEntries.push(entry);
        stats.entries += 1;
      },
      markDuplicate() {
        stats.duplicates += 1;
      },
      markSuperseded() {
        stats.superseded += 1;
      },
      markLate() {
        stats.late += 1;
      },
    };
  }

  function nativeScope(turn) {
    return { ...entryScope(turn), terminalKeys: turn.terminalKeys };
  }

  function hostScope(turn) {
    return { ...entryScope(turn), host: turn.host, terminalKeys: turn.terminalKeys };
  }

  function open(input = {}) {
    assertOpen();
    const turnId = input.turnId === undefined ? randomUUID() : parseTurnId(input.turnId);
    const identity = parseTurnIdentity(input);
    const existing = turnsById.get(turnId);
    if (existing !== undefined) {
      if (!sameTurnIdentity(identity, turnIdentity(existing))) {
        throw new TurnError('conflict', 'turn_duplicate');
      }
      return turnView(existing);
    }
    const turn = {
      turnId,
      causedBy: identity.causedBy,
      parentTurn: identity.parentTurn,
      attempt: identity.attempt,
      sourceNativeId: identity.sourceNativeId,
      createdAt: Date.now(),
      host: { accepted: false, acceptedAt: null, acceptedBy: null, sent: false, sentAt: null, sentBy: null },
      native: {
        observed: false,
        observedAt: null,
        observedBy: null,
        terminal: false,
        terminalAt: null,
        terminalReason: null,
        terminalBy: null,
      },
      entries: [],
      seen: new Map(),
      terminalKeys: new Set(),
      seqs: new Set(),
      lastOrder: null,
      seqMax: 0,
    };
    turnsById.set(turnId, turn);
    stats.turns += 1;
    return turnView(turn);
  }

  function command(input = {}) {
    assertOpen();
    const turn = requireTurn(input.turnId);
    const phase = parseCommandPhase(input.phase);
    const sink = createHostSink(hostScope(turn));
    if (phase === 'accepted') {
      const outcome = sink.accept(input);
      return { turn: turnView(turn), applied: outcome.applied, superseded: false, duplicate: outcome.duplicate, entry: null };
    }
    if (phase === 'sent') {
      const outcome = sink.send(input);
      return { turn: turnView(turn), applied: outcome.applied, superseded: false, duplicate: outcome.duplicate, entry: outcome.entry };
    }
    const outcome = sink.cancel(input);
    return { turn: turnView(turn), applied: outcome.applied, superseded: outcome.superseded, duplicate: outcome.duplicate, entry: null };
  }

  function event(input = {}) {
    assertOpen();
    const turn = requireTurn(input.turnId);
    const source = parseTimelineSource(input.source);
    if (input.kind === undefined) throw new TurnError('invalid_request', 'timeline_entry_kind');
    const sink = createNativeSink(nativeScope(turn));
    return sink.record({ ...input, source, at: parseAt(input.at) });
  }

  function end(input = {}) {
    assertOpen();
    const turn = requireTurn(input.turnId);
    const sink = createNativeSink(nativeScope(turn));
    const outcome = sink.end(input);
    return { turn: turnView(turn), applied: outcome.applied, superseded: outcome.superseded, duplicate: outcome.duplicate };
  }

  function turn(turnId) {
    assertOpen();
    return turnView(requireTurn(turnId));
  }

  function turns() {
    assertOpen();
    return Object.freeze([...turnsById.values()].map(turnView));
  }

  function page(input = {}) {
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

  function history(turnId) {
    assertOpen();
    const turn = requireTurn(turnId);
    const groups = new Map();
    for (const entry of turn.entries) {
      const key = entry.source.kind === 'host' ? `host|${entry.source.commandId}` : `native|${entry.source.harness}`;
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

  function gaps(turnId) {
    assertOpen();
    const turn = requireTurn(turnId);
    if (turn.seqs.size === 0) return Object.freeze([]);
    const sorted = [...turn.seqs].sort((left, right) => left - right);
    const first = sorted[0] ?? 0;
    const last = sorted[sorted.length - 1] ?? 0;
    const missing = [];
    for (let value = first; value <= last; value += 1) {
      if (!turn.seqs.has(value)) missing.push(value);
    }
    return Object.freeze(missing);
  }

  function close() {
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

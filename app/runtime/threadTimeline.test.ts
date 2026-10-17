// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  MAX_TIMELINE_ENTRY_CHARS,
  MAX_TIMELINE_SEQ_SPAN,
  TIMELINE_ENTRY_KINDS,
  TIMELINE_TERMINAL_REASONS,
  TURN_COMMAND_PHASES,
  TURN_STATE_FLAGS,
  TurnError,
  createTurnTimeline,
  timelineDedupKey,
  timelineSourceKey,
} from './timeline';
import { createTurnService } from '../../bridge/runtime/threads/turnService.js';
import type {
  OpenTurnInput,
  TimelineEntryKind,
  TimelineEntryView,
  TimelinePage,
  TimelineSource,
  TurnCommandOutcome,
  TurnHistory,
  TurnOutcome,
  TurnTimeline,
  TurnView,
} from './timeline';

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const MISSING_TURN = '99999999-9999-4999-8999-999999999999';
const TURN_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TURN_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const hostSource = (commandId: string): TimelineSource => ({ kind: 'host', commandId });
const nativeSource = (harness: string, nativeEventId: string): TimelineSource => ({
  kind: 'native',
  harness,
  nativeEventId,
});

function errorOf(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}

function rejectionOf(run: () => unknown): { code: string; field: string } | undefined {
  const error = errorOf(run);
  if (error === undefined) return undefined;
  if (!(error instanceof TurnError)) return { code: `not-a-TurnError:${String(error)}`, field: String(error) };
  return { code: error.code, field: error.field };
}

function laneRejectionOf(run: () => unknown): { code: string; field: string } | undefined {
  const error: unknown = errorOf(run);
  if (error === undefined) return undefined;
  if (!(error instanceof Error) || typeof (error as { field?: unknown }).field !== 'string') {
    return { code: `not-a-TurnError:${String(error)}`, field: String(error) };
  }
  const coded = error as unknown as { code: string; field: string };
  return { code: coded.code, field: coded.field };
}

function open(timeline: TurnTimeline, overrides: OpenTurnInput = {}): TurnView {
  return timeline.open({ causedBy: 'cmd-1', ...overrides });
}

describe('causal turn identity', () => {
  it('opens a turn with an independent id plus causedBy, parentTurn, attempt and sourceNativeId', () => {
    const timeline = createTurnTimeline();

    const turn = timeline.open({
      causedBy: 'cmd-1',
      parentTurn: MISSING_TURN,
      attempt: 2,
      sourceNativeId: 'codex-turn-7',
    });

    expect(turn.turnId).toMatch(UUID_PATTERN);
    expect(turn.turnId).not.toBe('codex-turn-7');
    expect(turn.causedBy).toBe('cmd-1');
    expect(turn.parentTurn).toBe(MISSING_TURN);
    expect(turn.attempt).toBe(2);
    expect(turn.sourceNativeId).toBe('codex-turn-7');
    expect(TURN_STATE_FLAGS.map((flag) => turn[flag])).toEqual([false, false, false, false]);
    expect(turn.entryCount).toBe(0);
    expect(Object.isFrozen(turn)).toBe(true);
  });

  it('accepts a caller-supplied canonical turn id for restart rebuild and rejects a malformed one', () => {
    const timeline = createTurnTimeline();
    const supplied = '11111111-1111-4111-8111-111111111111';

    const first = timeline.open({ turnId: supplied, causedBy: 'cmd-1' });
    const replay = timeline.open({ turnId: supplied, causedBy: 'cmd-1' });

    expect(first.turnId).toBe(supplied);
    expect(replay.turnId).toBe(supplied);
    expect(timeline.state.turns).toBe(1);
    expect(rejectionOf(() => timeline.open({ turnId: 'not-a-uuid', causedBy: 'cmd-1' }))).toEqual({
      code: 'invalid_request',
      field: 'timeline_turn_id',
    });
    expect(rejectionOf(() => timeline.open({ turnId: supplied, causedBy: 'cmd-2' }))).toEqual({
      code: 'conflict',
      field: 'turn_duplicate',
    });
  });

  it('links a causal fan-out placeholder through parentTurn and causedBy across attempts', () => {
    const timeline = createTurnTimeline();

    const parent = timeline.open({ causedBy: 'cmd-root', sourceNativeId: 'codex:root' });
    const first = timeline.open({ causedBy: parent.turnId, parentTurn: parent.turnId, attempt: 1, sourceNativeId: 'codex:child' });
    const retry = timeline.open({ causedBy: parent.turnId, parentTurn: parent.turnId, attempt: 2, sourceNativeId: 'codex:child' });

    expect(parent.parentTurn).toBeNull();
    expect(first.causedBy).toBe(parent.turnId);
    expect(first.parentTurn).toBe(parent.turnId);
    expect(retry.parentTurn).toBe(parent.turnId);
    expect(retry.attempt).not.toBe(first.attempt);
    expect(timeline.turns().map((entry) => entry.turnId)).toEqual([parent.turnId, first.turnId, retry.turnId]);
  });

  it('rejects malformed turn identity fields with explicit codes and fields', () => {
    const timeline = createTurnTimeline();

    expect(rejectionOf(() => timeline.open({ causedBy: 42 as unknown as string }))).toEqual({ code: 'invalid_request', field: 'turn_caused_by' });
    expect(rejectionOf(() => timeline.open({ causedBy: 'cmd-1', attempt: 0 }))).toEqual({ code: 'invalid_request', field: 'turn_attempt' });
    expect(rejectionOf(() => timeline.open({ causedBy: 'cmd-1', attempt: 1.5 }))).toEqual({ code: 'invalid_request', field: 'turn_attempt' });
    expect(rejectionOf(() => timeline.open({ causedBy: 'cmd-1', parentTurn: 'not-a-uuid' }))).toEqual({ code: 'invalid_request', field: 'turn_parent_turn' });
    expect(rejectionOf(() => timeline.open({ causedBy: 'cmd-1', sourceNativeId: '' }))).toEqual({ code: 'invalid_request', field: 'turn_source_native_id' });
    expect(timeline.state.turns).toBe(0);
  });
});

describe('independent turn states', () => {
  it('keeps accepted / sent / observed / terminal as four independent states', () => {
    const timeline = createTurnTimeline();
    const turn = open(timeline);

    const afterObserve = timeline.turn(turn.turnId);
    const observed = timeline.event({
      turnId: turn.turnId,
      source: nativeSource('codex', 'evt-observe'),
      kind: 'message',
      at: 10,
      payload: { text: 'native hello' },
    });
    const afterNativeObserve = timeline.turn(turn.turnId);
    expect(afterNativeObserve.observed).toBe(true);
    expect(afterNativeObserve.accepted).toBe(false);
    expect(afterNativeObserve.sent).toBe(false);
    expect(afterNativeObserve.terminal).toBe(false);
    expect(afterObserve.observed).toBe(false);
    expect(observed.duplicate).toBe(false);

    const accepted = timeline.command({ turnId: turn.turnId, commandId: 'cmd-1', phase: 'accepted', at: 5 });
    expect(accepted.turn.accepted).toBe(true);
    expect(accepted.turn.sent).toBe(false);
    expect(accepted.turn.observed).toBe(true);
    expect(accepted.turn.terminal).toBe(false);

    const sent = timeline.command({ turnId: turn.turnId, commandId: 'cmd-1', phase: 'sent', at: 6, payload: { text: 'host prompt' } });
    expect(sent.turn.sent).toBe(true);
    expect(sent.turn.accepted).toBe(true);
    expect(sent.turn.observed).toBe(true);
    expect(sent.turn.terminal).toBe(false);
    expect(sent.turn.sentAt).toBe(6);
    expect(sent.turn.sentBy).toBe('cmd-1');

    const ended = timeline.end({ turnId: turn.turnId, source: nativeSource('codex', 'evt-end'), terminalReason: 'completed', at: 20 });
    expect(ended.turn.terminal).toBe(true);
    expect(ended.turn.accepted).toBe(true);
    expect(ended.turn.sent).toBe(true);
    expect(ended.turn.observed).toBe(true);
    expect(ended.turn.terminalReason).toBe('completed');
  });

  it('never lets a native ended event transition the turn into the Host-accepted state', () => {
    const timeline = createTurnTimeline();
    const turn = open(timeline, { sourceNativeId: 'codex-turn-1' });

    timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'evt-a'), kind: 'thinking', at: 1, payload: { text: 'plan' } });
    timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'evt-b'), kind: 'tool', at: 2, payload: { tool: 'bash' } });
    timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'evt-c'), kind: 'interaction', at: 3, payload: { id: 'approval-1' } });
    timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'evt-d'), kind: 'usage', at: 4, payload: { input: 10, output: 20 } });
    const ended = timeline.end({ turnId: turn.turnId, source: nativeSource('codex', 'evt-end'), terminalReason: 'completed', at: 5 });

    const view = timeline.turn(turn.turnId);
    expect(view.terminal).toBe(true);
    expect(view.terminalReason).toBe('completed');
    expect(view.terminalBy).toBe('native|codex');
    // A native terminal event must never set the Host-accepted state.
    expect(view.accepted).toBe(false);
    expect(view.acceptedAt).toBeNull();
    expect(view.acceptedBy).toBeNull();
    expect(view.sent).toBe(false);
    expect(view.sentAt).toBeNull();
    expect(view.sentBy).toBeNull();
    expect(ended.applied).toBe(true);
    expect(TURN_STATE_FLAGS.map((flag) => view[flag])).toEqual([false, false, true, true]);
  });

  it('projects host commands and native events in one ordered timeline where every entry carries its complete source', () => {
    const timeline = createTurnTimeline();
    const turn = open(timeline);
    const turnId = turn.turnId;

    timeline.command({ turnId, commandId: 'cmd-1', phase: 'accepted', at: 1 });
    const sent = timeline.command({ turnId, commandId: 'cmd-1', phase: 'sent', at: 2, payload: { text: 'fix the failing test' } });
    expect(sent.entry).not.toBeNull();
    const hostEntryId = sent.entry?.entryId ?? 'missing-host-entry';
    const codexThinking = timeline.event({
      turnId: turn.turnId,
      source: nativeSource('codex', 'evt-a'),
      kind: 'thinking',
      at: 3,
      payload: { text: 'reading the test' },
    });
    const kimiThinking = timeline.event({
      turnId: turn.turnId,
      source: nativeSource('kimi-web', 'evt-a'),
      kind: 'thinking',
      at: 4,
      payload: { text: 'reading the test' },
    });
    const codexTool = timeline.event({
      turnId: turn.turnId,
      source: nativeSource('codex', 'evt-b'),
      kind: 'tool',
      at: 5,
      payload: { tool: 'bash', title: 'pnpm test' },
    });

    const page = timeline.page({ limit: 10 });
    expect(page.entries.map((entry) => entry.entryId)).toEqual([
      hostEntryId,
      codexThinking.entry.entryId,
      kimiThinking.entry.entryId,
      codexTool.entry.entryId,
    ]);
    expect(page.entries.map((entry) => entry.order)).toEqual([1, 2, 3, 4]);
    expect(page.total).toBe(4);
    expect(sent.entry?.source).toEqual({ kind: 'host', commandId: 'cmd-1' });
    expect(sent.entry?.kind).toBe('message');
    expect(kimiThinking.entry.source).toEqual({ kind: 'native', harness: 'kimi-web', nativeEventId: 'evt-a' });
    for (const entry of page.entries) {
      expect(TIMELINE_ENTRY_KINDS).toContain(entry.kind);
      expect(Object.isFrozen(entry)).toBe(true);
      expect(Object.isFrozen(entry.source)).toBe(true);
      expect(entry.source.kind === 'host' ? entry.source.commandId.length > 0 : entry.source.nativeEventId.length > 0).toBe(true);
      expect(entry.at).toBeGreaterThan(0);
      expect(Object.isFrozen(entry.payload)).toBe(true);
    }
  });

  it('projects the real dsh, kimi-web and codex source shapes with a complete source on every entry', () => {
    const timeline = createTurnTimeline();
    const turn = open(timeline, { sourceNativeId: 'dsh-session-1' });

    // dsh follow op: { kind: 'turn', phase: 'ended', sessionId, turn, time, reason }
    const dshEnded = { kind: 'turn', phase: 'ended', sessionId: 'dsh-1', turn: 3, time: 30, reason: { kind: 'completed' as const } };
    // kimi-web op: { kind: 'step', phase: 'completed', ..., usage }
    const kimiStep = { kind: 'step', phase: 'completed', sessionId: 'kimi-1', agentId: 'agent-1', turnId: 3, step: 1, time: 20, usage: { inputTokens: 11, outputTokens: 22 } };
    // codex turn item: { type: 'reasoning', id, createdAt, ... }
    const codexItem = { type: 'reasoning', id: 'item-r1', createdAt: 10, summary: ['thinking about the fix'] };

    const codexEntry = timeline.event({
      turnId: turn.turnId,
      source: nativeSource('codex', String(codexItem.id)),
      kind: 'thinking',
      at: codexItem.createdAt,
      payload: { summary: codexItem.summary },
    });
    const kimiEntry = timeline.event({
      turnId: turn.turnId,
      source: nativeSource('kimi-web', `kimi-1#agent-1#turn:${kimiStep.turnId}#step:${kimiStep.step}`),
      kind: 'usage',
      at: kimiStep.time,
      payload: kimiStep.usage as Record<string, unknown>,
    });
    const ended = timeline.end({
      turnId: turn.turnId,
      source: nativeSource('dsh', `dsh-1#turn:${dshEnded.turn}#${dshEnded.phase}`),
      terminalReason: dshEnded.reason.kind,
      at: dshEnded.time,
    });

    expect(codexEntry.entry.source).toEqual({ kind: 'native', harness: 'codex', nativeEventId: 'item-r1' });
    expect(codexEntry.entry.payload).toEqual({ summary: ['thinking about the fix'] });
    expect(kimiEntry.entry.kind).toBe('usage');
    expect(kimiEntry.entry.payload).toEqual({ inputTokens: 11, outputTokens: 22 });
    expect(ended.turn.terminalReason).toBe('completed');
    expect(ended.turn.terminalBy).toBe('native|dsh');
    const history = timeline.history(turn.turnId);
    expect(history.sources.map((group) => [group.source.kind, group.count])).toEqual([
      ['native', 1],
      ['native', 1],
    ]);
    expect(history.sources.map((group) => (group.source.kind === 'native' ? group.source.harness : 'host'))).toEqual(['codex', 'kimi-web']);
  });
});

describe('per-source deduplication', () => {
  it('deduplicates the same native event per source, not globally', () => {
    const timeline = createTurnTimeline();
    const turn = open(timeline);

    const codexFirst = timeline.event({
      turnId: turn.turnId,
      source: nativeSource('codex', 'evt-shared'),
      kind: 'message',
      at: 1,
      payload: { text: 'same native id' },
    });
    const codexRepeat = timeline.event({
      turnId: turn.turnId,
      source: nativeSource('codex', 'evt-shared'),
      kind: 'message',
      at: 2,
      payload: { text: 'same native id' },
    });
    const dshSameId = timeline.event({
      turnId: turn.turnId,
      source: nativeSource('dsh', 'evt-shared'),
      kind: 'message',
      at: 3,
      payload: { text: 'same native id' },
    });

    expect(codexRepeat.duplicate).toBe(true);
    expect(codexRepeat.entry.entryId).toBe(codexFirst.entry.entryId);
    expect(codexRepeat.entry.order).toBe(codexFirst.entry.order);
    expect(dshSameId.duplicate).toBe(false);
    expect(dshSameId.entry.entryId).not.toBe(codexFirst.entry.entryId);

    const page = timeline.page({ limit: 10 });
    expect(page.entries.length).toBe(2);
    expect(page.total).toBe(2);
    expect(timeline.state.duplicates).toBe(1);
    expect(timelineDedupKey(nativeSource('codex', 'evt-shared'), 'evt-shared')).toBe(timelineDedupKey(nativeSource('codex', 'evt-shared'), 'evt-shared'));
    expect(timelineDedupKey(nativeSource('codex', 'evt-shared'), 'evt-shared')).not.toBe(timelineDedupKey(nativeSource('dsh', 'evt-shared'), 'evt-shared'));
    expect(timelineDedupKey(hostSource('cmd-1'), 'cmd-1')).not.toBe(timelineDedupKey(nativeSource('codex', 'cmd-1'), 'cmd-1'));

    const history = timeline.history(turn.turnId);
    expect(history.sources).toHaveLength(2);
    expect(history.entryCount).toBe(2);
  });
});

describe('history never blindly concatenates sources', () => {
  it('groups history per source and returns a frozen snapshot that a later mutation cannot change', () => {
    const timeline = createTurnTimeline();
    const turn = open(timeline);

    timeline.command({ turnId: turn.turnId, commandId: 'cmd-1', phase: 'sent', at: 1, payload: { text: 'host prompt' } });
    timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'evt-1'), kind: 'message', at: 2, payload: { text: 'native one' } });
    timeline.event({ turnId: turn.turnId, source: nativeSource('dsh', 'evt-1'), kind: 'message', at: 3, payload: { text: 'native one' } });
    timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'evt-2'), kind: 'message', at: 4, payload: { text: 'native two' } });

    const history: TurnHistory = timeline.history(turn.turnId);
    expect(history.entryCount).toBe(4);
    expect(history.sources.map((group) => [group.source.kind === 'host' ? group.source.commandId : group.source.harness, group.count])).toEqual([
      ['cmd-1', 1],
      ['codex', 2],
      ['dsh', 1],
    ]);
    for (const group of history.sources) {
      for (const entry of group.entries) {
        expect(timelineSourceKey(entry.source)).toBe(timelineSourceKey(group.source));
      }
    }
    expect(Object.isFrozen(history)).toBe(true);
    expect(Object.isFrozen(history.sources)).toBe(true);

    const before = timeline.history(turn.turnId);
    timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'evt-3'), kind: 'message', at: 5, payload: { text: 'later' } });
    expect(before.entryCount).toBe(4);
    expect(before.sources[1]?.entries.map((entry) => entry.at)).toEqual([2, 4]);
    expect(timeline.history(turn.turnId).entryCount).toBe(5);
  });
});

describe('paged timeline reads', () => {
  it('pages 250 entries with real numbers and a stable cursor', () => {
    const timeline = createTurnTimeline();
    const turn = open(timeline);

    for (let index = 0; index < 250; index += 1) {
      timeline.event({
        turnId: turn.turnId,
        source: nativeSource('codex', `evt-${index}`),
        kind: 'message',
        at: index + 1,
        payload: { text: `message ${index}` },
      });
    }

    const first: TimelinePage = timeline.page({ limit: 100 });
    const second: TimelinePage = timeline.page({ limit: 100, cursor: first.nextCursor });
    const third: TimelinePage = timeline.page({ limit: 100, cursor: second.nextCursor });

    expect(first.entries.length).toBe(100);
    expect(first.total).toBe(250);
    expect(first.nextCursor).toBe(first.entries[99]?.order ?? -1);
    expect(second.entries.length).toBe(100);
    expect(second.entries[0]?.order).toBe((first.nextCursor ?? 0) + 1);
    expect(third.entries.length).toBe(50);
    expect(third.nextCursor).toBeNull();

    const all = [...first.entries, ...second.entries, ...third.entries];
    expect(all.length).toBe(250);
    expect(new Set(all.map((entry) => entry.order)).size).toBe(250);
    expect(all.map((entry) => entry.order)).toEqual([...all.map((entry) => entry.order)].sort((left, right) => left - right));
    expect(new Set(all.map((entry) => entry.entryId)).size).toBe(250);
    expect(all.every((entry: TimelineEntryView) => entry.turnId === turn.turnId)).toBe(true);
  });

  it('rejects a malformed page cursor and an out-of-range limit with explicit codes and fields', () => {
    const timeline = createTurnTimeline();
    const turn = open(timeline);

    expect(rejectionOf(() => timeline.page({ limit: 0 }))).toEqual({ code: 'invalid_request', field: 'timeline_limit' });
    expect(rejectionOf(() => timeline.page({ limit: 10_000 }))).toEqual({ code: 'invalid_request', field: 'timeline_limit' });
    expect(rejectionOf(() => timeline.page({ limit: 10, cursor: -1 }))).toEqual({ code: 'invalid_request', field: 'timeline_cursor' });
    expect(rejectionOf(() => timeline.page({ limit: 10, turnId: MISSING_TURN }))).toEqual({ code: 'invalid_request', field: 'timeline_turn_unknown' });
    expect(timeline.page({ turnId: turn.turnId, limit: 10 }).total).toBe(0);
  });
});

describe('failure classes', () => {
  it('rejects a response for an unknown turn with an explicit code and field', () => {
    const timeline = createTurnTimeline();

    expect(rejectionOf(() => timeline.event({
      turnId: MISSING_TURN,
      source: nativeSource('codex', 'evt-1'),
      kind: 'message',
      at: 1,
      payload: { text: 'orphan' },
    }))).toEqual({ code: 'invalid_request', field: 'timeline_turn_unknown' });
    expect(rejectionOf(() => timeline.end({ turnId: MISSING_TURN, source: nativeSource('codex', 'evt-1'), terminalReason: 'completed', at: 1 }))).toEqual({ code: 'invalid_request', field: 'timeline_turn_unknown' });
    expect(rejectionOf(() => timeline.command({ turnId: MISSING_TURN, commandId: 'cmd-1', phase: 'accepted', at: 1 }))).toEqual({ code: 'invalid_request', field: 'timeline_turn_unknown' });
    expect(rejectionOf(() => timeline.turn(MISSING_TURN))).toEqual({ code: 'invalid_request', field: 'timeline_turn_unknown' });
    expect(rejectionOf(() => timeline.history(MISSING_TURN))).toEqual({ code: 'invalid_request', field: 'timeline_turn_unknown' });
    expect(rejectionOf(() => timeline.gaps(MISSING_TURN))).toEqual({ code: 'invalid_request', field: 'timeline_turn_unknown' });
  });

  it('rejects an oversized message payload with an explicit code and field and keeps the turn usable', () => {
    const timeline = createTurnTimeline();
    const turn = open(timeline);

    expect(rejectionOf(() => timeline.event({
      turnId: turn.turnId,
      source: nativeSource('codex', 'evt-big'),
      kind: 'message',
      at: 1,
      payload: { text: 'x'.repeat(MAX_TIMELINE_ENTRY_CHARS + 1) },
    }))).toEqual({ code: 'invalid_request', field: 'timeline_payload_too_large' });

    const ok = timeline.event({
      turnId: turn.turnId,
      source: nativeSource('codex', 'evt-small'),
      kind: 'message',
      at: 2,
      payload: { text: 'ok' },
    });
    expect(ok.duplicate).toBe(false);
    expect(timeline.page({ limit: 10 }).total).toBe(1);
  });

  it('flags a late event and never lets a cancelled turn fake a later completion', () => {
    const timeline = createTurnTimeline();
    const turn = open(timeline);

    timeline.command({ turnId: turn.turnId, commandId: 'cmd-1', phase: 'accepted', at: 1 });
    timeline.command({ turnId: turn.turnId, commandId: 'cmd-1', phase: 'sent', at: 2, payload: { text: 'go' } });
    const cancelled = timeline.end({ turnId: turn.turnId, source: nativeSource('codex', 'evt-cancel'), terminalReason: 'cancelled', at: 10 });
    expect(cancelled.applied).toBe(true);
    expect(cancelled.turn.terminalAt).toBe(10);

    const lateCompletion = timeline.end({ turnId: turn.turnId, source: nativeSource('codex', 'evt-late-done'), terminalReason: 'completed', at: 20 });
    expect(lateCompletion.applied).toBe(false);
    expect(lateCompletion.superseded).toBe(true);
    const view = timeline.turn(turn.turnId);
    expect(view.terminal).toBe(true);
    expect(view.terminalReason).toBe('cancelled');
    expect(view.terminalAt).toBe(10);

    const lateEntry = timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'evt-late-msg'), kind: 'message', at: 30, payload: { text: 'arrived after the end' } });
    expect(lateEntry.entry.late).toBe(true);
    expect(timeline.state.late).toBe(1);
    expect(timeline.history(turn.turnId).entryCount).toBe(2);
  });

  it('keeps the first terminal when a duplicate terminal arrives and dedupes an identical repeat', () => {
    const timeline = createTurnTimeline();
    const turn = open(timeline);

    const first = timeline.end({ turnId: turn.turnId, source: nativeSource('codex', 'evt-end-1'), terminalReason: 'completed', at: 10 });
    const second = timeline.end({ turnId: turn.turnId, source: nativeSource('codex', 'evt-end-2'), terminalReason: 'failed', at: 11 });
    const repeat = timeline.end({ turnId: turn.turnId, source: nativeSource('codex', 'evt-end-1'), terminalReason: 'completed', at: 12 });

    expect(first.applied).toBe(true);
    expect(second.applied).toBe(false);
    expect(second.superseded).toBe(true);
    expect(repeat.duplicate).toBe(true);
    expect(repeat.applied).toBe(false);
    const view = timeline.turn(turn.turnId);
    expect(view.terminalReason).toBe('completed');
    expect(view.terminalAt).toBe(10);
    expect(timeline.state.superseded).toBe(1);
  });

  it('detects sequence gaps with real numbers', () => {
    const timeline = createTurnTimeline();
    const turn = open(timeline);

    timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'evt-1'), kind: 'message', at: 1, seq: 1, payload: { text: 'one' } });
    timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'evt-2'), kind: 'message', at: 2, seq: 2, payload: { text: 'two' } });
    expect(timeline.gaps(turn.turnId)).toEqual([]);

    timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'evt-4'), kind: 'message', at: 4, seq: 4, payload: { text: 'four' } });
    expect(timeline.gaps(turn.turnId)).toEqual([3]);

    timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'evt-6'), kind: 'message', at: 6, seq: 6, payload: { text: 'six' } });
    expect(timeline.gaps(turn.turnId)).toEqual([3, 5]);

    timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'evt-7'), kind: 'message', at: 7, payload: { text: 'auto' } });
    expect(timeline.gaps(turn.turnId)).toEqual([3, 5]);
  });

  it('rejects malformed entries, sources, payloads and terminal reasons with explicit codes and fields', () => {
    const timeline = createTurnTimeline();
    const turn = open(timeline);

    expect(rejectionOf(() => timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'evt-1'), kind: 'secret' as 'message', at: 1, payload: {} }))).toEqual({ code: 'invalid_request', field: 'timeline_entry_kind' });
    expect(rejectionOf(() => timeline.event({ turnId: turn.turnId, source: { kind: 'native', harness: 'codex' } as unknown as TimelineSource, at: 1, payload: {}, kind: 'message' }))).toEqual({ code: 'invalid_request', field: 'timeline_source' });
    expect(rejectionOf(() => timeline.event({ turnId: turn.turnId, source: { kind: 'sideways' } as unknown as TimelineSource, at: 1, payload: {}, kind: 'message' }))).toEqual({ code: 'invalid_request', field: 'timeline_source' });
    expect(rejectionOf(() => timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'evt-1'), kind: 'message', at: 1, payload: 'plain text' as unknown as Record<string, unknown> }))).toEqual({ code: 'invalid_request', field: 'timeline_payload' });
    expect(rejectionOf(() => timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'evt-1'), kind: 'message', at: 1, seq: -1, payload: {} }))).toEqual({ code: 'invalid_request', field: 'timeline_seq' });
    expect(rejectionOf(() => timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'evt-1'), kind: 'message', at: Number.NaN, payload: {} }))).toEqual({ code: 'invalid_request', field: 'timeline_time' });
    expect(rejectionOf(() => timeline.end({ turnId: turn.turnId, source: nativeSource('codex', 'evt-1'), terminalReason: 'vibes' as 'completed', at: 1 }))).toEqual({ code: 'invalid_request', field: 'turn_terminal_reason' });
    expect(rejectionOf(() => timeline.end({ turnId: turn.turnId, source: hostSource('cmd-1'), terminalReason: 'completed', at: 1 }))).toEqual({ code: 'invalid_request', field: 'turn_end_source' });
    expect(rejectionOf(() => timeline.command({ turnId: turn.turnId, commandId: 'cmd-1', phase: 'weird' as 'accepted', at: 1 }))).toEqual({ code: 'invalid_request', field: 'turn_command_phase' });
    expect(rejectionOf(() => timeline.command({ turnId: turn.turnId, commandId: '', phase: 'accepted', at: 1 }))).toEqual({ code: 'invalid_request', field: 'turn_command_id' });
    expect(timeline.page({ limit: 10 }).total).toBe(0);
    expect(timeline.turn(turn.turnId).terminal).toBe(false);
  });

  it('rebuilds an identical timeline after a restart by replaying the same ordered events', () => {
    const first = createTurnTimeline();
    const turnId = '22222222-2222-4222-8222-222222222222';
    const original = first.open({ turnId, causedBy: 'cmd-1', attempt: 1, sourceNativeId: 'codex-turn-9' });
    first.command({ turnId, commandId: 'cmd-1', phase: 'accepted', at: 1 });
    first.command({ turnId, commandId: 'cmd-1', phase: 'sent', at: 2, payload: { text: 'rebuild me' } });
    first.event({ turnId, source: nativeSource('codex', 'evt-a'), kind: 'thinking', at: 3, seq: 1, payload: { text: 'plan' } });
    first.event({ turnId, source: nativeSource('codex', 'evt-b'), kind: 'tool', at: 4, seq: 2, payload: { tool: 'bash' } });
    first.end({ turnId, source: nativeSource('codex', 'evt-end'), terminalReason: 'completed', at: 5 });
    const before = first.turn(turnId);
    const beforePage = first.page({ turnId, limit: 10 });
    first.close();

    const second = createTurnTimeline();
    second.open({ turnId, causedBy: 'cmd-1', attempt: 1, sourceNativeId: 'codex-turn-9' });
    second.command({ turnId, commandId: 'cmd-1', phase: 'accepted', at: 1 });
    second.command({ turnId, commandId: 'cmd-1', phase: 'sent', at: 2, payload: { text: 'rebuild me' } });
    second.event({ turnId, source: nativeSource('codex', 'evt-a'), kind: 'thinking', at: 3, seq: 1, payload: { text: 'plan' } });
    second.event({ turnId, source: nativeSource('codex', 'evt-b'), kind: 'tool', at: 4, seq: 2, payload: { tool: 'bash' } });
    const replayedEnd = second.end({ turnId, source: nativeSource('codex', 'evt-end'), terminalReason: 'completed', at: 5 });

    const after = second.turn(turnId);
    expect(replayedEnd.turn.terminalReason).toBe('completed');
    expect(after.turnId).toBe(original.turnId);
    expect(after.causedBy).toBe(before.causedBy);
    expect(after.sourceNativeId).toBe(before.sourceNativeId);
    expect(after.attempt).toBe(before.attempt);
    expect(TURN_STATE_FLAGS.map((flag) => after[flag])).toEqual(TURN_STATE_FLAGS.map((flag) => before[flag]));
    expect(after.entryCount).toBe(before.entryCount);
    const afterPage = second.page({ turnId, limit: 10 });
    expect(afterPage.entries.map((entry) => [entry.kind, entry.at, entry.seq])).toEqual(beforePage.entries.map((entry) => [entry.kind, entry.at, entry.seq]));
    expect(afterPage.entries.map((entry) => entry.source)).toEqual(beforePage.entries.map((entry) => entry.source));
  });
});

describe('frozen read models and lifecycle', () => {
  it('returns frozen snapshots so a later mutation cannot be observed through an earlier view', () => {
    const timeline = createTurnTimeline();
    const turn = open(timeline);

    const turnBefore = timeline.turn(turn.turnId);
    const pageBefore = timeline.page({ limit: 1 });
    const historyBefore = timeline.history(turn.turnId);

    const accepted: TurnCommandOutcome = timeline.command({ turnId: turn.turnId, commandId: 'cmd-1', phase: 'accepted', at: 1 });
    const entry = timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'evt-1'), kind: 'message', at: 2, payload: { text: 'after' } });

    expect(turnBefore.accepted).toBe(false);
    expect(turnBefore.entryCount).toBe(0);
    expect(pageBefore.entries.length).toBe(0);
    expect(historyBefore.entryCount).toBe(0);
    expect(Object.isFrozen(turnBefore)).toBe(true);
    expect(Object.isFrozen(pageBefore)).toBe(true);
    expect(Object.isFrozen(historyBefore)).toBe(true);
    expect(Object.isFrozen(accepted.turn)).toBe(true);
    expect(Object.isFrozen(entry.entry)).toBe(true);
    expect(entry.entry.payload).toEqual({ text: 'after' });
  });

  it('exposes the fixed state, kind and terminal-reason tables', () => {
    expect(TURN_STATE_FLAGS).toEqual(['accepted', 'sent', 'observed', 'terminal']);
    expect(TIMELINE_ENTRY_KINDS).toEqual(['message', 'tool', 'thinking', 'interaction', 'usage']);
    expect(TIMELINE_TERMINAL_REASONS).toEqual(['completed', 'failed', 'cancelled', 'timeout', 'aborted']);
    expect(TURN_COMMAND_PHASES).toEqual(['accepted', 'sent', 'cancelled']);
    expect(Object.isFrozen(TURN_STATE_FLAGS)).toBe(true);
    expect(Object.isFrozen(TIMELINE_ENTRY_KINDS)).toBe(true);
  });

  it('refuses further work after close with an explicit code and field', () => {
    const timeline = createTurnTimeline();
    const turn = open(timeline);

    timeline.close();
    expect(timeline.state.closed).toBe(true);
    expect(rejectionOf(() => timeline.open({ causedBy: 'cmd-1' }))).toEqual({ code: 'cancelled', field: 'timeline_closed' });
    expect(rejectionOf(() => timeline.command({ turnId: turn.turnId, commandId: 'cmd-1', phase: 'accepted', at: 1 }))).toEqual({ code: 'cancelled', field: 'timeline_closed' });
    expect(rejectionOf(() => timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'evt-1'), kind: 'message', at: 1, payload: {} }))).toEqual({ code: 'cancelled', field: 'timeline_closed' });
    expect(rejectionOf(() => timeline.page({ limit: 10 }))).toEqual({ code: 'cancelled', field: 'timeline_closed' });
    expect(() => timeline.close()).not.toThrow();
  });

  it('reports real state counters across the whole timeline', () => {
    const timeline = createTurnTimeline();
    const first = open(timeline, { causedBy: 'cmd-1' });
    const second = open(timeline, { causedBy: first.turnId, parentTurn: first.turnId, attempt: 2 });

    timeline.command({ turnId: first.turnId, commandId: 'cmd-1', phase: 'accepted', at: 1 });
    timeline.command({ turnId: first.turnId, commandId: 'cmd-1', phase: 'sent', at: 2, payload: { text: 'one' } });
    timeline.event({ turnId: first.turnId, source: nativeSource('codex', 'evt-1'), kind: 'message', at: 3, payload: { text: 'native' } });
    timeline.event({ turnId: first.turnId, source: nativeSource('codex', 'evt-1'), kind: 'message', at: 4, payload: { text: 'native' } });
    timeline.event({ turnId: second.turnId, source: nativeSource('dsh', 'evt-1'), kind: 'message', at: 5, payload: { text: 'other turn' } });
    const outcome: TurnOutcome = timeline.end({ turnId: first.turnId, source: nativeSource('codex', 'evt-end'), terminalReason: 'failed', at: 6 });

    expect(outcome.applied).toBe(true);
    expect(timeline.state).toEqual({ turns: 2, entries: 3, duplicates: 1, superseded: 0, late: 0, closed: false });
  });
});

describe('sequence integrity across unsafe, distant and cross-source seqs', () => {
  it('rejects an unsafe integer seq so gaps() can never be asked to enumerate it', () => {
    const timeline = createTurnTimeline();
    const turn = open(timeline);

    expect(rejectionOf(() => timeline.event({
      turnId: turn.turnId,
      source: nativeSource('codex', 'evt-1'),
      kind: 'message',
      at: 1,
      seq: 2 ** 53,
      payload: {},
    }))).toEqual({ code: 'invalid_request', field: 'timeline_seq' });
    expect(rejectionOf(() => timeline.event({
      turnId: turn.turnId,
      source: nativeSource('codex', 'evt-2'),
      kind: 'message',
      at: 2,
      seq: Number.MAX_SAFE_INTEGER + 2,
      payload: {},
    }))).toEqual({ code: 'invalid_request', field: 'timeline_seq' });
    expect(rejectionOf(() => timeline.event({
      turnId: turn.turnId,
      source: nativeSource('codex', 'evt-3'),
      kind: 'message',
      at: 3,
      seq: Number.MAX_SAFE_INTEGER,
      payload: {},
    }))).toBeUndefined();
    expect(timeline.turn(turn.turnId).entryCount).toBe(1);
  });

  it('refuses a span gaps() cannot enumerate instead of walking it', () => {
    const timeline = createTurnTimeline();
    const turn = open(timeline);

    timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'evt-1'), kind: 'message', at: 1, seq: 1, payload: {} });
    timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'evt-2'), kind: 'message', at: 2, seq: MAX_TIMELINE_SEQ_SPAN + 2, payload: {} });

    expect(rejectionOf(() => timeline.gaps(turn.turnId))).toEqual({ code: 'invalid_request', field: 'timeline_seq_span' });
    expect(timeline.turn(turn.turnId).seqMax).toBe(MAX_TIMELINE_SEQ_SPAN + 2);
    expect(timeline.turn(turn.turnId).entryCount).toBe(2);
  });

  it('still enumerates a span that sits exactly on the ceiling', () => {
    const timeline = createTurnTimeline();
    const turn = open(timeline);

    timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'evt-1'), kind: 'message', at: 1, seq: 1, payload: {} });
    timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'evt-2'), kind: 'message', at: 2, seq: MAX_TIMELINE_SEQ_SPAN + 1, payload: {} });

    expect(timeline.gaps(turn.turnId).length).toBe(MAX_TIMELINE_SEQ_SPAN - 1);
  });

  it('keeps each native source sequence independent so one source never closes another source gap', () => {
    const timeline = createTurnTimeline();
    const turn = open(timeline);

    timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'c-1'), kind: 'message', at: 1, seq: 1, payload: {} });
    timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'c-2'), kind: 'message', at: 2, seq: 3, payload: {} });
    expect(timeline.gaps(turn.turnId)).toEqual([2]);

    timeline.event({ turnId: turn.turnId, source: nativeSource('dsh', 'd-1'), kind: 'message', at: 3, seq: 2, payload: {} });
    expect(timeline.gaps(turn.turnId)).toEqual([2]);

    timeline.event({ turnId: turn.turnId, source: nativeSource('dsh', 'd-2'), kind: 'message', at: 4, seq: 1, payload: {} });
    expect(timeline.gaps(turn.turnId)).toEqual([2]);

    timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'c-3'), kind: 'message', at: 5, seq: 2, payload: {} });
    expect(timeline.gaps(turn.turnId)).toEqual([]);
  });

  it('assigns an auto seq per source instead of continuing the global maximum', () => {
    const timeline = createTurnTimeline();
    const turn = open(timeline);

    timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'c-1'), kind: 'message', at: 1, seq: 1, payload: {} });
    timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'c-2'), kind: 'message', at: 2, seq: 5, payload: {} });
    timeline.event({ turnId: turn.turnId, source: nativeSource('dsh', 'd-1'), kind: 'message', at: 3, payload: {} });

    const seqs = timeline.page({ limit: 10 }).entries.map((entry) => entry.seq);
    expect(seqs).toEqual([1, 5, 1]);
    expect(timeline.turn(turn.turnId).seqMax).toBe(5);
    expect(timeline.gaps(turn.turnId)).toEqual([2, 3, 4]);
  });

  it('never marks a Host-source event as natively observed', () => {
    const timeline = createTurnTimeline();
    const turn = open(timeline);

    const outcome = timeline.event({ turnId: turn.turnId, source: hostSource('cmd-1'), kind: 'message', at: 1, payload: { text: 'host' } });
    expect(outcome.duplicate).toBe(false);
    const afterHost = timeline.turn(turn.turnId);
    expect(afterHost.observed).toBe(false);
    expect(afterHost.observedAt).toBeNull();
    expect(afterHost.observedBy).toBeNull();

    timeline.event({ turnId: turn.turnId, source: nativeSource('codex', 'c-1'), kind: 'message', at: 2, payload: {} });
    const afterNative = timeline.turn(turn.turnId);
    expect(afterNative.observed).toBe(true);
    expect(afterNative.observedAt).toBe(2);
    expect(afterNative.observedBy).toBe('native|codex');
  });

  it('agrees with the bridge turn service on every one of these rules', () => {
    const bridge = createTurnService();
    const app = createTurnTimeline();
    const bridgeTurn = bridge.open({ turnId: TURN_A, causedBy: 'cmd-1' });
    const appTurn = open(app, { turnId: TURN_B, causedBy: 'cmd-1' });

    type LaneEvent = {
      readonly source: TimelineSource;
      readonly kind: TimelineEntryKind;
      readonly at?: number;
      readonly seq?: number;
      readonly payload: Record<string, unknown>;
    };
    const bridgeEvent = (input: LaneEvent) => bridge.event({ turnId: bridgeTurn.turnId, ...input });
    const appEvent = (input: LaneEvent) => app.event({ turnId: appTurn.turnId, ...input });

    const unsafe = { source: nativeSource('codex', 'u-1'), kind: 'message' as const, at: 1, seq: 2 ** 53, payload: {} };
    expect(laneRejectionOf(() => bridgeEvent(unsafe))).toEqual({ code: 'invalid_request', field: 'timeline_seq' });
    expect(laneRejectionOf(() => appEvent(unsafe))).toEqual({ code: 'invalid_request', field: 'timeline_seq' });
    expect(laneRejectionOf(() => bridgeEvent({ ...unsafe, seq: Number.MAX_SAFE_INTEGER + 2 })))
      .toEqual({ code: 'invalid_request', field: 'timeline_seq' });

    bridgeEvent({ source: nativeSource('codex', 'c-1'), kind: 'message', at: 1, seq: 1, payload: {} });
    appEvent({ source: nativeSource('codex', 'c-1'), kind: 'message', at: 1, seq: 1, payload: {} });
    bridgeEvent({ source: nativeSource('codex', 'c-2'), kind: 'message', at: 2, seq: 3, payload: {} });
    appEvent({ source: nativeSource('codex', 'c-2'), kind: 'message', at: 2, seq: 3, payload: {} });
    expect([...bridge.gaps(bridgeTurn.turnId)]).toEqual([2]);
    expect([...app.gaps(appTurn.turnId)]).toEqual([2]);

    bridgeEvent({ source: nativeSource('dsh', 'd-1'), kind: 'message', at: 3, seq: 2, payload: {} });
    appEvent({ source: nativeSource('dsh', 'd-1'), kind: 'message', at: 3, seq: 2, payload: {} });
    expect([...bridge.gaps(bridgeTurn.turnId)]).toEqual([2]);
    expect([...app.gaps(appTurn.turnId)]).toEqual([2]);

    bridgeEvent({ source: hostSource('cmd-host'), kind: 'message', at: 4, payload: {} });
    appEvent({ source: hostSource('cmd-host'), kind: 'message', at: 4, payload: {} });
    const bridgeView = bridge.turn(bridgeTurn.turnId);
    const appView = app.turn(appTurn.turnId);
    expect([bridgeView.observed, bridgeView.observedAt, bridgeView.observedBy])
      .toEqual([appView.observed, appView.observedAt, appView.observedBy]);
    expect(bridgeView.observedBy).toBe('native|codex');
    expect(bridgeView.observedAt).toBe(1);

    bridgeEvent({ source: nativeSource('codex', 'c-3'), kind: 'message', at: 5, payload: {} });
    appEvent({ source: nativeSource('codex', 'c-3'), kind: 'message', at: 5, payload: {} });
    expect(bridge.turn(bridgeTurn.turnId).observedBy).toBe('native|codex');
    expect(app.turn(appTurn.turnId).observedBy).toBe('native|codex');

    const distant = { source: nativeSource('codex', 'c-4'), kind: 'message' as const, at: 6, seq: MAX_TIMELINE_SEQ_SPAN + 2, payload: {} } satisfies LaneEvent;
    bridgeEvent(distant);
    appEvent(distant);
    expect(laneRejectionOf(() => bridge.gaps(bridgeTurn.turnId))).toEqual({ code: 'invalid_request', field: 'timeline_seq_span' });
    expect(laneRejectionOf(() => app.gaps(appTurn.turnId))).toEqual({ code: 'invalid_request', field: 'timeline_seq_span' });
  });
});

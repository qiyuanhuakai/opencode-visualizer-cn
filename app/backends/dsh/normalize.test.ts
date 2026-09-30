import { describe, expect, it } from 'vitest';

import { loadDshWireFixture } from './fixtures';
import { createDshNormalizer } from './normalize';
import type { DshNormalizeOp } from './ops';
import {
  isDshSessionSnapshot,
  type DshSessionAddress,
  type DshSessionRecord,
  type DshSessionWireEvent,
} from './types';

// ---------------------------------------------------------------------------
// Fixtures: captured verbatim from dsh web 0.2.0-rc.2 on 2026-09-29
// (.omo/evidence/dsh-adapt/04-session-follow-full.txt, one mux frame per line).
// RECORDED is the source of truth; the loader version-gates the sidecar.
// ---------------------------------------------------------------------------

const SESSION_FOLLOW_FIXTURE = 'wire-session-follow-snapshot.jsonl';
const SESSION_ID = 'session-06ee930d-7d74-42b1-928d-ac8fdd4376bf';
const MISSING_CREDENTIAL_MESSAGE =
  'llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY '
  + 'through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY '
  + 'in the launching environment';

const sessionFollow = loadDshWireFixture(SESSION_FOLLOW_FIXTURE);
const followFrame = sessionFollow.frames[0];
const snapshot = (() => {
  const value = followFrame.type === 'item' ? followFrame.value : followFrame;
  if (!isDshSessionSnapshot(value)) throw new Error('fixture frame is not a session/follow snapshot');
  return value;
})();

/** Every real record of the captured turn, in wire order. */
const fixtureRecords: readonly DshSessionRecord[] = snapshot.records;
const fixtureEvents: readonly DshSessionWireEvent[] = fixtureRecords.map((record) => record.event);
const eventBySeq = (seq: number): DshSessionWireEvent => {
  const found = fixtureEvents.find((event) => event.seq === seq);
  if (!found) throw new Error(`fixture has no record at seq ${seq}`);
  return found;
};

/** Ingest a list of records through one normalizer and flatten every op. */
function ingestRecords(records: readonly DshSessionRecord[], address?: DshSessionAddress) {
  const normalizer = createDshNormalizer({ address, now: () => 1790692597000 });
  const ops = [];
  for (const record of records) {
    ops.push(...normalizer.ingest(record).ops);
  }
  return { normalizer, ops, stats: normalizer.stats() };
}

/** Ingest the whole captured snapshot (authoritative full-state replay). */
function ingestSnapshot() {
  const normalizer = createDshNormalizer({ now: () => 1790692597000 });
  const result = normalizer.ingest(snapshot);
  return { normalizer, ops: result.ops, stats: normalizer.stats(), result };
}

const opsOfKind = <K extends DshNormalizeOp['kind']>(
  ops: readonly { kind: string }[],
  kind: K,
): Extract<DshNormalizeOp, { kind: K }>[] =>
  ops.filter((op): op is Extract<DshNormalizeOp, { kind: K }> => op.kind === kind);

// ---------------------------------------------------------------------------
// 1. Every real record normalizes without throwing, with the correct op shape
// ---------------------------------------------------------------------------

describe('dsh normalizer — real captured snapshot (04 fixture)', () => {
  it('normalizes every real record of the captured turn without throwing', () => {
    const { ops } = ingestSnapshot();
    // 18 records → a non-trivial op sequence; nothing may be dropped silently.
    expect(ops.length).toBeGreaterThan(15);
    // The snapshot itself must not throw for ANY record type it carries.
    for (const event of fixtureEvents) {
      expect(typeof event.type).toBe('string');
      expect(typeof event.seq).toBe('number');
    }
  });

  it('emits the session policy defaults recorded on the wire (0.2.0-rc.2)', () => {
    const { ops } = ingestSnapshot();
    const policy = opsOfKind(ops, 'policy');
    expect(policy).toEqual([
      { kind: 'policy', policy: 'permission-preset', value: 'workspace-write', time: 1790692532399 },
      { kind: 'policy', policy: 'sandbox-mode', value: 'workspace-write', time: 1790692532403 },
      { kind: 'policy', policy: 'approval-policy', value: 'ask', time: 1790692532404 },
    ]);
  });

  it('pushes the spliced inbox user message and extracts source.rpcId', () => {
    const { ops } = ingestSnapshot();
    const messages = opsOfKind(ops, 'message');
    const first = messages[0]?.message;
    expect(first?.role).toBe('user');
    expect(first?.id).toBe('ec747195-c21f-4de7-9df6-fcbf4ff4e75b');
    // rpcId is the only reliable answer binding (docs/dsh.md §9.3).
    const meta = metaOf(opsOfKind(ops, 'part')[0]?.part);
    expect(meta?.source).toBe('dsh-web');
    expect(meta?.rpcId).toBe('probe-r1');
  });

  it('marks the injected runtime-context / skill-catalog user messages distinctly', () => {
    const { ops } = ingestSnapshot();
    const userMessages = opsOfKind(ops, 'message').filter((op) => op.message.role === 'user');
    // seq 3 (inbox) + seq 9 (runtime context) + seq 10 (skills) — seq 8 is the
    // durable twin of seq 3 and must not duplicate it.
    expect(userMessages).toHaveLength(3);
    const userParts = opsOfKind(ops, 'part').filter((op) => metaOf(op.part)?.sourceKind !== undefined);
    const sourceKinds = userParts.map((op) => metaOf(op.part)?.sourceKind);
    expect(sourceKinds).toContain('runtime-context');
    expect(sourceKinds).toContain('skill-catalog');
    expect(sourceKinds).toContain('user');
  });

  it('maps turn/start, step/start and step/end with turn+step identity', () => {
    const { ops } = ingestSnapshot();
    expect(opsOfKind(ops, 'turn')).toEqual([
      {
        kind: 'turn', phase: 'started', sessionId: SESSION_ID, turn: 1, time: 1790692596458,
      },
      {
        kind: 'turn', phase: 'ended', sessionId: SESSION_ID, turn: 1, time: 1790692596628,
        reason: { kind: 'error', code: 'MISSING_CREDENTIAL', message: MISSING_CREDENTIAL_MESSAGE },
      },
    ]);
    expect(opsOfKind(ops, 'step')).toEqual([
      {
        kind: 'step', phase: 'started', sessionId: SESSION_ID, turn: 1, step: 1, time: 1790692596593,
      },
      {
        kind: 'step', phase: 'completed', sessionId: SESSION_ID, turn: 1, step: 1, time: 1790692596627,
      },
    ]);
  });

  it('carries system/message into the shared message shape', () => {
    const { ops } = ingestSnapshot();
    const system = opsOfKind(ops, 'system-message');
    expect(system).toHaveLength(1);
    expect(system[0].sessionId).toBe(SESSION_ID);
    expect(system[0].turn).toBe(1);
    expect(system[0].step).toBe(1);
    expect(system[0].text).toContain('You are an AI agent powered by DeepSeek Harness.');
  });

  it('maps session/title and treats session/title-llm-request as ignorable', () => {
    const { ops } = ingestSnapshot();
    expect(opsOfKind(ops, 'session-title')).toEqual([
      {
        kind: 'session-title', sessionId: SESSION_ID, title: 'say hi',
        messageSeqs: [8], sourceKind: 'fallback', time: 1790692596604,
      },
    ]);
    // The llm-request record is dsh's internal title-generation prompt and
    // carries no title: emitting an empty title op would blank the real one.
    expect(ingestSnapshot().stats.ignoredEventCount).toBe(1);
  });

  it('treats turn/end.reason as authoritative for the terminal error state', () => {
    const { ops } = ingestSnapshot();
    const assistant = opsOfKind(ops, 'message').filter((op) => op.message.role === 'assistant');
    expect(assistant.length).toBeGreaterThan(0);
    const last = assistant[assistant.length - 1]?.message as { error?: { name: string; data?: { code?: string } }; time: { completed?: number } };
    expect(last?.error?.name).toBe('DshTurnError');
    expect(last?.error?.data?.code).toBe('MISSING_CREDENTIAL');
    expect(last?.time.completed).toBe(1790692596628);
    expect(opsOfKind(ops, 'turn').at(-1)?.reason).toEqual({
      kind: 'error', code: 'MISSING_CREDENTIAL', message: MISSING_CREDENTIAL_MESSAGE,
    });
  });

  it('never crashes on request/header, request/context or session/title-llm-request payloads', () => {
    const { ops } = ingestSnapshot();
    const request = opsOfKind(ops, 'request');
    expect(opsOfKind(request, 'request').some((op) => op.phase === 'header')).toBe(true);
    expect(request.some((op) => op.phase === 'context')).toBe(true);
    expect(request.find((op) => op.phase === 'context')?.model).toBe('deepseek-flash');
  });

  it('reports the applied high-water mark equal to the snapshot cursor', () => {
    const { normalizer } = ingestSnapshot();
    expect(normalizer.cursor()).toBe(17);
  });
});

// ---------------------------------------------------------------------------
// 2. seq dedup + live-vs-full dedup (replay-boundary contract R1/R2)
// ---------------------------------------------------------------------------

describe('dsh normalizer — replay dedup', () => {
  it('re-applying the same snapshot produces zero ops', () => {
    const normalizer = createDshNormalizer({ now: () => 1790692597000 });
    const first = normalizer.ingest(snapshot).ops;
    const second = normalizer.ingest(snapshot);
    expect(first.length).toBeGreaterThan(0);
    expect(second.ops).toEqual([]);
    expect(second.duplicateCount).toBeGreaterThan(0);
    expect(normalizer.stats().duplicateRecordCount).toBe(fixtureRecords.length);
  });

  it('live records then the authoritative snapshot does not re-emit applied records', () => {
    const live = ingestRecords(fixtureRecords);
    const replayed = live.normalizer.ingest(snapshot).ops;
    expect(replayed).toEqual([]);
  });

  it('live records then a partial snapshot only emits the missing tail', () => {
    const normalizer = createDshNormalizer({ now: () => 1790692597000 });
    const head = fixtureRecords.slice(0, 10);
    for (const record of head) normalizer.ingest(record);
    const before = normalizer.stats().appliedRecordCount;
    const tail = normalizer.ingest(snapshot).ops;
    // seq 0..9 already applied; only seq 10..17 may emit.
    expect(normalizer.stats().appliedRecordCount - before).toBe(8);
    expect(tail.length).toBeGreaterThan(0);
  });

  it('a stale seq behind the cursor is ignored rather than replayed', () => {
    const normalizer = createDshNormalizer({ now: () => 1790692597000 });
    normalizer.ingest(snapshot);
    const stale = normalizer.ingest(eventBySeq(3));
    expect(stale.ops).toEqual([]);
    expect(stale.duplicateCount).toBe(1);
  });

  it('the durable user/message record does not duplicate the spliced inbox message', () => {
    const { ops } = ingestSnapshot();
    const splicedId = 'ec747195-c21f-4de7-9df6-fcbf4ff4e75b';
    const emitted = opsOfKind(ops, 'message').filter((op) => op.message.id === splicedId);
    expect(emitted).toHaveLength(1);
  });

  it('a live assistant delta stream followed by the durable full message does not double the text', () => {
    // L43 lesson: the durable "complete" fragment must replace the streamed
    // deltas, not append to them. Credential gate => fixture-driven test is
    // BLOCKED, so this is schema-driven from docs/dsh.md §8.3.
    const address: DshSessionAddress = { kind: 'session', sessionId: SESSION_ID };
    const normalizer = createDshNormalizer({ address, now: () => 1790692597000 });
    normalizer.ingest(record('turn/start', 0, { turn: 1 }));
    normalizer.ingest({
      type: 'assistant-stream',
      frame: {
        type: 'start', attemptId: 'a1', revision: 1, startedAfterSeq: 0, turn: 1, step: 1,
      },
    });
    for (const [index, text] of ['Hel', 'lo ', 'world'].entries()) {
      normalizer.ingest({
        type: 'assistant-stream',
        frame: {
          type: 'chunk', attemptId: 'a1', revision: 1, index, time: 1,
          chunk: { type: 'text-delta', text },
        },
      });
    }
    normalizer.ingest(record('assistant/message', 9, {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
    }));
    const afterDurable = normalizer.ingest(record('turn/end', 10, {
      turn: 1, reason: { kind: 'completed' },
    })).ops;
    const texts = opsOfKind(afterDurable, 'part').filter((op) => op.part.type === 'text');
    expect(texts).toHaveLength(1);
    expect((texts[0].part as { text: string }).text).toBe('Hello world');
    // A late duplicate of the same durable record changes nothing.
    const again = normalizer.ingest(record('assistant/message', 9, {
      turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] },
    })).ops;
    expect(again).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Malformed / unknown input never crashes
// ---------------------------------------------------------------------------

describe('dsh normalizer — robustness', () => {
  it('ignores a known-but-unmapped event type without emitting ops', () => {
    const normalizer = createDshNormalizer({ now: () => 1790692597000 });
    const result = normalizer.ingest(record('todo/write', 100, { turn: 1, step: 1, todos: [] }));
    expect(result.ops).toEqual([]);
    expect(result.eventType).toBe('todo/write');
    expect(normalizer.stats().ignoredEventCount).toBe(1);
  });

  it('ignores a completely unknown event type without crashing', () => {
    const normalizer = createDshNormalizer({ now: () => 1790692597000 });
    const result = normalizer.ingest({ type: 'event', event: { type: 'nope/nope', seq: 1, time: 1, data: {} } });
    expect(result.ops).toEqual([]);
    expect(result.eventType).toBe('nope/nope');
    expect(normalizer.stats().unknownEventCount).toBe(1);
  });

  it.each([
    ['null', null],
    ['a number', 42],
    ['a string', 'not json'],
    ['an array', [1, 2, 3]],
    ['an empty object', {}],
    ['a record with no event', { type: 'event' }],
    ['a record whose event is not an object', { type: 'event', event: 'x' }],
    ['a record with a non-record data', { type: 'event', event: { type: 'turn/start', seq: 1, time: 1, data: 'x' } }],
    ['a mux frame with no value', { type: 'item', streamId: 'sf1' }],
  ])('safely ignores malformed input: %s', (_label, raw) => {
    const normalizer = createDshNormalizer({ now: () => 1790692597000 });
    expect(() => normalizer.ingest(raw)).not.toThrow();
    expect(normalizer.ingest(raw).ops).toEqual([]);
  });

  it('accepts a JSON string record (wire transport)', () => {
    const normalizer = createDshNormalizer({ now: () => 1790692597000 });
    const result = normalizer.ingest(JSON.stringify(record('permission/preset', 0, { preset: 'ask' })));
    expect(result.ops).toEqual([
      { kind: 'policy', policy: 'permission-preset', value: 'ask', time: 1790692597000 },
    ]);
  });

  it('ignores non-event session/follow frame types (end/cancel/error)', () => {
    const normalizer = createDshNormalizer({ now: () => 1790692597000 });
    expect(normalizer.ingest({ type: 'end', streamId: 'sf1' }).ops).toEqual([]);
    expect(normalizer.ingest({ type: 'cancel', streamId: 'sf1' }).ops).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Subagent child sessions (Metis #10)
// ---------------------------------------------------------------------------

describe('dsh normalizer — subagent child session', () => {
  const parentSessionId = SESSION_ID;
  const childSessionId = 'session-child-9f1c-4d2b-8a7e-11c3d5e7f901';
  const subagentAddress: DshSessionAddress = {
    kind: 'subagent', parentSessionId, childSessionId, mode: 'one-shot',
  };

  function subagentRecords(): DshSessionRecord[] {
    return [
      record('turn/start', 0, { turn: 1 }),
      record('assistant/message', 1, {
        turn: 1, step: 1,
        message: { role: 'assistant', content: [{ type: 'reasoning', text: 'planning the edit' }] },
      }),
      record('tool/call', 2, { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: { path: 'a.ts' } }),
      record('tool/result', 3, {
        turn: 1, step: 1,
        message: { content: [{ type: 'text', text: 'file body' }] },
      }),
      record('turn/end', 4, { turn: 1, reason: { kind: 'aborted' } }),
    ];
  }

  it('maps a subagent page payload into subagent-scoped parts', () => {
    const normalizer = createDshNormalizer({ address: subagentAddress, now: () => 1790692597000 });
    const result = normalizer.ingest({ records: subagentRecords(), hasMore: false });
    const parts = opsOfKind(result.ops, 'part');
    expect(parts.length).toBeGreaterThan(0);
    for (const op of parts) {
      expect(metaOf(op.part)?.source).toBe('dsh-web');
      expect(metaOf(op.part)?.subagent).toEqual({
        parentSessionId, childSessionId, mode: 'one-shot',
      });
      expect(op.part.messageID).toContain(childSessionId);
    }
  });

  it('keeps the subagent history card thinking / tool / result content', () => {
    const normalizer = createDshNormalizer({ address: subagentAddress, now: () => 1790692597000 });
    const { ops } = normalizer.ingest({ records: subagentRecords(), hasMore: false });
    const byType = new Map(opsOfKind(ops, 'part').map((op) => [op.part.type, op.part]));
    expect((byType.get('reasoning') as { text: string } | undefined)?.text).toBe('planning the edit');
    const tool = byType.get('tool') as { callID: string; state: { status: string; output?: string } } | undefined;
    expect(tool?.callID).toBe('call-1');
    expect(tool?.state.status).toBe('completed');
    expect(tool?.state.status === 'completed' ? tool.state.output : '').toBe('file body');
  });

  it('emits a terminal part when turn/end.reason is aborted', () => {
    const normalizer = createDshNormalizer({ address: subagentAddress, now: () => 1790692597000 });
    const { ops } = normalizer.ingest({ records: subagentRecords(), hasMore: false });
    const terminal = opsOfKind(ops, 'subagent');
    expect(terminal).toEqual([
      {
        kind: 'subagent', phase: 'terminal', parentSessionId, childSessionId, mode: 'one-shot',
        turn: 1, reason: { kind: 'aborted' }, time: 1790692597000,
      },
    ]);
    const lastText = opsOfKind(ops, 'part').filter((op) => op.part.type === 'text').at(-1);
    expect(metaOf(lastText?.part)?.terminal).toBe('aborted');
  });

  it('a completed subagent turn is not marked terminal-aborted', () => {
    const normalizer = createDshNormalizer({ address: subagentAddress, now: () => 1790692597000 });
    const records = subagentRecords().map((entry, index) =>
      index === 4
        ? record('turn/end', 4, { turn: 1, reason: { kind: 'completed' } })
        : entry);
    const { ops } = normalizer.ingest({ records, hasMore: false });
    expect(opsOfKind(ops, 'subagent')[0]?.phase).toBe('completed');
    const text = opsOfKind(ops, 'part').filter((op) => op.part.type === 'text').at(-1);
    expect(metaOf(text?.part)?.terminal).toBeUndefined();
  });

  it('rejects a malformed subagent address without crashing', () => {
    const normalizer = createDshNormalizer({
      address: { kind: 'subagent' } as unknown as DshSessionAddress,
      now: () => 1790692597000,
    });
    expect(() => normalizer.ingest({ records: subagentRecords(), hasMore: false })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. Assistant streaming vocabulary (docs/dsh.md §8.3)
//    Credential gate note: the live success-stream fixture was NOT captured
//    (task-6 degraded capture, DEEPSEEK_API_KEY absent), so these are
//    schema-driven. Marked in evidence as fixture-BLOCKED.
// ---------------------------------------------------------------------------

describe('dsh normalizer — assistant stream vocabulary (schema-driven)', () => {
  const address: DshSessionAddress = { kind: 'session', sessionId: SESSION_ID };

  function streamNormalizer() {
    const normalizer = createDshNormalizer({ address, now: () => 1790692597000 });
    normalizer.ingest(record('turn/start', 0, { turn: 1 }));
    normalizer.ingest(record('step/start', 1, { turn: 1, step: 1 }));
    normalizer.ingest({
      type: 'assistant-stream',
      frame: { type: 'start', attemptId: 'a1', revision: 1, startedAfterSeq: 1, turn: 1, step: 1 },
    });
    return normalizer;
  }

  const chunk = (index: number, body: Record<string, unknown>) => ({
    type: 'assistant-stream',
    frame: { type: 'chunk', attemptId: 'a1', revision: 1, index, time: 100 + index, chunk: body },
  });

  it('accumulates text-delta chunks into one text part carrying the message identity', () => {
    const normalizer = streamNormalizer();
    normalizer.ingest(chunk(0, { type: 'text-delta', text: 'Hel' }));
    const second = normalizer.ingest(chunk(1, { type: 'text-delta', text: 'lo' }));
    const text = opsOfKind(second.ops, 'part').filter((op) => op.part.type === 'text');
    expect(text).toHaveLength(1);
    expect((text[0].part as { text: string }).text).toBe('Hello');
    expect(text[0].part.messageID).toContain(SESSION_ID);
    expect(text[0].delta).toBe('lo');
  });

  it('accumulates reasoning-delta chunks into a reasoning part', () => {
    const normalizer = streamNormalizer();
    normalizer.ingest(chunk(0, { type: 'reasoning-delta', text: 'thinking ' }));
    const final = normalizer.ingest(chunk(1, { type: 'reasoning-delta', text: 'hard' })).ops;
    const reasoning = opsOfKind(final, 'part').filter((op) => op.part.type === 'reasoning');
    expect(reasoning).toHaveLength(1);
    expect((reasoning[0].part as { text: string }).text).toBe('thinking hard');
  });

  it('drops a repeated chunk index instead of duplicating text (idempotent delta)', () => {
    const normalizer = streamNormalizer();
    normalizer.ingest(chunk(0, { type: 'text-delta', text: 'Hi' }));
    const duplicate = normalizer.ingest(chunk(0, { type: 'text-delta', text: 'Hi' }));
    expect(duplicate.ops).toEqual([]);
    expect(normalizer.stats().duplicateDeltaCount).toBe(1);
  });

  it('maps a tool chunk to a tool part bound to the holding message', () => {
    const normalizer = streamNormalizer();
    const { ops } = normalizer.ingest(chunk(0, {
      type: 'tool-call', callId: 'call-9', name: 'grep', arguments: { pattern: 'x' },
    }));
    const tool = opsOfKind(ops, 'part').filter((op) => op.part.type === 'tool');
    expect(tool).toHaveLength(1);
    expect((tool[0].part as { callID: string }).callID).toBe('call-9');
    expect((tool[0].part as { state: { status: string } }).state.status).toBe('pending');
    expect(tool[0].part.messageID).toContain(SESSION_ID);
  });

  it('seals the attempt on a finish chunk with an error reason', () => {
    const normalizer = streamNormalizer();
    normalizer.ingest(chunk(0, { type: 'text-delta', text: 'partial' }));
    const finish = normalizer.ingest(chunk(1, {
      type: 'finish', reason: { kind: 'error', failure: { message: 'boom', code: 'E' } },
    })).ops;
    const message = opsOfKind(finish, 'message').at(-1);
    expect(message?.message.role).toBe('assistant');
    expect((message?.message as { error?: { data?: { code?: string } } })?.error?.data?.code).toBe('E');
    // After sealing, a fresh delta is stale and must not re-open the attempt.
    expect(normalizer.ingest(chunk(2, { type: 'text-delta', text: 'late' })).ops).toEqual([]);
  });

  it('ignores an abandoned assistant-stream end frame', () => {
    const normalizer = streamNormalizer();
    const { ops } = normalizer.ingest({
      type: 'assistant-stream',
      frame: { type: 'end', attemptId: 'a1', revision: 1, index: 0, outcome: { kind: 'abandoned' } },
    });
    expect(ops).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. Shared contract untouched (memory #801)
// ---------------------------------------------------------------------------

describe('dsh normalizer — shared contract shape', () => {
  it('emits parts whose identity fields are the shared MessagePart keys', () => {
    const { ops } = ingestSnapshot();
    for (const op of opsOfKind(ops, 'part')) {
      expect(Object.keys(op.part)).toEqual(expect.arrayContaining(['id', 'sessionID', 'messageID', 'type']));
    }
    const messages = opsOfKind(ops, 'message');
    for (const op of messages) {
      expect(typeof op.message.sessionID).toBe('string');
      expect(typeof op.message.id).toBe('string');
      expect(['user', 'assistant']).toContain(op.message.role);
    }
  });

  it('derives the session id from the snapshot header, not from record payloads', () => {
    const { normalizer } = ingestSnapshot();
    expect(normalizer.sessionId()).toBe(SESSION_ID);
  });

  it('carries the wire agentPreset as the shared message agent, not the backend name', () => {
    // dsh's real agent identity is the session's agentPreset (snapshot header);
    // writing the backend name into `agent` would mislabel every card.
    const { ops } = ingestSnapshot();
    for (const op of opsOfKind(ops, 'message')) {
      expect(op.message.agent).toBe('standard');
    }
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function record(type: string, seq: number, data: Record<string, unknown>): DshSessionRecord {
  return {
    type: 'event',
    event: { type, seq, time: 1790692597000, data },
  } as unknown as DshSessionRecord;
}

type AnyPart = {
  metadata?: Record<string, unknown>;
  text?: string;
  callID?: string;
  state?: { status: string; output?: string };
};

function metaOf(part: unknown): Record<string, unknown> | undefined {
  return (part as AnyPart | undefined)?.metadata;
}

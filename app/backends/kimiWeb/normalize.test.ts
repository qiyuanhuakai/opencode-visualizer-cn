import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AssistantMessageInfo, MessagePart, ReasoningPart, TextPart, ToolPart } from '../../types/sse';
import {
  KIMI_WEB_IGNORED_EVENTS,
  KIMI_WEB_SUPPORTED_EVENTS,
  createKimiWebNormalizer,
  kimiWebSubagentSessionId,
  resolveKimiWebToolName,
  type KimiWebNormalizeOp,
  type KimiWebNormalizeResult,
  type KimiWebWireFrame,
} from './normalize';

// ---------------------------------------------------------------------------
// Fixtures: captured verbatim from kimi web 0.43.0 (wire-session-live.jsonl,
// wire-control-live.jsonl, rest-*) or derived from the live /asyncapi.json
// schemas + the running binary's own wire builders (wire-spec-derived.jsonl,
// each line carries `_provenance`).
// ---------------------------------------------------------------------------

const SESSION_ID = 'session_e0158012-f869-4d98-b4d4-5921a8686e24';
const SUBAGENT_SESSION_ID = `${SESSION_ID}:agent-0:0`;
const TOOL_READ = 'tool_LLLyHODIa03gVnx5RCNr8z20';
const TURN_ENDED_TIME = 1789960882115;

// import.meta.url is http-served under Vitest; resolve fixtures from the working directory.
const FIXTURES_DIR = [
  join(process.cwd(), 'app', 'backends', 'kimiWeb', 'fixtures'),
  join(process.cwd(), 'backends', 'kimiWeb', 'fixtures'),
].find((directory) => existsSync(directory)) ?? join(process.cwd(), 'app', 'backends', 'kimiWeb', 'fixtures');

function fixture(name: string) {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8');
}

function fixtureJson(name: string) {
  return JSON.parse(fixture(name)) as Record<string, unknown>;
}

function fixtureJsonl(name: string) {
  return fixture(name)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as KimiWebWireFrame);
}

const liveFrames = fixtureJsonl('wire-session-live.jsonl');
const controlFrames = fixtureJsonl('wire-control-live.jsonl');
const derivedFrames = fixtureJsonl('wire-spec-derived.jsonl');
const allFrames = [...liveFrames, ...controlFrames, ...derivedFrames];

const framesOfType = (type: string) => allFrames.filter((frame) => frame.type === type);
const liveOfType = (type: string) => liveFrames.filter((frame) => frame.type === type);
const derivedOfType = (type: string) => derivedFrames.filter((frame) => frame.type === type);

function ingest(frames: readonly KimiWebWireFrame[]) {
  const normalizer = createKimiWebNormalizer();
  const results = frames.map((frame) => normalizer.ingest(frame));
  return { normalizer, results, ops: results.flatMap((result) => result.ops) };
}

function opsOfKind<K extends KimiWebNormalizeOp['kind']>(ops: readonly KimiWebNormalizeOp[], kind: K) {
  return ops.filter((op): op is Extract<KimiWebNormalizeOp, { kind: K }> => op.kind === kind);
}

function lastPart<T extends MessagePart['type']>(ops: readonly KimiWebNormalizeOp[], type: T) {
  return opsOfKind(ops, 'part')
    .filter((op) => op.part.type === type)
    .at(-1)?.part as Extract<MessagePart, { type: T }> | undefined;
}

const payloadOf = (frame: KimiWebWireFrame) => (frame.payload ?? {}) as Record<string, unknown>;

describe('kimiWeb/normalize', () => {
  it('covers every supported event type with a real wire fixture frame', () => {
    const covered = new Set(allFrames.map((frame) => frame.type));
    for (const type of KIMI_WEB_SUPPORTED_EVENTS) {
      expect(covered.has(type), `no fixture frame for supported event ${type}`).toBe(true);
    }
    expect(KIMI_WEB_IGNORED_EVENTS.has('ack')).toBe(true);
    expect(liveFrames.length).toBeGreaterThan(100);
    for (const frame of derivedFrames) {
      expect(typeof frame._provenance, `derived frame ${frame.type} lacks provenance`).toBe('string');
      expect(frame._provenance).not.toBe('');
    }
  });

  it('only uses payload fields the live server spec declares (derived frames)', () => {
    const schemas = fixtureJson('event-schemas.json') as Record<
      string,
      { properties?: Record<string, unknown> }
    >;
    // The server injects envelope context into every payload; live frames prove these keys.
    const injected = new Set(['type', 'agentId', 'sessionId', 'time']);
    for (const frame of derivedFrames) {
      const schema = schemas[frame.type];
      if (!schema?.properties) continue;
      for (const key of Object.keys(payloadOf(frame))) {
        const declared = key in schema.properties || injected.has(key);
        expect(declared, `${frame.type}.${key} is not in the live asyncapi schema`).toBe(true);
      }
    }
    expect(Object.keys(schemas)).toHaveLength(59);
    // interaction events are not modeled in asyncapi; assert the producer fields instead.
    const approval = derivedOfType('event.approval.requested')[0];
    expect(payloadOf(approval)).toMatchObject({
      approval_id: expect.any(String),
      session_id: SESSION_ID,
      tool_name: 'Read',
      created_at: expect.any(String),
      expires_at: expect.any(String),
    });
    const question = derivedOfType('event.question.requested')[0];
    expect(payloadOf(question).questions).toEqual([
      expect.objectContaining({ id: 'q_0', options: expect.any(Array) }),
    ]);
  });

  it('maps a completed turn into assistant message, text/reasoning parts and a completed turn op', () => {
    const { ops } = ingest(liveFrames.filter((frame) => typeof frame.seq === 'number' && frame.seq <= 14));
    const messages = opsOfKind(ops, 'message');
    expect(messages.length).toBeGreaterThan(0);
    const message = messages.at(-1)!.message as AssistantMessageInfo;
    expect(message.role).toBe('assistant');
    expect(message.sessionID).toBe(SESSION_ID);
    expect(message.id).toBe(`${SESSION_ID}:main:0`);
    expect(message.time.created).toBeGreaterThan(0);
    expect(message.time.completed).toBe(TURN_ENDED_TIME);
    expect(message.error).toBeUndefined();

    const textPart = lastPart(ops, 'text')!;
    expect(textPart.sessionID).toBe(SESSION_ID);
    expect(textPart.messageID).toBe(`${SESSION_ID}:main:0`);
    expect(textPart.text).toBe('Hi! What can I help you with today?');
    expect(textPart.time?.end).toBe(TURN_ENDED_TIME);

    const reasoningPart = lastPart(ops, 'reasoning')!;
    expect(reasoningPart.text).toBe('Simple greeting. Respond briefly.');
    expect(reasoningPart.sessionID).toBe(SESSION_ID);

    const turns = opsOfKind(ops, 'turn');
    expect(turns.map((turn) => turn.phase)).toEqual(['started', 'ended']);
    expect(turns[1]).toMatchObject({ reason: 'completed', agentId: 'main', turnId: 0 });
    expect(turns[1].time).toBe(TURN_ENDED_TIME);
  });

  it('orders and dedupes volatile same-seq deltas by offset (out-of-order + duplicate input)', () => {
    const deltas = liveOfType('assistant.delta').filter((frame) => frame.seq === 25);
    expect(deltas.length).toBeGreaterThan(5);
    const expected = [...deltas]
      .sort((left, right) => (left.offset ?? 0) - (right.offset ?? 0))
      .map((frame) => String(payloadOf(frame).delta))
      .join('');
    const reversed = [...deltas].reverse();
    const { ops, normalizer } = ingest([...reversed, reversed[0]]);
    const textPart = lastPart(ops, 'text')!;
    expect(textPart.text).toBe(expected);
    expect(normalizer.stats().duplicateDeltaCount).toBe(1);
    expect(normalizer.stats().staleDeltaCount).toBe(0);
  });

  it('keeps text across a seq boundary for one turn and drops stale-seq deltas', () => {
    const turnStarted = liveFrames.find(
      (frame) => frame.type === 'turn.started' && payloadOf(frame).turnId === 2,
    )!;
    const first = liveOfType('assistant.delta').filter((frame) => frame.seq === 36);
    const second = liveOfType('assistant.delta').filter((frame) => frame.seq === 51);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    const chunksOf = (frames: KimiWebWireFrame[]) =>
      [...frames]
        .sort((left, right) => (left.offset ?? 0) - (right.offset ?? 0))
        .map((frame) => String(payloadOf(frame).delta))
        .join('');
    const expected = chunksOf(first) + chunksOf(second);
    const { ops, normalizer } = ingest([turnStarted, ...first, ...second, first[0]]);
    expect(normalizer.stats().staleDeltaCount).toBe(1);
    expect(normalizer.stats().duplicateDeltaCount).toBe(0);
    expect(lastPart(ops, 'text')!.text).toBe(expected);
  });

  it('appends offset-less subagent deltas in arrival order', () => {
    const agentDeltas = liveFrames.filter(
      (frame) =>
        (frame.type === 'assistant.delta' || frame.type === 'thinking.delta') &&
        payloadOf(frame).agentId === 'agent-0',
    );
    const { ops } = ingest(agentDeltas);
    const textPart = lastPart(ops, 'text')!;
    const reasoningPart = lastPart(ops, 'reasoning')!;
    expect(textPart.text).toBe('2');
    expect(reasoningPart.text).toBe('Simple arithmetic. Reply just the result.');
  });

  it('maps tool.call.started/progress/result into a stable ToolPart state machine', () => {
    const started = liveOfType('tool.call.started').find((frame) => payloadOf(frame).toolCallId === TOOL_READ)!;
    const result = liveOfType('tool.result').find((frame) => payloadOf(frame).toolCallId === TOOL_READ)!;
    const progress = derivedOfType('tool.progress');
    const { ops } = ingest([started, ...progress, result]);
    const parts = opsOfKind(ops, 'part')
      .map((op) => op.part)
      .filter((part): part is ToolPart => part.type === 'tool');
    expect(parts.map((part) => part.state.status)).toEqual(['pending', 'running', 'running', 'completed']);
    expect(new Set(parts.map((part) => part.id))).toEqual(new Set([`${SESSION_ID}:main:1:tool:${TOOL_READ}`]));
    expect(new Set(parts.map((part) => part.callID))).toEqual(new Set([TOOL_READ]));
    expect(parts.at(-1)!.tool).toBe('read');
    const finalState = parts.at(-1)!.state;
    expect(finalState.status).toBe('completed');
    if (finalState.status !== 'completed') throw new Error('expected completed state');
    expect(finalState.output).toBe('1\tok');
    expect(finalState.input.path).toBe('/tmp/opencode/kimi-probe/ws-workspace/note.txt');
  });

  it('maps a failed tool.result to the error state', () => {
    const started = liveOfType('tool.call.started').find((frame) => payloadOf(frame).toolCallId === TOOL_READ)!;
    const failedResult = derivedOfType('tool.result').find((frame) => payloadOf(frame).isError === true)!;
    const { ops } = ingest([started, failedResult]);
    const part = opsOfKind(ops, 'part')
      .map((op) => op.part)
      .filter((entry): entry is ToolPart => entry.type === 'tool')
      .at(-1)!;
    expect(part.state.status).toBe('error');
    if (part.state.status !== 'error') throw new Error('expected error state');
    expect(part.state.error).toContain('ENOENT');
    expect(part.callID).toBe(TOOL_READ);
  });

  it('maps agent.status.updated usage/contextTokens/planMode', () => {
    const { ops } = ingest(framesOfType('agent.status.updated'));
    const statuses = opsOfKind(ops, 'agent').filter((op) => op.phase === 'status');
    expect(statuses.length).toBeGreaterThan(10);
    const withUsage = statuses.find((op) => op.status?.usage?.total);
    expect(withUsage?.status?.usage?.total?.output).toBeGreaterThan(0);
    const withContext = statuses.find((op) => typeof op.status?.contextTokens === 'number');
    expect(withContext).toBeDefined();
    const planMode = statuses.find((op) => op.status?.planMode === true);
    expect(planMode).toMatchObject({ status: { planMode: true, permission: 'manual', contextTokens: 21109 } });
    const pending = statuses.find((op) => op.status?.phase?.kind === 'running');
    expect(pending?.status?.phase?.turnId).toBe(0);

    const lifecycle = ingest([
      liveFrames.find((frame) => frame.type === 'agent.created')!,
      ...controlFrames.filter((frame) => frame.type === 'agent.disposed'),
    ]);
    expect(opsOfKind(lifecycle.ops, 'agent').map((op) => op.phase)).toEqual(['created', 'disposed', 'disposed']);
  });

  it('produces an error completion for turn.ended reason failed and never treats prompt.completed as success', () => {
    const failed = derivedOfType('turn.ended').find((frame) => payloadOf(frame).reason === 'failed')!;
    const { ops } = ingest([failed]);
    const turn = opsOfKind(ops, 'turn')[0];
    expect(turn).toMatchObject({ phase: 'ended', reason: 'failed', interruptReason: 'error' });
    const message = opsOfKind(ops, 'message').at(-1)!.message as AssistantMessageInfo;
    expect(message.role).toBe('assistant');
    expect(message.error?.data?.code).toBe('model.not_configured');
    expect(opsOfKind(ops, 'turn').some((entry) => entry.reason === 'completed')).toBe(false);

    const promptCompleted = liveOfType('prompt.completed')[0];
    const solo = ingest([promptCompleted]);
    expect(opsOfKind(solo.ops, 'turn')).toHaveLength(0);
    expect(opsOfKind(solo.ops, 'message')).toHaveLength(0);
    expect(opsOfKind(solo.ops, 'prompt')[0].phase).toBe('completed');
  });

  it('synthesizes a stable subagent session identity and terminal parts with time.end', () => {
    const turnStarted = liveFrames.find(
      (frame) => frame.type === 'turn.started' && payloadOf(frame).agentId === 'agent-0',
    )!;
    const spawned = liveOfType('subagent.spawned')[0];
    const completed = liveOfType('subagent.completed')[0];
    const agentDeltas = liveFrames.filter(
      (frame) =>
        (frame.type === 'assistant.delta' || frame.type === 'thinking.delta') &&
        payloadOf(frame).agentId === 'agent-0',
    );
    const { ops } = ingest([turnStarted, spawned, ...agentDeltas, completed]);
    const subagents = opsOfKind(ops, 'subagent');
    expect(subagents[0]).toMatchObject({
      phase: 'spawned',
      subagentId: 'agent-0',
      subagentSessionId: SUBAGENT_SESSION_ID,
    });
    expect(subagents[0].subagentSessionId).not.toBe(SESSION_ID);
    expect(subagents.at(-1)?.phase).toBe('completed');
    expect(subagents.at(-1)?.subagentSessionId).toBe(SUBAGENT_SESSION_ID);

    const subagentParts = opsOfKind(ops, 'part')
      .map((op) => op.part)
      .filter((part) => part.sessionID !== SESSION_ID);
    expect(subagentParts.length).toBeGreaterThan(0);
    const terminal = subagentParts.filter((part): part is TextPart => part.type === 'text').at(-1)!;
    expect(terminal.text).toBe('2');
    expect(terminal.time?.end).toBe(payloadOf(completed).time);
    const reasoning = subagentParts.filter((part): part is ReasoningPart => part.type === 'reasoning').at(-1)!;
    expect(reasoning.text).toBe('Simple arithmetic. Reply just the result.');
    expect(kimiWebSubagentSessionId('session_x', 'agent-1', 2)).toBe('session_x:agent-1:2');
  });

  it('emits a terminal subagent part even when a failed subagent produced no deltas', () => {
    const failed = derivedOfType('subagent.failed')[0];
    const { ops } = ingest([failed]);
    expect(opsOfKind(ops, 'subagent')[0]).toMatchObject({ phase: 'failed', subagentSessionId: SUBAGENT_SESSION_ID });
    const terminal = opsOfKind(ops, 'part')
      .map((op) => op.part)
      .filter((part): part is TextPart => part.type === 'text')
      .at(-1)!;
    expect(terminal.sessionID).toBe(SUBAGENT_SESSION_ID);
    expect(terminal.time?.end).toBe(payloadOf(failed).time);

    const suspended = derivedOfType('subagent.suspended')[0];
    const suspendedRun = ingest([suspended]);
    expect(opsOfKind(suspendedRun.ops, 'subagent')[0]).toMatchObject({
      phase: 'suspended',
      subagentSessionId: SUBAGENT_SESSION_ID,
    });
    expect(opsOfKind(suspendedRun.ops, 'part')).toHaveLength(0);
  });

  it('maps approval and question events with stable ids', () => {
    const { ops } = ingest(framesOfType('event.approval.requested').concat(
      framesOfType('event.approval.resolved'),
      framesOfType('event.question.requested'),
      framesOfType('event.question.answered'),
      framesOfType('event.question.dismissed'),
    ));
    const interactions = opsOfKind(ops, 'interaction');
    expect(interactions).toHaveLength(5);
    expect(interactions[0]).toMatchObject({
      interaction: 'approval',
      phase: 'requested',
      id: 'approval_01M30ZPT0000000000000000',
      toolName: 'Read',
      toolCallId: TOOL_READ,
      turnId: 1,
    });
    expect(interactions[1]).toMatchObject({ interaction: 'approval', phase: 'resolved', decision: 'approved' });
    expect(interactions[2]).toMatchObject({ interaction: 'question', phase: 'requested' });
    expect(interactions[2].questions).toHaveLength(1);
    expect(interactions[3]).toMatchObject({ interaction: 'question', phase: 'answered' });
    expect(interactions[4]).toMatchObject({ interaction: 'question', phase: 'dismissed' });
    expect(new Set(interactions.slice(2).map((op) => op.id))).toEqual(
      new Set(['question_01M30ZPT1111111111111111']),
    );
  });

  it('maps session, prompt, compaction, error and warning events', () => {
    const { ops } = ingest([
      ...framesOfType('session.meta.updated'),
      ...framesOfType('event.session.created'),
      ...framesOfType('event.session.archived'),
      ...framesOfType('event.session.deleted'),
      ...framesOfType('event.session.work_changed'),
      ...framesOfType('event.session.status_changed'),
      ...framesOfType('prompt.submitted'),
      ...framesOfType('prompt.started'),
      ...framesOfType('prompt.aborted'),
      ...framesOfType('prompt.steered'),
      ...framesOfType('compaction.started'),
      ...framesOfType('compaction.completed'),
      ...framesOfType('compaction.blocked'),
      ...framesOfType('compaction.cancelled'),
      ...derivedOfType('error'),
      ...framesOfType('warning'),
      ...framesOfType('turn.step.started'),
      ...framesOfType('turn.step.completed'),
      ...framesOfType('turn.step.retrying'),
      ...framesOfType('turn.step.interrupted'),
    ]);
    const sessionOps = opsOfKind(ops, 'session');
    expect(sessionOps.some((op) => op.phase === 'meta' && op.patch)).toBe(true);
    expect(sessionOps.some((op) => op.phase === 'created' && op.session)).toBe(true);
    expect(sessionOps.some((op) => op.phase === 'archived' && op.workspaceId)).toBe(true);
    expect(sessionOps.some((op) => op.phase === 'deleted')).toBe(true);
    expect(sessionOps.some((op) => op.phase === 'work-changed' && op.pendingInteraction === 'approval')).toBe(true);
    expect(sessionOps.some((op) => op.phase === 'status-changed' && op.previousStatus === 'running')).toBe(true);

    const promptPhases = opsOfKind(ops, 'prompt').map((op) => op.phase);
    for (const phase of ['submitted', 'started', 'aborted', 'steered']) {
      expect(promptPhases).toContain(phase);
    }
    const compactionPhases = opsOfKind(ops, 'compaction').map((op) => op.phase);
    expect(compactionPhases).toEqual(expect.arrayContaining(['started', 'completed', 'blocked', 'cancelled']));
    const compactionCompleted = opsOfKind(ops, 'compaction').find((op) => op.phase === 'completed');
    expect(compactionCompleted?.result).toMatchObject({ compactedCount: 2, tokensAfter: 5000 });

    expect(opsOfKind(ops, 'error')[0]).toMatchObject({ code: 'model.not_configured', retryable: false });
    expect(opsOfKind(ops, 'warning')[0]).toMatchObject({ message: expect.stringContaining('Context') });
    const steps = opsOfKind(ops, 'step');
    expect(steps.some((op) => op.phase === 'retrying' && op.statusCode === 429)).toBe(true);
    expect(steps.some((op) => op.phase === 'interrupted' && op.reason === 'error')).toBe(true);
    expect(steps.some((op) => op.phase === 'started')).toBe(true);
    expect(steps.some((op) => op.phase === 'completed' && op.usage)).toBe(true);
  });

  it('treats context.spliced as a storage no-op and skips unknown events safely', () => {
    const normalizer = createKimiWebNormalizer();
    const spliced = normalizer.ingest(framesOfType('context.spliced')[0]);
    expect(spliced.ops).toHaveLength(0);
    const ignored = normalizer.ingest({ type: 'ack', id: 'x', code: 0, payload: {} });
    expect(ignored.ops).toHaveLength(0);
    const unknown = normalizer.ingest({ type: 'not.a.kimi.event', seq: 999, payload: { hello: true } });
    expect(unknown.ops).toHaveLength(0);
    const garbage = normalizer.ingest('{not-json');
    expect(garbage.ops).toHaveLength(0);
    const stats = normalizer.stats();
    expect(stats.frames).toBe(4);
    expect(stats.ignoredEventCount).toBe(2);
    expect(stats.unknownEventCount).toBe(2);
  });

  it('reports the raw event type and volatility for every frame', () => {
    const normalizer = createKimiWebNormalizer();
    const delta = liveOfType('assistant.delta')[0];
    const result: KimiWebNormalizeResult = normalizer.ingest(delta);
    expect(result.eventType).toBe('assistant.delta');
    expect(result.volatile).toBe(true);
    expect(result.sessionId).toBe(SESSION_ID);
    const durable = liveOfType('turn.ended')[0];
    expect(normalizer.ingest(durable).volatile).toBe(false);
  });

  it('maps kimi tool names to TOOL_WINDOW_SUPPORTED synonyms and preserves plugin prefixes', () => {
    expect(resolveKimiWebToolName('Read')).toBe('read');
    expect(resolveKimiWebToolName('Write')).toBe('write');
    expect(resolveKimiWebToolName('WebSearch')).toBe('websearch');
    expect(resolveKimiWebToolName('FetchURL')).toBe('webfetch');
    expect(resolveKimiWebToolName('ApplyPatch')).toBe('apply_patch');
    expect(resolveKimiWebToolName('Agent')).toBe('task');
    expect(resolveKimiWebToolName('AgentSwarm')).toBe('task');
    expect(resolveKimiWebToolName('AskUserQuestion')).toBe('question');
    expect(resolveKimiWebToolName('TodoList')).toBe('todowrite');
    expect(resolveKimiWebToolName('ctx_magic')).toBe('ctx_magic');
    expect(resolveKimiWebToolName('lsp_hover')).toBe('lsp_hover');
    expect(resolveKimiWebToolName('CustomThing')).toBe('CustomThing');
    expect(resolveKimiWebToolName('')).toBe('other');
  });
});

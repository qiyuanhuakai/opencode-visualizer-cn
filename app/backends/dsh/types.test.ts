import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  assertDshFixtureMeta,
  dshFixturePath,
  loadDshWireFixture,
} from './fixtures';
import {
  DSH_SESSION_EVENT_TYPES,
  DSH_WIRE_VERSION,
  DshWireParseError,
  isDshClientRequest,
  isDshEventsFrame,
  isDshMuxServerFrame,
  isDshProjectionBaseline,
  isDshSessionAddress,
  isDshSessionFollowFrame,
  isDshSessionPageRequest,
  isDshSessionPageResult,
  isDshSessionPromptRequest,
  isDshSessionSnapshot,
  isDshServerResponse,  isDshWorkspaceFollowFrame,
  parseDshWireLine,
  type DshSessionSnapshot,
  type DshSessionWireEvent,
} from './types';

// ---------------------------------------------------------------------------
// Fixtures: captured verbatim from dsh web 0.2.0-rc.2 on 2026-09-29
// (.omo/evidence/dsh-adapt/04-session-follow-full.txt, one mux frame per line).
// ---------------------------------------------------------------------------

const EVENTS_READY_FIXTURE = 'wire-events-ready.jsonl';
const WORKSPACE_BASELINE_FIXTURE = 'wire-workspace-baseline.jsonl';
const MUX_ERROR_FIXTURE = 'wire-mux-error.jsonl';
const SESSION_FOLLOW_FIXTURE = 'wire-session-follow-snapshot.jsonl';

const ALL_FIXTURES = [
  EVENTS_READY_FIXTURE,
  WORKSPACE_BASELINE_FIXTURE,
  MUX_ERROR_FIXTURE,
  SESSION_FOLLOW_FIXTURE,
];

function rawFixture(name: string): string {
  return readFileSync(dshFixturePath(name), 'utf8');
}

function jsonlLines(name: string): string[] {
  return rawFixture(name).split('\n').filter((line) => line.trim().length > 0);
}

const sessionFollow = loadDshWireFixture(SESSION_FOLLOW_FIXTURE);
const sessionFollowValue = sessionFollow.frames[0]?.type === 'item' ? sessionFollow.frames[0].value : undefined;
const snapshot = ((): DshSessionSnapshot => {
  if (!isDshSessionSnapshot(sessionFollowValue)) {
    throw new Error('fixture frame is not a session/follow snapshot');
  }
  return sessionFollowValue;
})();
const records = snapshot.records.map((record) => record.event as DshSessionWireEvent);

// ---------------------------------------------------------------------------
// Version stamps (stale_state class: a missing/invalid stamp must fail here)
// ---------------------------------------------------------------------------

describe('dsh fixture sidecars', () => {
  it('every fixture has a meta sidecar stamped dsh@0.2.0-rc.2', () => {
    for (const name of ALL_FIXTURES) {
      const { meta, frames } = loadDshWireFixture(name);
      expect(meta.dshVersion, `${name} dshVersion`).toBe(DSH_WIRE_VERSION);
      expect(meta.dshVersion).toBe('0.2.0-rc.2');
      expect(Number.isNaN(Date.parse(meta.capturedAt)), `${name} capturedAt`).toBe(false);
      expect(meta.captureEndpoint.length, `${name} captureEndpoint`).toBeGreaterThan(0);
      expect(meta.source, `${name} source`).toContain('04-session-follow-full.txt');
      expect(frames.length, `${name} frame count`).toBe(meta.frames);
    }
  });

  it('rejects a meta sidecar whose version stamp is missing or stale', () => {
    expect(() => assertDshFixtureMeta({ capturedAt: 'x', captureEndpoint: 'y', source: 'z', frames: 1 }, 'f.jsonl')).toThrow(
      DshWireParseError,
    );
    try {
      assertDshFixtureMeta(
        { dshVersion: '0.3.0', capturedAt: '2026-09-29T14:36:36.628Z', captureEndpoint: 'ws://x', source: 'y', frames: 1 },
        'f.jsonl',
      );
      throw new Error('expected version-mismatch rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(DshWireParseError);
      expect((error as DshWireParseError).kind).toBe('version-mismatch');
    }
  });
});

// ---------------------------------------------------------------------------
// JSONL purity (every line must be plain JSON.parse-able, no comment lines)
// ---------------------------------------------------------------------------

describe('dsh fixture jsonl purity', () => {
  it('every line of every fixture parses as plain JSON with no comment lines', () => {
    for (const name of ALL_FIXTURES) {
      const lines = jsonlLines(name);
      expect(lines.length, `${name} line count`).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line.startsWith('#') || line.startsWith('//'), `${name} comment line`).toBe(false);
        expect(() => JSON.parse(line), `${name} line JSON.parse`).not.toThrow();
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Captured frames pass the typed guards
// ---------------------------------------------------------------------------

describe('dsh captured frames', () => {
  it('guards the $events ready frame', () => {
    const { frames } = loadDshWireFixture(EVENTS_READY_FIXTURE);
    expect(frames).toHaveLength(1);
    const frame = frames[0]!;
    expect(frame.type).toBe('item');
    if (frame.type !== 'item') return;
    expect(isDshMuxServerFrame(frame)).toBe(true);
    const value = frame.value;
    expect(isDshEventsFrame(value)).toBe(true);
    if (!isDshEventsFrame(value) || value.type !== 'ready') throw new Error('expected ready frame');
    expect(value.clientId).toMatch(/^[0-9a-f-]{36}$/);
    expect(value.host.home).toBe('/home/qiyuaner');
  });

  it('guards the workspace/follow baseline with its double-nested value', () => {
    const { frames } = loadDshWireFixture(WORKSPACE_BASELINE_FIXTURE);
    const frame = frames[0]!;
    if (frame.type !== 'item') throw new Error('expected item frame');
    const value = frame.value;
    expect(isDshWorkspaceFollowFrame(value)).toBe(true);
    if (!isDshWorkspaceFollowFrame(value) || value.type !== 'baseline') throw new Error('expected baseline');
    expect(value.value.items).toHaveLength(1);
    const item = value.value.items[0]!;
    expect(item.workspaceId).toBe('391a6bfc-44f6-4f81-bc1d-723499f9e3ca');
    expect(item.path).toBe('/tmp/opencode/dsh-probe/wsroot');
    expect(item.title).toBe('wsroot');
    expect(item.sessionIds).toEqual(['session-06ee930d-7d74-42b1-928d-ac8fdd4376bf']);
    expect(value.value.archivedSessionIds).toEqual([]);
    expect(value.value.pinnedSessionIds).toEqual([]);
  });

  it('guards the mux error frame (gateway/input-invalid from session/page)', () => {
    const { frames } = loadDshWireFixture(MUX_ERROR_FIXTURE);
    const frame = frames[0]!;
    expect(frame.type).toBe('error');
    if (frame.type !== 'error') return;
    expect(frame.streamId).toBe('pg1');
    expect(frame.error.code).toBe('gateway/input-invalid');
    expect(frame.error.message).toContain('session/page');
    expect(frame.error.details).toEqual({ endpoint: 'session/page', field: 'request' });
  });

  it('guards the session/follow snapshot', () => {
    expect(sessionFollowValue).toBeDefined();
    expect(isDshSessionFollowFrame(sessionFollowValue)).toBe(true);
    expect(snapshot.header).toEqual({
      version: 4,
      id: 'session-06ee930d-7d74-42b1-928d-ac8fdd4376bf',
      createdAt: 1790692532388,
      cwd: '/tmp/opencode/dsh-probe/wsroot',
      isSeeded: false,
      agentPreset: 'standard',
    });
    expect(snapshot.cursor).toBe(17);
    expect(snapshot.hasMore).toBe(false);
    expect(snapshot.projections.asOfSeq).toBe(17);
    expect(snapshot.assistantStream).toEqual({ revision: 3 });
    expect(isDshProjectionBaseline(snapshot.projections)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Event vocabulary: EVERY record from the live capture must be a union member
// (misleading_success class: assert the full set, not a sample)
// ---------------------------------------------------------------------------

describe('dsh session event vocabulary', () => {
  it('covers every real record event.type from 04-session-follow-full.txt', () => {
    expect(records).toHaveLength(18);
    for (const event of records) {
      expect(DSH_SESSION_EVENT_TYPES, `record seq=${event.seq} type=${event.type}`).toContain(event.type);
    }
  });

  it('matches the exact distinct event.type set observed in the capture', () => {
    const distinct = [...new Set(records.map((event) => event.type))].sort();
    expect(distinct).toEqual([
      'agent/inbox/spliced',
      'approval/policy',
      'assistant/attempt',
      'permission/preset',
      'request/context',
      'request/header',
      'sandbox/mode',
      'session/title',
      'session/title-llm-request',
      'step/end',
      'step/start',
      'system/message',
      'turn/end',
      'turn/start',
      'user/message',
    ]);
    // session/title-llm-request rides the wire log but is absent from the
    // dsh SessionEventMap declaration; the union must still cover it.
    expect(DSH_SESSION_EVENT_TYPES).toContain('session/title-llm-request');
  });

  it('keeps record seq contiguous from 0 to cursor-1', () => {
    expect(records.map((event) => event.seq)).toEqual(Array.from({ length: 18 }, (_, index) => index));
  });

  it('rejects an event whose type is outside the vocabulary', () => {
    const forged = structuredClone(records[0]) as DshSessionWireEvent;
    (forged as { type: string }).type = 'not/a/real/event';
    expect(DSH_SESSION_EVENT_TYPES).not.toContain(forged.type);
    const forgedSnapshot = structuredClone(snapshot) as DshSessionSnapshot;
    (forgedSnapshot.records[0] as { event: DshSessionWireEvent }).event = forged;
    expect(isDshSessionFollowFrame(forgedSnapshot)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RPC envelope shapes (docs/dsh.md §5)
// ---------------------------------------------------------------------------

describe('dsh rpc envelopes', () => {
  it('guards the client-request envelope with {args} wrapping', () => {
    const request = {
      type: 'client-request',
      rpcId: 'r1',
      method: 'session/list',
      payload: { args: { _request: {} } },
    };
    expect(isDshClientRequest(request)).toBe(true);
  });

  it('guards both server-response result arms', () => {
    const ok = { type: 'server-response', rpcId: 'r1', result: { ok: true, value: { items: [] } } };
    const failed = {
      type: 'server-response',
      rpcId: 'r1',
      result: {
        ok: false,
        error: {
          code: 'gateway/arguments-invalid',
          message: 'typert gateway: session/list: args fields do not match the descriptor: missing "_request"',
          details: { endpoint: 'session/list' },
        },
      },
    };
    expect(isDshServerResponse(ok)).toBe(true);
    expect(isDshServerResponse(failed)).toBe(true);
  });

  it('rejects envelopes that violate the wire schema', () => {
    expect(isDshClientRequest({ type: 'client-request', rpcId: 'r1', method: 'session/list', payload: { sessionId: 'x' } })).toBe(false);
    expect(isDshClientRequest({ type: 'client-request', method: 'session/list', payload: { args: {} } })).toBe(false);
    expect(isDshServerResponse({ type: 'server-response', rpcId: 'r1', result: { ok: false } })).toBe(false);
    expect(isDshServerResponse({ type: 'server-response', rpcId: 'r1', result: { ok: 'yes', value: 1 } })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// session/page + session/prompt request shapes (docs/dsh.md §7.1/§9, typert schemas)
// ---------------------------------------------------------------------------

describe('dsh session/page and session/prompt requests', () => {
  it('guards the session/page request captured during probing', () => {
    const request = {
      address: { kind: 'session', sessionId: 'session-06ee930d-7d74-42b1-928d-ac8fdd4376bf' },
      throughSeq: 17,
    };
    expect(isDshSessionPageRequest(request)).toBe(true);
    const subagent = {
      address: { kind: 'subagent', parentSessionId: 'session-a', childSessionId: 'session-b', mode: 'one-shot' },
      throughSeq: 3,
      beforeSeq: 9,
      maxMessages: 50,
      turnWindow: { minMessages: 2, minTurns: 1 },
    };
    expect(isDshSessionAddress(subagent.address)).toBe(true);
    expect(isDshSessionPageRequest(subagent)).toBe(true);
  });

  it('rejects a session/page request missing throughSeq', () => {
    expect(isDshSessionPageRequest({ address: { kind: 'session', sessionId: 's' } })).toBe(false);
  });

  it('guards the session/page result shape', () => {
    const result = { records: snapshot.records, hasMore: false };
    expect(isDshSessionPageResult(result)).toBe(true);
    expect(isDshSessionPageResult({ records: [{ type: 'chunk', value: 1 }], hasMore: false })).toBe(false);
    expect(isDshSessionPageResult({ hasMore: false })).toBe(false);
  });

  it('guards the session/prompt request actually sent during probing', () => {
    const request = {
      requestId: 'probe-r1',
      sessionId: 'session-06ee930d-7d74-42b1-928d-ac8fdd4376bf',
      mode: 'queue',
      content: [{ type: 'text', text: 'say hi' }],
    };
    expect(isDshSessionPromptRequest(request)).toBe(true);
  });

  it('guards every prompt content part kind and both modes', () => {
    const base = { requestId: 'r2', sessionId: 's', mode: 'steer' };
    expect(isDshSessionPromptRequest({ ...base, content: [{ type: 'image', mediaType: 'image/png', data: 'AAA', name: 'a.png' }] })).toBe(true);
    expect(isDshSessionPromptRequest({ ...base, content: [{ type: 'file', receiptId: 'receipt-1' }] })).toBe(true);
    expect(isDshSessionPromptRequest({ ...base, clientTimeZone: 'Asia/Shanghai', content: [] })).toBe(true);
  });

  it('rejects prompt requests without requestId, with a bad mode, or a bad part', () => {
    expect(isDshSessionPromptRequest({ sessionId: 's', mode: 'queue', content: [] })).toBe(false);
    expect(isDshSessionPromptRequest({ requestId: 'r3', sessionId: 's', mode: 'steer-now', content: [] })).toBe(false);
    expect(isDshSessionPromptRequest({ requestId: 'r3', sessionId: 's', mode: 'queue', content: [{ type: 'video', url: 'x' }] })).toBe(false);
    expect(isDshSessionPromptRequest({ requestId: 'r3', sessionId: 's', mode: 'queue', content: [{ type: 'image', mediaType: 'image/tiff', data: 'AAA' }] })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Malformed frames: rejected with a classified error (adversarial class)
// ---------------------------------------------------------------------------

describe('dsh malformed wire lines', () => {
  it('classifies non-JSON lines as not-json', () => {
    try {
      parseDshWireLine('}{ not json');
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(DshWireParseError);
      expect((error as DshWireParseError).kind).toBe('not-json');
    }
  });

  it('classifies non-object JSON as not-object', () => {
    for (const line of ['[]', '"frame"', '42', 'null']) {
      try {
        parseDshWireLine(line);
        throw new Error(`expected rejection for ${line}`);
      } catch (error) {
        expect((error as DshWireParseError).kind).toBe('not-object');
      }
    }
  });

  it('classifies unknown frame types', () => {
    try {
      parseDshWireLine(JSON.stringify({ type: 'bogus', streamId: 'x' }));
      throw new Error('expected rejection');
    } catch (error) {
      expect((error as DshWireParseError).kind).toBe('unknown-frame-type');
    }
  });

  it('classifies bad or missing stream ids', () => {
    for (const line of [
      JSON.stringify({ type: 'item' }),
      JSON.stringify({ type: 'item', streamId: '' }),
      JSON.stringify({ type: 'item', streamId: 42 }),
      JSON.stringify({ type: 'end' }),
      JSON.stringify({ type: 'cancel', streamId: null }),
    ]) {
      try {
        parseDshWireLine(line);
        throw new Error(`expected rejection for ${line}`);
      } catch (error) {
        expect((error as DshWireParseError).kind).toBe('bad-stream-id');
      }
    }
  });

  it('classifies missing and unexpected fields', () => {
    try {
      parseDshWireLine(JSON.stringify({ type: 'open', streamId: 'a', endpoint: 'session/follow' }));
      throw new Error('expected rejection');
    } catch (error) {
      expect((error as DshWireParseError).kind).toBe('missing-field');
    }
    try {
      parseDshWireLine(JSON.stringify({ type: 'error', streamId: 'a' }));
      throw new Error('expected rejection');
    } catch (error) {
      expect((error as DshWireParseError).kind).toBe('missing-field');
    }
    try {
      parseDshWireLine(JSON.stringify({ type: 'end', streamId: 'a', value: 1 }));
      throw new Error('expected rejection');
    } catch (error) {
      expect((error as DshWireParseError).kind).toBe('unexpected-field');
    }
  });

  it('classifies present-but-wrong-shaped fields as bad-value', () => {
    try {
      parseDshWireLine(JSON.stringify({ type: 'error', streamId: 'a', error: { code: 42, message: 'm' } }));
      throw new Error('expected rejection');
    } catch (error) {
      expect((error as DshWireParseError).kind).toBe('bad-value');
    }
    try {
      parseDshWireLine(JSON.stringify({ type: 'open', streamId: 'a', endpoint: 'session/follow', payload: { flat: true } }));
      throw new Error('expected rejection');
    } catch (error) {
      expect((error as DshWireParseError).kind).toBe('bad-value');
    }
  });

  it('round-trips every well-formed client frame kind', () => {
    const frames: unknown[] = [
      { type: 'open', streamId: 'sf1', endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: 's' } } } } },
      { type: 'item', streamId: 'sf1', value: { type: 'snapshot' } },
      { type: 'item', streamId: 'sf1' },
      { type: 'end', streamId: 'sf1' },
      { type: 'cancel', streamId: 'sf1' },
    ];
    for (const frame of frames) {
      expect(() => parseDshWireLine(JSON.stringify(frame))).not.toThrow();
    }
  });

  it('rejects stream values that violate their frame contracts', () => {
    // single-nested workspace baseline must not pass (wire nests under value)
    expect(isDshWorkspaceFollowFrame({ type: 'baseline', items: [], archivedSessionIds: [], pinnedSessionIds: [] })).toBe(false);
    // snapshot missing projections
    expect(
      isDshSessionFollowFrame({
        type: 'snapshot',
        header: { version: 4, id: 's', createdAt: 1, isSeeded: false },
        cursor: 0,
        records: [],
        hasMore: false,
      }),
    ).toBe(false);
    // projections values with a mistyped known key
    expect(isDshProjectionBaseline({ asOfSeq: 1, values: { title: 42 } })).toBe(false);
  });
});

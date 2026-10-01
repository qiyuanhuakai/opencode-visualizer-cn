import { describe, expect, it } from 'vitest';
import { createDshNormalizer } from './normalize';
import type { DshSessionRecord, DshSessionWireEvent, DshJsonValue } from './types';

function record(type: DshSessionWireEvent['type'], seq: number, data: DshJsonValue): DshSessionRecord {
  return { type: 'event', event: { type, seq, time: seq + 100, data } };
}

describe('DSH terminal popup markers', () => {
  for (const kind of ['completed', 'aborted', 'cancelled', 'error']) it(`emits terminal text/reasoning and message on ${kind}`, () => {
    const normalizer = createDshNormalizer({ address: { kind: 'session', sessionId: 'main' } });
    normalizer.ingest(record('assistant/message', 1, { turn: 1, message: { role: 'assistant', content: [
      { type: 'text', text: 'answer' }, { type: 'reasoning', text: 'thinking' },
    ] } }));
    const result = normalizer.ingest(record('turn/end', 2, { turn: 1, reason: { kind } }));
    const messages = result.ops.filter(op => op.kind === 'message');
    expect(messages.at(-1)?.message.time).toMatchObject({ completed: 102 });
    const parts = result.ops.filter(op => op.kind === 'part').map(op => op.part);
    expect(parts.filter(part => part.type === 'text' || part.type === 'reasoning')).toHaveLength(2);
    expect(parts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'text', time: expect.objectContaining({ end: 102 }) }),
      expect.objectContaining({ type: 'reasoning', time: expect.objectContaining({ end: 102 }) }),
    ]));
  });

  for (const kind of ['aborted', 'cancelled', 'error']) it(`finalizes a pending tool on ${kind} without a tool result`, () => {
    const normalizer = createDshNormalizer({ address: { kind: 'session', sessionId: 'main' } });
    normalizer.ingest(record('tool/call', 1, { turn: 1, callId: 'read-1', name: 'read', arguments: { path: 'a.ts' } }));
    const result = normalizer.ingest(record('turn/end', 2, { turn: 1, reason: { kind } }));
    const tool = result.ops.filter(op => op.kind === 'part').map(op => op.part).find(part => part.type === 'tool');
    expect(tool).toMatchObject({ callID: 'read-1', state: { status: 'error', time: { end: 102 } } });
  });
});

import { describe, expect, it } from 'vitest';
import { createKimiWebNormalizer } from './normalize';

describe('Kimi Code 2.0.2 subagent cancellation', () => {
  it('terminates the child output without completing its parent', () => {
    const normalizer = createKimiWebNormalizer({ now: () => 1234 });
    normalizer.ingest({
      type: 'thinking.delta', session_id: 'parent',
      payload: { agentId: 'child', turnId: 1, delta: 'Working' },
    });
    // Payload shape from the live 2.0.2 /asyncapi.json session_event schema.
    const result = normalizer.ingest({
      type: 'subagent.cancelled', session_id: 'parent',
      payload: { type: 'subagent.cancelled', subagentId: 'child' },
    });
    expect(result.ops).toContainEqual(expect.objectContaining({
      kind: 'subagent', phase: 'cancelled', sessionId: 'parent',
      subagentSessionId: 'parent:child:1',
    }));
    expect(result.ops.some((op) => op.kind === 'part'
      && op.part.sessionID === 'parent:child:1'
      && op.part.type === 'reasoning' && op.part.time?.end === 1234)).toBe(true);
    expect(result.ops.some((op) => op.kind === 'turn')).toBe(false);
    expect(normalizer.stats().unknownEventCount).toBe(0);
  });
});

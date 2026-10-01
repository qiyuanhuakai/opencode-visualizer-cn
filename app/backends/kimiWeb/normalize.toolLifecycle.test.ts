import { describe, expect, it } from 'vitest';
import { createKimiWebNormalizer } from './normalize';

describe('Kimi tool terminal lifecycle', () => {
  it.each([false, true])('ignores late progress after a terminal result (error=%s)', (isError) => {
    const normalizer = createKimiWebNormalizer();
    const payload = { sessionId: 'session', agentId: 'main', turnId: 1, toolCallId: 'shell' };
    normalizer.ingest({ type: 'tool.call.started', session_id: 'session', payload: {
      ...payload, name: 'Shell', args: { command: 'pwd' }, time: 1,
    } });
    const result = normalizer.ingest({ type: 'tool.result', session_id: 'session', payload: {
      ...payload, output: '/project', isError, time: 2,
    } });
    expect(result.ops).toContainEqual(expect.objectContaining({
      kind: 'part', part: expect.objectContaining({ state: expect.objectContaining({ status: isError ? 'error' : 'completed' }) }),
    }));
    const late = normalizer.ingest({ type: 'tool.progress', session_id: 'session', volatile: true, payload: {
      ...payload, update: { text: 'late output' }, time: 3,
    } });
    expect(late.ops.filter(op => op.kind === 'part')).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import type { AssistantMessageInfo, MessageInfo } from '../../types/sse';
import { createDshNormalizer } from './normalize';

function harness() {
  const normalizer = createDshNormalizer({ address: { kind: 'session', sessionId: 'usage-session' } });
  const messages = new Map<string, MessageInfo>();
  const records: Array<{ type: 'event'; event: { type: string; seq: number; time: number; data: Record<string, unknown> } }> = [];
  function event(type: string, data: Record<string, unknown>) {
    const record = { type: 'event' as const, event: { type, seq: records.length, time: records.length + 1, data } };
    records.push(record);
    for (const op of normalizer.ingest(record).ops) if (op.kind === 'message') messages.set(op.message.id, op.message);
    return record;
  }
  function assistant(step = 1): AssistantMessageInfo {
    const message = messages.get(`usage-session:t1${step === 1 ? '' : `:s${step}`}`);
    if (message?.role !== 'assistant') throw new Error('Missing assistant');
    return message;
  }
  return { normalizer, messages, records, event, assistant };
}

const usage = { inputTokens: 100, outputTokens: 30, cacheReadTokens: 20, cacheWriteTokens: 10, reasoningTokens: 12, totalTokens: 160 };
const stream = [{ type: 'chunk', time: 3, chunk: { type: 'usage', usage } }, { type: 'chunk', time: 4, chunk: { type: 'finish', reason: { kind: 'completed' } } }];
const expected = { input: 100, output: 30, reasoning: 12, total: 160, cache: { read: 20, write: 10 } };

describe('DSH durable message usage', () => {
  it.each([
    { inputTokens: 6399, outputTokens: 468, cacheReadTokens: 1024, cacheWriteTokens: 0, totalTokens: 7891 },
    { inputTokens: 210, outputTokens: 1080, cacheReadTokens: 7808, cacheWriteTokens: 0, totalTokens: 9098 },
    { inputTokens: 221, outputTokens: 109, cacheReadTokens: 8960, cacheWriteTokens: 0, totalTokens: 9290 },
  ])('preserves captured native assistant message counts $totalTokens', sample => {
    const view = harness();
    view.event('turn/start', { turn: 1 });
    view.event('assistant/message', { turn: 1, step: 1, usage: sample, message: { content: [] } });
    expect(view.assistant().tokens).toEqual({ input: sample.inputTokens, output: sample.outputTokens, reasoning: 0, total: sample.totalTokens, cache: { read: sample.cacheReadTokens, write: sample.cacheWriteTokens } });
  });

  it('replaces live usage with the same durable sample without double counting', () => {
    const view = harness();
    view.event('turn/start', { turn: 1 });
    view.normalizer.ingest({ type: 'assistant-stream', frame: { type: 'start', attemptId: 'attempt-1', turn: 1, step: 1 } });
    const result = view.normalizer.ingest({ type: 'assistant-stream', frame: { type: 'chunk', attemptId: 'attempt-1', index: 0, chunk: { type: 'usage', usage } } });
    expect(result.ops).toContainEqual(expect.objectContaining({ kind: 'message', message: expect.objectContaining({ tokens: expected }) }));
    view.event('assistant/message', { turn: 1, step: 1, usage, message: { content: [] } });
    expect(view.assistant().tokens).toEqual(expected);
  });

  it('retains native attempt counts through settlement, turn completion and fresh history replay', () => {
    const view = harness();
    view.event('turn/start', { turn: 1 });
    view.event('assistant/attempt', { turn: 1, step: 1, stream });
    expect(view.assistant().tokens).toEqual(expected);
    view.event('assistant/message', { turn: 1, step: 1, stream, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } });
    view.event('turn/end', { turn: 1, reason: { kind: 'completed' } });
    expect(view.assistant().tokens).toEqual(expected);
    const restored = createDshNormalizer();
    const result = restored.ingest({ type: 'snapshot', header: { id: 'usage-session' }, records: view.records });
    const messages = result.ops.flatMap(op => op.kind === 'message' ? [op.message] : []);
    expect(messages.at(-1)).toMatchObject({ tokens: expected });
    expect(restored.ingest({ records: view.records }).ops).toEqual([]);
  });

  it('prefers assistant message usage and replaces samples within an attempt', () => {
    const view = harness();
    view.event('turn/start', { turn: 1 });
    view.event('assistant/attempt', { turn: 1, step: 1, stream });
    view.event('assistant/message', { turn: 1, step: 1, stream, usage: { ...usage, outputTokens: 40, totalTokens: 170 }, message: { content: [] } });
    expect(view.assistant().tokens).toEqual({ ...expected, output: 40, total: 170 });
  });

  it('adds retry attempts without double counting durable replacement or separate steps', () => {
    const view = harness();
    view.event('turn/start', { turn: 1 });
    view.event('assistant/attempt', { turn: 1, step: 1, stream });
    view.event('llm/retry-started', { turn: 1, step: 1 });
    view.event('assistant/attempt', { turn: 1, step: 1, stream });
    expect(view.assistant().tokens).toEqual({ input: 200, output: 60, reasoning: 24, total: 320, cache: { read: 40, write: 20 } });
    view.event('assistant/message', { turn: 1, step: 2, usage, message: { content: [] } });
    expect(view.assistant(2).tokens).toEqual(expected);
    expect(view.assistant().tokens.input).toBe(200);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])('rejects malformed native usage %s', inputTokens => {
    const view = harness();
    view.event('turn/start', { turn: 1 });
    view.event('assistant/message', { turn: 1, step: 1, usage: { ...usage, inputTokens }, message: { content: [] } });
    expect(view.assistant().tokens.input).toBe(0);
  });
});

it('keeps request thinking intensity on each turn across later selections and history replay', () => {
  const view = harness();
  view.event('user/message', { id: 'user-1', source: { kind: 'user' }, content: [] });
  view.event('turn/start', { turn: 1 });
  view.event('request/header', { header: { config: { provider: 'native', model: 'reasoner', reasoningEffort: 'high' } } });
  view.event('assistant/message', { turn: 1, step: 1, message: { content: [] } });
  view.event('turn/end', { turn: 1, reason: { kind: 'completed' } });
  view.event('user/message', { id: 'user-2', source: { kind: 'user' }, content: [] });
  view.event('turn/start', { turn: 2 });
  view.event('request/header', { header: { config: { provider: 'native', model: 'reasoner', reasoningEffort: 'low' } } });
  view.event('assistant/message', { turn: 2, step: 1, message: { content: [] } });
  expect(view.messages.get('user-1')?.variant).toBe('high');
  expect(view.assistant().variant).toBe('high');
  expect(view.messages.get('user-2')?.variant).toBe('low');
  expect(view.messages.get('usage-session:t2')?.variant).toBe('low');
  const restored = createDshNormalizer();
  const messages = new Map(restored.ingest({ type: 'snapshot', header: { id: 'usage-session' }, records: view.records }).ops.flatMap(op => op.kind === 'message' ? [[op.message.id, op.message] as const] : []));
  expect(messages.get('user-1')?.variant).toBe('high');
  expect(messages.get('usage-session:t2')?.variant).toBe('low');
});

import { describe, expect, it } from 'vitest';
import { createKimiWebNormalizer } from './normalize';
import { kimiWebMessagesToHistoryEntries } from './historyEntries';

const submitted = {
  type: 'prompt.submitted', seq: 16, session_id: 'session-live',
  timestamp: '2026-09-22T13:22:47.893Z',
  payload: {
    type: 'prompt.submitted', time: 1790083367893, agentId: 'main',
    promptId: 'msg-prompt', userMessageId: 'msg-prompt', status: 'running',
    content: [{ type: 'text' as const, text: 'Reply only VIS_KIMI_202_OK.' }],
    createdAt: '2026-09-22T13:22:47.892Z', sessionId: 'session-live',
  }, epoch: 'epoch-live',
};

describe('Kimi live submitted prompt', () => {
  it('emits the same stable user message and parts as REST history', () => {
    const normalizer = createKimiWebNormalizer();
    const ops = normalizer.ingest(submitted).ops;
    const [history] = kimiWebMessagesToHistoryEntries([{
      id: 'msg-prompt', session_id: 'session-live', role: 'user',
      content: submitted.payload.content, created_at: submitted.payload.createdAt,
    }]);
    expect(ops.find((op) => op.kind === 'message')).toEqual({ kind: 'message', message: history?.info });
    expect(ops.filter((op) => op.kind === 'part')).toEqual(history?.parts.map((part) => ({ kind: 'part', part })));
    expect(normalizer.ingest(submitted).ops).toEqual(ops);
  });

  it('uses userMessageId as the assistant parent when promptId differs', () => {
    const normalizer = createKimiWebNormalizer();
    normalizer.ingest({ ...submitted, payload: { ...submitted.payload, userMessageId: 'msg-user' } });
    normalizer.ingest({ type: 'prompt.started', session_id: 'session-live', payload: { agentId: 'main', promptId: 'msg-prompt' } });
    const ops = normalizer.ingest({ type: 'turn.started', session_id: 'session-live', payload: {
      agentId: 'main', turnId: 2, promptId: 'msg-prompt', time: 1790083367903,
    } }).ops;
    expect(ops.find((op) => op.kind === 'message')).toMatchObject({ message: { parentID: 'msg-user' } });
  });

  it('filters injection prompts consistently with history and ignores malformed text parts', () => {
    const normalizer = createKimiWebNormalizer();
    const injection = normalizer.ingest({ ...submitted, payload: { ...submitted.payload,
      metadata: { origin: { kind: 'injection' } },
    } });
    expect(injection.ops.filter((op) => op.kind === 'message' || op.kind === 'part')).toEqual([]);
    const malformed = normalizer.ingest({ ...submitted, payload: { ...submitted.payload,
      content: [{ type: 'text', text: 42 }, null, { type: 'text', text: 'visible' }],
    } });
    expect(malformed.ops.filter((op) => op.kind === 'part')).toMatchObject([{ part: { text: 'visible' } }]);
  });
});

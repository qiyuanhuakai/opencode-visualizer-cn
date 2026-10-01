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
  it.each(['injection', 'task', 'skill_activation', 'plugin_command'])(
    'keeps continuation content under the visible user when a hidden %s prompt arrives',
    (kind) => {
      // Given a visible prompt followed by an automatic system prompt.
      const normalizer = createKimiWebNormalizer();
      normalizer.ingest(submitted);
      normalizer.ingest({ type: 'subagent.completed', session_id: 'session-live', payload: {
        agentId: 'main', subagentId: 'worker', summary: 'Worker finished',
      } });
      const hidden = normalizer.ingest({ ...submitted, payload: { ...submitted.payload,
        promptId: 'hidden-prompt', userMessageId: 'hidden-user',
        metadata: { origin: { kind } },
      } });
      normalizer.ingest({ type: 'prompt.started', session_id: 'session-live', payload: {
        agentId: 'main', promptId: 'hidden-prompt', userMessageId: 'hidden-user',
      } });
      normalizer.ingest({ type: 'turn.started', session_id: 'session-live', payload: {
        agentId: 'main', turnId: 2, promptId: 'hidden-prompt',
      } });

      // When the continuation opens its next utterance.
      const result = normalizer.ingest({ type: 'turn.step.started', session_id: 'session-live', payload: {
        agentId: 'main', turnId: 2, step: 1,
      } });

      // Then no hidden user root appears and the assistant stays on the visible user.
      expect(hidden.ops.filter((op) => op.kind === 'message')).toEqual([]);
      expect(result.ops.find((op) => op.kind === 'message')).toMatchObject({
        message: { parentID: 'msg-prompt' },
      });
    },
  );

  it.each(['skill_activation', 'plugin_command'])(
    'keeps user-slash %s prompts visible and parents their replies to them',
    (kind) => {
      // Given a user-invoked command prompt.
      const normalizer = createKimiWebNormalizer();
      const prompt = normalizer.ingest({ ...submitted, payload: { ...submitted.payload,
        metadata: { origin: { kind, trigger: 'user-slash' } },
      } });

      // When its assistant utterance opens.
      const result = normalizer.ingest({ type: 'turn.step.started', session_id: 'session-live', payload: {
        agentId: 'main', turnId: 2, step: 1, promptId: 'msg-prompt',
      } });

      // Then the visible command remains the parent.
      expect(prompt.ops.find((op) => op.kind === 'message')).toMatchObject({ message: { id: 'msg-prompt' } });
      expect(result.ops.find((op) => op.kind === 'message')).toMatchObject({ message: { parentID: 'msg-prompt' } });
    },
  );

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
    normalizer.ingest({ type: 'turn.started', session_id: 'session-live', payload: {
      agentId: 'main', turnId: 2, promptId: 'msg-prompt', time: 1790083367903,
    } });
    const ops = normalizer.ingest({ type: 'turn.step.started', session_id: 'session-live', payload: {
      agentId: 'main', turnId: 2, step: 1, stepId: 'step-2', time: 1790083367904,
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

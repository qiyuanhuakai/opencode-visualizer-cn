import { describe, expect, it } from 'vitest';
import type { KimiWebAgentTranscript, KimiWebMessage } from '../../utils/kimiWeb';
import { loadKimiWebHistoryEntries } from './history';
import { createKimiWebNormalizer } from './normalize';
import { KimiWebTransportError } from '../../utils/kimiWeb';

describe('Kimi history usage', () => {
  it('keeps assistant usage when newer user frames repeat the same answer', async () => {
    // Given an assistant step followed by an identical user-only transcript step.
    const transcript: KimiWebAgentTranscript = { agent_id: 'main', has_more: false, items: [{
      kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', steps: [
        { stepId: 't1.1', usage: { inputOther: 11, output: 23 },
          frames: [{ kind: 'text', frameId: 'answer', role: 'assistant', text: 'Same answer' }] },
        { stepId: 't1.2', usage: { inputOther: 99, output: 101 },
          frames: [{ kind: 'text', frameId: 'echo', role: 'user', text: 'Same answer' }] },
      ],
    }] };
    const messages: KimiWebMessage[] = [
      { id: 'user-echo', session_id: 'session', role: 'user', content: [{ type: 'text', text: 'Same answer' }] },
      { id: 'assistant', session_id: 'session', role: 'assistant', content: [{ type: 'text', text: 'Same answer' }] },
    ];

    // When the newest history window includes the echo and its preceding answer.
    const result = await loadKimiWebHistoryEntries({ sessionId: 'session',
      getMessages: async () => ({ items: messages, has_more: false }), getAgentTranscript: async () => transcript,
    });

    // Then the assistant retains its own usage rather than consuming the user's.
    expect(result.entries.find(({ info }) => info.id === 'assistant')?.info).toHaveProperty('tokens.output', 23);
    expect(result.entries.find(({ info }) => info.id === 'user-echo')?.info).not.toHaveProperty('tokens');
  });

  it.each([1, 2])('restores repeated replies in chronological order for a %s-row history suffix', async (count) => {
    // Given newest-first transcript turns with identical replies and different usage.
    const transcript: KimiWebAgentTranscript = { agent_id: 'main', has_more: false, items: [2, 1].map((ordinal) => ({
      kind: 'turn', turnId: `t${ordinal}`, ordinal, state: 'completed', steps: [{
        stepId: `t${ordinal}.1`, usage: { inputOther: ordinal * 10, output: ordinal * 20 },
        frames: [{ kind: 'text', frameId: 'f', role: 'assistant', text: 'Same reply' }],
      }],
    })) };
    const messages: KimiWebMessage[] = [2, 1].slice(0, count).map((ordinal) => ({
      id: `rest-${ordinal}`, session_id: 'session', role: 'assistant', content: [{ type: 'text', text: 'Same reply' }],
    }));

    // When a full history or a tail window is restored.
    const result = await loadKimiWebHistoryEntries({ sessionId: 'session',
      getMessages: async () => ({ items: messages, has_more: false }), getAgentTranscript: async () => transcript,
    });

    // Then each occurrence gets only its corresponding step's usage.
    expect(result.entries.map(({ info }) => info.role === 'assistant' ? info.tokens.output : 0))
      .toEqual(count === 1 ? [40] : [20, 40]);
  });

  it('retains message history when transcript usage is unavailable', async () => {
    // Given a readable message page and an unavailable transcript endpoint.
    const messages: KimiWebMessage[] = [{ id: 'saved', session_id: 'session', role: 'assistant',
      content: [{ type: 'text', text: 'Saved reply' }],
    }];

    // When optional usage recovery fails at the transport boundary.
    const result = await loadKimiWebHistoryEntries({ sessionId: 'session',
      getMessages: async () => ({ items: messages, has_more: false }),
      getAgentTranscript: async () => { throw new KimiWebTransportError('offline', { kind: 'network', path: '/transcript' }); },
    });

    // Then the saved message remains readable.
    expect(result.entries.map(({ info }) => info.id)).toEqual(['saved']);
  });

  it.each([true, false])('restores live step tokens after reload (tool step: %s)', async (withTool) => {
    // Given the same completed step in live events and persisted REST transcript.
    const usage = { inputOther: 17, output: 23, inputCacheRead: 41, inputCacheCreation: 7 };
    const normalizer = createKimiWebNormalizer();
    normalizer.ingest({ type: 'turn.step.started', session_id: 'session', payload: { turnId: 1, step: 1 } });
    const completed = normalizer.ingest({ type: 'turn.step.completed', session_id: 'session', payload: {
      turnId: 1, step: 1, usage,
    } }).ops.find((op) => op.kind === 'message');
    const transcript: KimiWebAgentTranscript = {
      agent_id: 'main', has_more: false, items: [{
        kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', steps: [{
          stepId: 't1.1',
          usage,
          frames: withTool
            ? [{ kind: 'tool', frameId: 'f1', toolCallId: 'call-1', name: 'Read', state: 'done' }]
            : [{ kind: 'text', frameId: 'f1', role: 'assistant', text: 'Result 123' }],
        }],
      }],
    };
    const messages: KimiWebMessage[] = [{ id: 'rest-message', session_id: 'session', role: 'assistant',
      content: withTool
        ? [{ type: 'tool_use', tool_call_id: 'call-1', tool_name: 'Read', input: {} }]
        : [{ type: 'text', text: 'Result 123' }],
    }];
    const params = {
      sessionId: 'session', getMessages: async () => ({ items: messages, has_more: false }),
      getAgentTranscript: async () => transcript,
    };

    // When history is loaded from the server again.
    const result = await loadKimiWebHistoryEntries(params);

    // Then the card retains its live per-step token totals.
    expect(completed?.message).toHaveProperty('tokens.output', 23);
    expect(result.entries[0]?.info).toHaveProperty('tokens', completed?.message.role === 'assistant'
      ? completed.message.tokens : undefined);
  });
});

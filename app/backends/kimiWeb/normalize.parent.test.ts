import { describe, expect, it } from 'vitest';
import type { AssistantMessageInfo } from '../../types/sse';
import { createKimiWebNormalizer } from './normalize';
import type { KimiWebNormalizeOp } from './ops';

const SESSION = 'session-parent';

function messagesOf(ops: readonly KimiWebNormalizeOp[]) {
  return ops
    .filter((op): op is Extract<KimiWebNormalizeOp, { kind: 'message' }> => op.kind === 'message')
    .map((op) => op.message as AssistantMessageInfo);
}

function submitPrompt(normalizer: ReturnType<typeof createKimiWebNormalizer>, promptId: string, userMessageId = promptId) {
  return normalizer.ingest({
    type: 'prompt.submitted',
    session_id: SESSION,
    payload: {
      agentId: 'main', promptId, userMessageId, sessionId: SESSION,
      content: [{ type: 'text', text: `prompt ${promptId}` }],
      createdAt: '2026-09-30T00:00:00.000Z', time: 1,
    },
  }).ops;
}

// The assistant message is created by the first utterance (turn.step.started);
// turn.started itself no longer opens a group.
function openStep(
  normalizer: ReturnType<typeof createKimiWebNormalizer>,
  agentId: string,
  turnId: number,
  stepId: string,
  time: number,
) {
  return normalizer.ingest({
    type: 'turn.step.started',
    session_id: SESSION,
    payload: { agentId, turnId, step: 1, stepId, time },
  }).ops;
}

describe('Kimi live assistant parent linkage', () => {
  it('parents a main-agent continuation turn with an unmapped promptId to the last user message', () => {
    const normalizer = createKimiWebNormalizer();
    submitPrompt(normalizer, 'prompt-1');

    normalizer.ingest({
      type: 'turn.started',
      session_id: SESSION,
      payload: { agentId: 'main', turnId: 3, promptId: 'system-prompt-no-mapping', time: 2 },
    });
    const ops = openStep(normalizer, 'main', 3, 'step-3', 3);

    const message = messagesOf(ops)[0];
    expect(message?.parentID).toBe('prompt-1');
    expect(message?.parentID).not.toBe('system-prompt-no-mapping');
  });

  it('keeps the raw promptId parent only when the session has no user message yet', () => {
    const normalizer = createKimiWebNormalizer();
    normalizer.ingest({
      type: 'turn.started',
      session_id: SESSION,
      payload: { agentId: 'main', turnId: 0, promptId: 'first-system-prompt', time: 1 },
    });
    const ops = openStep(normalizer, 'main', 0, 'step-0', 2);

    expect(messagesOf(ops)[0]?.parentID).toBe('first-system-prompt');
  });

  it('parents a subagent turn to the main-agent message that spawned it', () => {
    const normalizer = createKimiWebNormalizer();
    submitPrompt(normalizer, 'prompt-1');
    normalizer.ingest({
      type: 'turn.started',
      session_id: SESSION,
      payload: { agentId: 'main', turnId: 1, promptId: 'prompt-2', time: 2 },
    });
    normalizer.ingest({
      type: 'tool.call.started',
      session_id: SESSION,
      payload: {
        agentId: 'main', turnId: 1, toolCallId: 'task-call', name: 'Agent',
        args: { prompt: 'Answer 1+1' }, time: 3,
      },
    });
    normalizer.ingest({
      type: 'turn.started',
      session_id: SESSION,
      payload: { agentId: 'agent-0', turnId: 0, promptId: 'system-subagent', time: 4 },
    });
    normalizer.ingest({
      type: 'subagent.spawned',
      session_id: SESSION,
      payload: {
        agentId: 'main', subagentId: 'agent-0', subagentName: 'coder',
        parentToolCallId: 'task-call', sessionId: SESSION, time: 5,
      },
    });

    const ops = openStep(normalizer, 'agent-0', 0, 'sub-step', 6);

    const message = messagesOf(ops).at(-1);
    expect(message?.id).toBe(`${SESSION}:agent-0:0:agent-0:0:0`);
    expect(message?.parentID).toBe(`${SESSION}:main:1:0`);
  });

  it('falls back to the last user message when the spawning task call cannot be resolved', () => {
    const normalizer = createKimiWebNormalizer();
    submitPrompt(normalizer, 'prompt-1');
    normalizer.ingest({
      type: 'turn.started',
      session_id: SESSION,
      payload: { agentId: 'agent-0', turnId: 0, promptId: 'system-subagent', time: 2 },
    });
    const stepOps = openStep(normalizer, 'agent-0', 0, 'sub-step', 3);

    const ops = normalizer.ingest({
      type: 'subagent.spawned',
      session_id: SESSION,
      payload: {
        agentId: 'main', subagentId: 'agent-0', subagentName: 'coder',
        parentToolCallId: 'missing-call', sessionId: SESSION, time: 4,
      },
    }).ops;

    expect(messagesOf(stepOps).at(-1)?.parentID).toBe('prompt-1');
    expect(messagesOf(ops)).toHaveLength(0);
  });

  it('resolves a real parent for every assistant message over the live fixture', () => {
    const normalizer = createKimiWebNormalizer();
    const ops = [
      ...submitPrompt(normalizer, 'prompt-1'),
      ...normalizer.ingest({
        type: 'turn.started',
        session_id: SESSION,
        payload: { agentId: 'main', turnId: 0, promptId: 'prompt-1', time: 2 },
      }).ops,
      ...openStep(normalizer, 'main', 0, 'step-0', 3),
      ...normalizer.ingest({
        type: 'turn.ended',
        session_id: SESSION,
        payload: { agentId: 'main', turnId: 0, reason: 'completed', time: 4 },
      }).ops,
    ];

    const assistant = messagesOf(ops).at(-1);
    expect(assistant?.parentID).toBe('prompt-1');
  });
});

import { describe, expect, it } from 'vitest';
import {
  applyAcpAttribution,
  applyAcpSessionMeta,
  applyAcpUpdate,
  beginAcpPrompt,
  reattributeAcpEntries,
} from './history';
import { createState, WIRE_CONFIG_OPTIONS } from './historyTestHarness';

describe('ACP history agent/model attribution', () => {
  it('attributes live prompt entries from the explicit selection, not stale configOptions', () => {
    const state = createState(WIRE_CONFIG_OPTIONS);
    // User switched the selector to 'default' but the server config echo has not arrived yet.
    const [user, assistant] = beginAcpPrompt(
      state,
      [{ type: 'text', text: 'hi' }],
      1000,
      'oh-my-pi',
      { agent: 'default', modelID: 'other-model' },
    );

    if (user.info.role !== 'user') throw new Error('Expected user info');
    expect(user.info.agent).toBe('default');
    expect(user.info.model).toEqual({ providerID: 'acp', modelID: 'other-model' });
    if (assistant.info.role !== 'assistant') throw new Error('Expected assistant info');
    expect(assistant.info.mode).toBe('default');
    expect(assistant.info.modelID).toBe('other-model');
  });

  it('derives user message agent/model from current config options on prompt', () => {
    const state = createState(WIRE_CONFIG_OPTIONS);
    const [user, assistant] = beginAcpPrompt(state, [{ type: 'text', text: 'hi' }], 1000, 'oh-my-pi');

    expect(user.info.role).toBe('user');
    if (user.info.role !== 'user') throw new Error('Expected user info');
    expect(user.info.agent).toBe('build');
    expect(user.info.model).toEqual({ providerID: 'acp', modelID: 'step-plan/step-3.5-flash' });

    expect(assistant.info.role).toBe('assistant');
    if (assistant.info.role !== 'assistant') throw new Error('Expected assistant info');
    expect(assistant.info.modelID).toBe('step-plan/step-3.5-flash');
    expect(assistant.info.mode).toBe('build');
  });

  it('derives replayed message agent/model from current config options', () => {
    const state = createState(WIRE_CONFIG_OPTIONS);
    const entry = applyAcpUpdate(
      state,
      { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '你好' }, messageId: 'm1' },
      1000,
      'oh-my-pi',
    );
    expect(entry?.info.role).toBe('user');
    if (!entry || entry.info.role !== 'user') throw new Error('Expected user entry');
    expect(entry.info.agent).toBe('build');
    expect(entry.info.model.modelID).toBe('step-plan/step-3.5-flash');
  });

  it('falls back to default attribution when config options are empty', () => {
    const state = createState();
    const [user] = beginAcpPrompt(state, [{ type: 'text', text: 'hi' }], 1000, 'oh-my-pi');
    if (user.info.role !== 'user') throw new Error('Expected user info');
    expect(user.info.agent).toBe('default');
    expect(user.info.model.modelID).toBe('default');
  });
});

describe('ACP session_info_update', () => {
  it('adopts updatedAt into session info time', () => {
    const state = createState();
    applyAcpUpdate(
      state,
      { sessionUpdate: 'session_info_update', updatedAt: '2026-07-17T03:57:15.862Z' },
      1000,
      'oh-my-pi',
    );
    expect(state.info.time?.updated).toBe(Date.parse('2026-07-17T03:57:15.862Z'));
  });

  it('still applies title updates alongside updatedAt', () => {
    const state = createState();
    applyAcpUpdate(
      state,
      { sessionUpdate: 'session_info_update', title: 'renamed', updatedAt: '2026-07-17T03:57:15.862Z' },
      1000,
      'oh-my-pi',
    );
    expect(state.info.title).toBe('renamed');
    expect(state.info.time?.updated).toBe(Date.parse('2026-07-17T03:57:15.862Z'));
  });
});

describe('Kimi Code ACP thought chunks', () => {
  it('keeps one copy of each repeated wire chunk without dropping repeated prose', () => {
    const state = createState();
    applyAcpUpdate(state, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'read' } }, 1000, 'kimi-code');
    for (const text of ['Read', 'Read', ' the', ' the', ' README', ' README', ' README', ' README']) {
      applyAcpUpdate(state, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text } }, 1001, 'kimi-code');
    }
    const assistant = state.entries.find((entry) => entry.info.role === 'assistant');
    expect(assistant?.parts.find((part) => part.type === 'reasoning')).toMatchObject({ text: 'Read the README README' });
  });

  it('preserves ordinary repeated thought chunks from other ACP agents', () => {
    const state = createState();
    applyAcpUpdate(state, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'ha' } }, 1000, 'oh-my-pi');
    applyAcpUpdate(state, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'ha' } }, 1001, 'oh-my-pi');
    expect(state.entries[0]?.parts.find((part) => part.type === 'reasoning')).toMatchObject({ text: 'haha' });
  });
});

describe('reattributeAcpEntries', () => {
  it('re-attributes entries created before config options arrived', () => {
    const state = createState();
    applyAcpUpdate(state, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'q' }, messageId: 'm1' }, 1000, 'oh-my-pi');
    applyAcpUpdate(state, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' }, messageId: 'm2' }, 1000, 'oh-my-pi');

    const user = state.entries[0];
    const assistant = state.entries[1];
    if (!user || !assistant || user.info.role !== 'user' || assistant.info.role !== 'assistant') throw new Error('Unexpected roles');
    expect(user.info.model.modelID).toBe('default');

    state.configOptions = WIRE_CONFIG_OPTIONS;
    reattributeAcpEntries(state, 'oh-my-pi');

    expect(user.info.agent).toBe('build');
    expect(user.info.model).toEqual({ providerID: 'acp', modelID: 'step-plan/step-3.5-flash' });
    expect(assistant.info.modelID).toBe('step-plan/step-3.5-flash');
    expect(assistant.info.mode).toBe('build');
    expect(assistant.info.agent).toBe('build');
  });

  it('keeps agentId fallback on assistant entries when no mode config exists', () => {
    const state = createState();
    applyAcpUpdate(state, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' }, messageId: 'm2' }, 1000, 'oh-my-pi');
    const assistant = state.entries[0];
    if (!assistant || assistant.info.role !== 'assistant') throw new Error('Unexpected role');
    reattributeAcpEntries(state, 'oh-my-pi');
    expect(assistant.info.agent).toBe('oh-my-pi');
  });
});

describe('applyAcpAttribution', () => {
  it('restores recorded agent/model/created/completed over config fallback values', () => {
    const state = createState(WIRE_CONFIG_OPTIONS);
    applyAcpUpdate(state, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'q' } }, 5000, 'oh-my-pi');
    applyAcpUpdate(state, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } }, 5000, 'oh-my-pi');

    // Config fallback stamps everything with the CURRENT config (build / step-3.5-flash).
    reattributeAcpEntries(state, 'oh-my-pi');
    const user = state.entries[0];
    const assistant = state.entries[1];
    if (!user || !assistant || user.info.role !== 'user' || assistant.info.role !== 'assistant') throw new Error('Unexpected roles');
    expect(user.info.agent).toBe('build');

    applyAcpAttribution(state, {
      'acp:session-1:user:1': { agent: 'default', modelID: 'other-model', created: 1784260644000 },
      'acp:session-1:assistant:1': { agent: 'default', modelID: 'other-model', created: 1784260644200, completed: 1784260650000 },
    });

    expect(user.info.agent).toBe('default');
    expect(user.info.model).toEqual({ providerID: 'acp', modelID: 'other-model' });
    expect(user.info.time.created).toBe(1784260644000);
    expect(assistant.info.agent).toBe('default');
    expect(assistant.info.mode).toBe('default');
    expect(assistant.info.modelID).toBe('other-model');
    expect(assistant.info.time.created).toBe(1784260644200);
    expect(assistant.info.time.completed).toBe(1784260650000);
  });

  it('leaves entries without records at their config-fallback attribution', () => {
    const state = createState(WIRE_CONFIG_OPTIONS);
    applyAcpUpdate(state, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'q' } }, 5000, 'oh-my-pi');
    reattributeAcpEntries(state, 'oh-my-pi');
    applyAcpAttribution(state, {});
    const user = state.entries[0];
    if (!user || user.info.role !== 'user') throw new Error('Unexpected role');
    expect(user.info.agent).toBe('build');
    expect(user.info.time.created).toBe(5000);
  });

  it('restores recorded turn time on reasoning parts as well as the message', () => {
    const state = createState();
    applyAcpUpdate(state, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'Think' } }, 9000, 'oh-my-pi');
    applyAcpAttribution(state, {
      'acp:session-1:assistant:1': { created: 1000 },
    });
    const assistant = state.entries[0];
    expect(assistant?.info.time.created).toBe(1000);
    const thought = assistant?.parts.find((part) => part.type === 'reasoning');
    expect(thought?.type === 'reasoning' ? thought.time.start : undefined).toBe(1000);
  });
});

describe('applyAcpSessionMeta', () => {
  it('moves replayed thought and tool timestamps with the restored assistant turn', () => {
    const state = createState();
    applyAcpUpdate(state, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'read file' } }, 9000, 'oh-my-pi');
    applyAcpUpdate(state, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'I will read it.' } }, 9001, 'oh-my-pi');
    applyAcpUpdate(state, { sessionUpdate: 'tool_call', toolCallId: 'read-1', title: 'Read', kind: 'read', status: 'in_progress', rawInput: { path: 'hello.txt' } }, 9002, 'oh-my-pi');
    applyAcpUpdate(state, { sessionUpdate: 'tool_call_update', toolCallId: 'read-1', status: 'completed', rawOutput: 'hello' }, 9003, 'oh-my-pi');
    applyAcpSessionMeta(state, [{ userText: 'read file', userTime: 1000, assistantTime: 1100, assistantCompletedTime: 1200 }]);

    const assistant = state.entries.find((entry) => entry.info.role === 'assistant');
    const thought = assistant?.parts.find((part) => part.type === 'reasoning');
    const tool = assistant?.parts.find((part) => part.type === 'tool');
    expect(thought?.type === 'reasoning' ? thought.time.start : undefined).toBe(1100);
    expect(tool?.type === 'tool' && tool.state.status === 'completed' ? tool.state.time.start : undefined).toBe(1101);
  });

  it('backfills time/agent/model for entries without local records, anchored by user text', () => {
    const state = createState();
    applyAcpUpdate(state, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'kimi测试消息' } }, 9000, 'kimi-code');
    applyAcpUpdate(state, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '<system-reminder>...' } }, 9000, 'kimi-code');
    applyAcpUpdate(state, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a1' } }, 9000, 'kimi-code');
    applyAcpUpdate(state, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '第二轮' } }, 9000, 'kimi-code');
    applyAcpUpdate(state, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a2' } }, 9000, 'kimi-code');

    const restored = applyAcpAttribution(state, {
      'acp:session-1:user:1': { agent: 'plan', modelID: 'kimi-code/k3', created: 111 },
    });

    applyAcpSessionMeta(state, [
      { userText: 'kimi测试消息', userTime: 1000, assistantTime: 1005, assistantCompletedTime: 1805, model: 'kimi-code/k3', agent: 'plan' },
      { userText: '第二轮', userTime: 2000, assistantTime: 2005, assistantCompletedTime: 3205, model: 'kimi-code/k2', agent: 'yolo' },
    ], restored);

    const [user1, assistant1, user2, assistant2] = state.entries;
    if (!user1 || !assistant1 || !user2 || !assistant2 || user1.info.role !== 'user' || assistant1.info.role !== 'assistant' || user2.info.role !== 'user' || assistant2.info.role !== 'assistant') throw new Error('Unexpected entry layout');

    // Local record wins for user:1.
    expect(user1.info.agent).toBe('plan');
    expect(user1.info.time.created).toBe(111);
    // Storage meta fills everything the record does not cover.
    expect(assistant1.info.agent).toBe('plan');
    expect(assistant1.info.mode).toBe('plan');
    expect(assistant1.info.modelID).toBe('kimi-code/k3');
    expect(assistant1.info.time.created).toBe(1005);
    expect(assistant1.info.time.completed).toBe(1805);
    expect(user2.info.agent).toBe('yolo');
    expect(user2.info.model).toEqual({ providerID: 'acp', modelID: 'kimi-code/k2' });
    expect(user2.info.time.created).toBe(2000);
    expect(assistant2.info.agent).toBe('yolo');
    expect(assistant2.info.time.created).toBe(2005);
    expect(assistant2.info.time.completed).toBe(3205);
  });

  it('skips turns that do not anchor to any replayed entry', () => {
    const state = createState();
    applyAcpUpdate(state, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '第二轮' } }, 9000, 'kimi-code');
    applyAcpUpdate(state, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a2' } }, 9000, 'kimi-code');

    applyAcpSessionMeta(state, [
      { userText: '被跳过的一轮', userTime: 1000, assistantTime: 1005, model: 'm1', agent: 'plan' },
      { userText: '第二轮', userTime: 2000, assistantTime: 2005, model: 'm2', agent: 'yolo' },
    ], new Set());

    const user1 = state.entries[0];
    if (!user1 || user1.info.role !== 'user') throw new Error('Unexpected role');
    expect(user1.info.agent).toBe('yolo');
    expect(user1.info.time.created).toBe(2000);
  });
});

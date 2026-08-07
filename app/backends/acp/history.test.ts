import { describe, expect, it } from 'vitest';
import {
  applyAcpSessionMeta,
  applyAcpAttribution,
  applyAcpUpdate,
  beginAcpPrompt,
  createAcpSessionState,
  reattributeAcpEntries,
} from './history';

const WIRE_CONFIG_OPTIONS = [
  {
    id: 'model',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: 'step-plan/step-3.5-flash',
    options: [
      { value: 'step-plan/step-3.5-flash', name: 'step-3.5-flash' },
      { value: 'lm-studio/qwen3.6-28b', name: 'qwen3.6-28b' },
    ],
  },
  {
    id: 'mode',
    name: 'Mode',
    category: 'mode',
    type: 'select',
    currentValue: 'build',
    options: [
      { value: 'normal', name: 'Normal' },
      { value: 'build', name: 'Build' },
    ],
  },
  {
    id: 'thinking',
    name: 'Thinking',
    category: 'thought_level',
    type: 'select',
    currentValue: 'off',
    options: [{ value: 'off', name: 'Off' }],
  },
];

function createState(configOptions: unknown[] = []) {
  return createAcpSessionState({ id: 'session-1', title: 'session-1' }, configOptions);
}

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

describe('ACP replay ordering', () => {
  it('assigns strictly increasing created times to replayed entries sharing the same millisecond', () => {
    const state = createState();
    const now = 5000;
    applyAcpUpdate(state, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'q1' }, messageId: 'b131' }, now, 'agent');
    applyAcpUpdate(state, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a1' }, messageId: 'e21d' }, now, 'agent');
    applyAcpUpdate(state, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'q2' }, messageId: '4d50' }, now, 'agent');
    applyAcpUpdate(state, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a2' }, messageId: '9f00' }, now, 'agent');

    expect(state.entries).toHaveLength(4);
    const created = state.entries.map((entry) => entry.info.time.created);
    for (let index = 1; index < created.length; index += 1) {
      expect(created[index]).toBeGreaterThan(created[index - 1]!);
    }
    expect(state.entries.map((entry) => entry.info.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('keeps live prompt entries after replayed history times', () => {
    const state = createState();
    const loadTime = 5000;
    applyAcpUpdate(state, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old' }, messageId: 'b131' }, loadTime, 'agent');
    applyAcpUpdate(state, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old answer' }, messageId: 'e21d' }, loadTime, 'agent');

    const [user, assistant] = beginAcpPrompt(state, [{ type: 'text', text: 'new' }], 9000, 'agent');
    expect(user.info.time.created).toBeGreaterThan(state.entries[0]!.info.time.created);
    expect(assistant.info.time.created).toBeGreaterThan(user.info.time.created);
  });
});


describe('reattributeAcpEntries', () => {
  it('re-attributes entries created before config options arrived', () => {
    const state = createState();
    applyAcpUpdate(state, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'q' }, messageId: 'm1' }, 1000, 'oh-my-pi');
    applyAcpUpdate(state, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' }, messageId: 'm2' }, 1000, 'oh-my-pi');

    const user = state.entries[0]!;
    const assistant = state.entries[1]!;
    if (user.info.role !== 'user' || assistant.info.role !== 'assistant') throw new Error('Unexpected roles');
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
    const assistant = state.entries[0]!;
    if (assistant.info.role !== 'assistant') throw new Error('Unexpected role');
    reattributeAcpEntries(state, 'oh-my-pi');
    expect(assistant.info.agent).toBe('oh-my-pi');
  });
});


describe('replay entry ids', () => {
  it('uses turn-based ids matching live prompt entries, even when wire messageIds are present', () => {
    const state = createState();
    const now = 5000;
    applyAcpUpdate(state, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'q1' }, messageId: 'wire-u1' }, now, 'agent');
    applyAcpUpdate(state, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a1' }, messageId: 'wire-a1' }, now, 'agent');
    applyAcpUpdate(state, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'q2' }, messageId: 'wire-u2' }, now, 'agent');
    applyAcpUpdate(state, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a2' }, messageId: 'wire-a2' }, now, 'agent');

    expect(state.entries.map((entry) => entry.info.id)).toEqual([
      'acp:session-1:user:1',
      'acp:session-1:assistant:1',
      'acp:session-1:user:2',
      'acp:session-1:assistant:2',
    ]);
  });

  it('continues turn numbering when a live prompt follows a replay', () => {
    const state = createState();
    const now = 5000;
    applyAcpUpdate(state, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'q1' }, messageId: 'wire-u1' }, now, 'agent');
    applyAcpUpdate(state, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a1' }, messageId: 'wire-a1' }, now, 'agent');

    const [user, assistant] = beginAcpPrompt(state, [{ type: 'text', text: 'live' }], 9000, 'agent');
    expect(user.info.id).toBe('acp:session-1:user:2');
    expect(assistant.info.id).toBe('acp:session-1:assistant:2');
  });

  it('merges consecutive same-role chunks into one entry without advancing the turn', () => {
    const state = createState();
    const now = 5000;
    applyAcpUpdate(state, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'q1' }, messageId: 'wire-u1' }, now, 'agent');
    applyAcpUpdate(state, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'reminder' }, messageId: 'wire-u2' }, now, 'agent');
    applyAcpUpdate(state, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a1' }, messageId: 'wire-a1' }, now, 'agent');
    applyAcpUpdate(state, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' continued' }, messageId: 'wire-a2' }, now, 'agent');

    expect(state.entries.map((entry) => entry.info.id)).toEqual([
      'acp:session-1:user:1',
      'acp:session-1:assistant:1',
    ]);
    expect(state.entries[0]?.parts[0]).toMatchObject({ text: 'q1reminder' });
    expect(state.entries[1]?.parts[0]).toMatchObject({ text: 'a1 continued' });
  });
});


describe('applyAcpAttribution', () => {
  it('restores recorded agent/model/created/completed over config fallback values', () => {
    const state = createState(WIRE_CONFIG_OPTIONS);
    applyAcpUpdate(state, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'q' } }, 5000, 'oh-my-pi');
    applyAcpUpdate(state, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } }, 5000, 'oh-my-pi');

    // Config fallback stamps everything with the CURRENT config (build / step-3.5-flash).
    reattributeAcpEntries(state, 'oh-my-pi');
    const user = state.entries[0]!;
    const assistant = state.entries[1]!;
    if (user.info.role !== 'user' || assistant.info.role !== 'assistant') throw new Error('Unexpected roles');
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
    const user = state.entries[0]!;
    if (user.info.role !== 'user') throw new Error('Unexpected role');
    expect(user.info.agent).toBe('build');
    expect(user.info.time.created).toBe(5000);
  });
});


describe('applyAcpSessionMeta', () => {
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
      {
        userText: 'kimi测试消息',
        userTime: 1000,
        assistantTime: 1005,
        assistantCompletedTime: 1805,
        model: 'kimi-code/k3',
        agent: 'plan',
      },
      {
        userText: '第二轮',
        userTime: 2000,
        assistantTime: 2005,
        assistantCompletedTime: 3205,
        model: 'kimi-code/k2',
        agent: 'yolo',
      },
    ], restored);

    const [user1, assistant1, user2, assistant2] = state.entries;
    if (
      user1?.info.role !== 'user' ||
      assistant1?.info.role !== 'assistant' ||
      user2?.info.role !== 'user' ||
      assistant2?.info.role !== 'assistant'
    ) {
      throw new Error('Unexpected entry layout');
    }

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

    const [user1] = state.entries;
    if (user1?.info.role !== 'user') throw new Error('Unexpected role');
    expect(user1.info.agent).toBe('yolo');
    expect(user1.info.time.created).toBe(2000);
  });
});


  it('replaces info object identity so Vue reactivity observes restore-time changes', () => {
    const state = createState(WIRE_CONFIG_OPTIONS);
    applyAcpUpdate(state, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'q' } }, 5000, 'oh-my-pi');
    applyAcpUpdate(state, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'a' } }, 5000, 'oh-my-pi');

    const beforeReattribute = state.entries.map((entry) => entry.info);
    reattributeAcpEntries(state, 'oh-my-pi');
    state.entries.forEach((entry, index) => {
      expect(entry.info, `reattribute entry ${index}`).not.toBe(beforeReattribute[index]);
    });

    const beforeAttribution = state.entries.map((entry) => entry.info);
    applyAcpAttribution(state, {
      'acp:session-1:user:1': { agent: 'default', created: 42 },
    });
    expect(state.entries[0]?.info).not.toBe(beforeAttribution[0]);

    const beforeMeta = state.entries.map((entry) => entry.info);
    applyAcpSessionMeta(state, [
      { userText: 'q', userTime: 1000, assistantTime: 1005, model: 'm', agent: 'plan' },
    ], new Set());
    state.entries.forEach((entry, index) => {
      expect(entry.info, `meta entry ${index}`).not.toBe(beforeMeta[index]);
    });
  });

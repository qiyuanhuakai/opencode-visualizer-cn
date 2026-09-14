import { describe, expect, it } from 'vitest';
import {
  applyAcpAttribution,
  applyAcpSessionMeta,
  applyAcpUpdate,
  beginAcpPrompt,
  reattributeAcpEntries,
} from './history';
import { createState, WIRE_CONFIG_OPTIONS } from './historyTestHarness';

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
      expect(created[index]).toBeGreaterThan(created[index - 1]);
    }
    expect(state.entries.map((entry) => entry.info.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('keeps live prompt entries after replayed history times', () => {
    const state = createState();
    const loadTime = 5000;
    applyAcpUpdate(state, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'old' }, messageId: 'b131' }, loadTime, 'agent');
    applyAcpUpdate(state, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old answer' }, messageId: 'e21d' }, loadTime, 'agent');

    const [user, assistant] = beginAcpPrompt(state, [{ type: 'text', text: 'new' }], 9000, 'agent');
    const firstReplayEntry = state.entries[0];
    if (!firstReplayEntry) throw new Error('Expected replay entry');
    expect(user.info.time.created).toBeGreaterThan(firstReplayEntry.info.time.created);
    expect(assistant.info.time.created).toBeGreaterThan(user.info.time.created);
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

describe('ACP history Vue reactivity', () => {
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
});

import { describe, expect, it, vi } from 'vitest';
import type { KimiWebMessage, KimiWebSnapshot } from '../../utils/kimiWeb';
import { loadKimiWebHistoryEntries } from './history';
import { authoritativeEntries } from '../../composables/kimiWebMessageReconcile';
import { resolveThreadSubagentSessions } from '../../utils/threadSubagents';

const sessionId = 'parent';
const messages: KimiWebMessage[] = [
  { id: 'user', session_id: sessionId, role: 'user', content: [{ type: 'text', text: 'Inspect files' }] },
  { id: 'assistant', session_id: sessionId, role: 'assistant', content: [
    { type: 'tool_use', tool_call_id: 'swarm', tool_name: 'AgentSwarm', input: { description: 'Inspect files' } },
  ] },
];
const snapshot: KimiWebSnapshot = {
  as_of_seq: 10, epoch: 'epoch',
  session: { id: sessionId, workspace_id: 'workspace', title: 'Test', archived: false, busy: true, main_turn_active: true, pending_interaction: 'none' },
  messages: { items: [], has_more: false },
  subagents: [
    { id: 'task-1', session_id: sessionId, kind: 'subagent', agent_id: 'agent-1', parent_tool_call_id: 'swarm', description: 'Read package', status: 'running' },
    { id: 'task-2', session_id: sessionId, kind: 'subagent', agent_id: 'agent-2', parent_tool_call_id: 'swarm', description: 'Read README', status: 'running' },
    { id: 'foreign', session_id: 'other', kind: 'subagent', agent_id: 'foreign-agent', parent_tool_call_id: 'swarm' },
    { id: 'orphan', session_id: sessionId, kind: 'subagent', agent_id: 'orphan-agent', parent_tool_call_id: 'absent' },
    { id: 'shell', session_id: sessionId, kind: 'bash', parent_tool_call_id: 'swarm' },
  ],
};
const expectedCards = [
  { sessionId: 'parent:agent-1:0', label: 'Read package' },
  { sessionId: 'parent:agent-2:0', label: 'Read README' },
];

describe('Kimi unfinished subagent restoration', () => {
  it('restores pending child cards from the authoritative snapshot before tool results exist', () => {
    const entries = authoritativeEntries({ ...snapshot, messages: { items: messages } });
    expect(resolveThreadSubagentSessions(entries.flatMap((entry) => entry.parts), sessionId)).toEqual(expectedCards);
  });

  it('keeps paginated history and restores exact child links from snapshot metadata on reload', async () => {
    const result = await loadKimiWebHistoryEntries({
      sessionId,
      getMessages: async () => ({ items: messages.toReversed() }),
      getSnapshot: async () => snapshot,
    });
    expect(result.entries.map((entry) => entry.info.id)).toEqual(['user', 'assistant']);
    expect(resolveThreadSubagentSessions(result.entries.flatMap((entry) => entry.parts), sessionId)).toEqual(expectedCards);
  });

  it('discards a reload superseded while the snapshot is being fetched', async () => {
    let current = true;
    const result = await loadKimiWebHistoryEntries({
      sessionId,
      getMessages: async () => ({ items: messages.toReversed() }),
      getSnapshot: async () => { current = false; return snapshot; },
      isCurrent: () => current,
    });
    expect(result.entries).toEqual([]);
  });

  it('does not fetch a snapshot for a superseded history request', async () => {
    let current = true;
    const getSnapshot = vi.fn(async () => snapshot);
    const result = await loadKimiWebHistoryEntries({
      sessionId,
      getMessages: async () => { current = false; return { items: messages.toReversed() }; },
      getSnapshot,
      isCurrent: () => current,
    });
    expect(getSnapshot).not.toHaveBeenCalled();
    expect(result.entries).toEqual([]);
  });
});

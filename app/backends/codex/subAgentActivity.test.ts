import { describe, expect, it } from 'vitest';
import { normalizeCodexTurnItems } from './normalize';
import { codexSubagentWindowEntries } from '../../utils/codexSubagentWindowEntries';
import { resolveThreadSubagentSessions } from '../../utils/threadSubagents';

describe('Codex subAgentActivity compatibility', () => {
  it.each(['started', 'interacted', 'interrupted', 'completed'])('restores reviewer identity and activity for %s', kind => {
    const bundle = normalizeCodexTurnItems({ sessionId: 'parent', turnId: 'turn', items: [{
      type: 'subAgentActivity', id: `activity-${kind}`, kind,
      agentThreadId: 'review-child', agentPath: '/root/code_review',
    }] });
    const part = bundle.parts.find(part => part.type === 'tool');
    const info = bundle.messages.find(info => info.role === 'assistant');
    expect(part).toMatchObject({ tool: 'task', state: { metadata: { sessionId: 'review-child' } } });
    expect(resolveThreadSubagentSessions(bundle.parts, 'parent')).toEqual([
      { sessionId: 'review-child', label: 'code_review' },
    ]);
    if (!part || !info) throw new Error('Missing reviewer activity');
    const entries = codexSubagentWindowEntries(info, part);
    expect(entries[0]?.info).toMatchObject({ sessionID: 'review-child', agent: 'code_review' });
    expect(entries[0]?.part.text).toContain('code_review');
    expect(entries[0]?.part.text).not.toContain('/root/');
    expect(Boolean(entries[0]?.part.time?.end)).toBe(kind === 'completed' || kind === 'interrupted');
  });
});

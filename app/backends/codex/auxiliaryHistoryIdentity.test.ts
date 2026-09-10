import { describe, expect, it } from 'vitest';
import { migrateCodexAuxiliaryHistory } from './auxiliaryHistoryIdentity';
import { normalizeCodexTurnsToHistory, type CodexCanonicalHistoryEntry } from './normalize';

function fixture() {
  const canonical = normalizeCodexTurnsToHistory({ sessionId: 's', turns: [{ id: 'turn', items: [
    { id: 'wire-a', type: 'userMessage', content: [{ type: 'text', text: 'A' }] },
    { id: 'reason-a', type: 'reasoning', summary: ['Think A'] },
    { id: 'wire-b', type: 'userMessage', content: [{ type: 'text', text: 'B' }] },
    { id: 'tool-b', type: 'commandExecution', command: 'echo B', status: 'completed' },
  ] }] });
  const assistant = canonical.find(entry => entry.info.role === 'assistant');
  if (!assistant || assistant.info.role !== 'assistant') throw new Error('Missing fixture assistant');
  const cached: CodexCanonicalHistoryEntry[] = [{
    info: { ...assistant.info, id: 'turn:assistant', parentID: 'turn:user:1' },
    parts: canonical.flatMap(entry => entry.parts).filter(part => part.type === 'tool' || part.type === 'reasoning')
      .map(part => ({ ...part, messageID: 'turn:assistant' })),
  }];
  return { canonical, cached };
}

describe('cached Codex auxiliary identity migration', () => {
  it('splits legacy shared assistants and maps their known ordinal parent to a canonical user', () => {
    const { canonical, cached } = fixture();
    const migrated = migrateCodexAuxiliaryHistory(cached, canonical);
    expect(migrated.map(entry => entry.info.id)).toEqual(['turn:assistant:reason-a', 'turn:assistant:tool-b']);
    expect(migrated.map(entry => entry.info.role === 'assistant' && entry.info.parentID)).toEqual(['turn:user:wire-b', 'turn:user:wire-b']);
    expect(migrated.every(entry => entry.parts.length === 1 && entry.parts[0]?.messageID === entry.info.id)).toBe(true);
    expect(cached[0]?.info.id).toBe('turn:assistant');
  });

  it('preserves new IDs and parents and does not guess missing legacy parent mappings', () => {
    const { canonical, cached } = fixture();
    expect(migrateCodexAuxiliaryHistory(canonical, canonical)).toEqual(canonical);
    const migrated = migrateCodexAuxiliaryHistory(cached, []);
    expect(migrated.every(entry => entry.info.role === 'assistant' && entry.info.parentID === 'turn:user:1')).toBe(true);
  });
});

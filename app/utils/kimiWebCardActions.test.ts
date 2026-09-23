import { describe, expect, it, vi } from 'vitest';
import { createKimiWebCardActions } from './kimiWebCardActions';

function fixture() {
  const client = {
    getSessionStatus: vi.fn().mockResolvedValue({ busy: false }),
    getMessages: vi.fn().mockResolvedValue({ has_more: false, items: [
      { id: 'third', role: 'user' },
      { id: 'steer', role: 'user', metadata: { origin: { kind: 'user', inTurn: true } } },
      { id: 'second', role: 'user' }, { id: 'first', role: 'user' },
    ] }),
    forkSession: vi.fn().mockResolvedValue({ id: 'clone' }),
    deleteSession: vi.fn().mockResolvedValue({}), undoSession: vi.fn().mockResolvedValue({}),
    getTranscript: vi.fn().mockResolvedValue({ has_more: false, items: [{ kind: 'turn', ordinal: 7, triggerPromptId: 'second', turnId: 't7' }] }),
    getTurnFileChanges: vi.fn().mockResolvedValue({ recorded: true, changes: [{ path: 'a.txt', status: 'modified' }] }),
    getTurnFileContent: vi.fn().mockImplementation((_id, _turn, _file, phase) => Promise.resolve({ content: { content: phase === 'start' ? 'old' : 'new' } })),
  };
  return { client, actions: createKimiWebCardActions(client) };
}
describe('Kimi Web card checkpoints', () => {
  it('forks before selected user anchor and excludes in-turn steering', async () => {
    const { client, actions } = fixture();
    await expect(actions.forkSessionAtMessage('source', 'second')).resolves.toEqual({ id: 'clone' });
    expect(client.getMessages).toHaveBeenCalledWith('clone', expect.anything());
    expect(client.undoSession).toHaveBeenCalledWith('clone', 2);
    expect(client.deleteSession).not.toHaveBeenCalled();
  });
  it('cleans only its clone when checkpoint creation fails', async () => {
    const { client, actions } = fixture(); client.undoSession.mockRejectedValue(new Error('undo failed'));
    await expect(actions.forkSessionAtMessage('source', 'second')).rejects.toThrow('undo failed');
    expect(client.deleteSession).toHaveBeenCalledWith('clone');
  });
  it('refuses crossing a compaction boundary before mutation', async () => {
    const { client, actions } = fixture();
    client.getMessages.mockResolvedValue({ has_more: false, items: [{ id: 'summary', role: 'user', metadata: { origin: { kind: 'compaction_summary' } } }, { id: 'first', role: 'user' }] });
    await expect(actions.undoSessionFromMessage('source', 'first')).rejects.toThrow(/compaction/i);
    expect(client.undoSession).not.toHaveBeenCalled();
  });
  it('refuses busy sessions', async () => {
    const { client, actions } = fixture(); client.getSessionStatus.mockResolvedValue({ busy: true });
    await expect(actions.undoSessionFromMessage('source', 'second')).rejects.toThrow(/busy/i);
    expect(client.undoSession).not.toHaveBeenCalled();
  });
  it('maps actual transcript ordinal to recorded before and after snapshots', async () => {
    const { client, actions } = fixture();
    await expect(actions.loadMessageDiffs('source', 'second')).resolves.toEqual([{ file: 'a.txt', diff: '', before: 'old', after: 'new' }]);
    expect(client.getTurnFileChanges).toHaveBeenCalledWith('source', 7);
  });
  it('maps old message checkpoints to turns without trigger IDs', async () => {
    const { client, actions } = fixture();
    client.getTranscript.mockResolvedValue({ has_more: false, items: [
      { kind: 'turn', ordinal: 0, turnId: 't0' },
      { kind: 'turn', ordinal: 1, turnId: 't1' },
      { kind: 'turn', ordinal: 2, turnId: 't2', triggerPromptId: 'third' },
    ] });
    await actions.loadMessageDiffs('source', 'first');
    expect(client.getTurnFileChanges).toHaveBeenCalledWith('source', 0);
  });
  it('shows no diff when the turn has no recorded file snapshots', async () => {
    const { client, actions } = fixture();
    client.getTurnFileChanges.mockResolvedValue({ recorded: false, changes: [] });
    await expect(actions.loadMessageDiffs('source', 'second')).resolves.toEqual([]);
    await expect(actions.hasMessageDiffs('source', 'second')).resolves.toBe(false);
    expect(client.getTurnFileContent).not.toHaveBeenCalled();
  });
  it('does not invent content for missing modified-file snapshots', async () => {
    const { client, actions } = fixture(); client.getTurnFileContent.mockResolvedValue({ content: null });
    await expect(actions.loadMessageDiffs('source', 'second')).rejects.toThrow(/snapshot/i);
  });
});

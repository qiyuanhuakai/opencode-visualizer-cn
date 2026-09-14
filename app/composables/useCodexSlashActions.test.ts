import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { useCodexApi } from './useCodexApi';
import { useCodexSlashActions } from './useCodexSlashActions';
import { createAdapterMock, resetCodexApiTestState } from './useCodexApi.test-helpers';
import { normalizeCodexTurnsToHistory } from '../backends/codex/normalize';

function fixture() {
  const mock = createAdapterMock();
  const api = useCodexApi({ adapterFactory: () => mock.adapter });
  const actions = {
    api, locale: ref('en'), messageInput: ref(''), selectedSessionId: ref('thr_existing'), selectedModel: ref('model'), selectedMode: ref('default'),
    openMonitor: vi.fn(), openModel: vi.fn(), openPermissions: vi.fn(), openSide: vi.fn(), openGoal: vi.fn(),
    openSessions: vi.fn(), openAgents: vi.fn(), openTerminals: vi.fn(), openDiff: vi.fn(async () => {}),
    createSession: vi.fn(async () => ({ id: 'new-thread' })), archiveSession: vi.fn(async () => {}),
    renameSession: vi.fn(async () => {}), selectSession: vi.fn(async () => {}), selectMode: vi.fn(),
    showPrompt: vi.fn(async () => null), status: vi.fn(),
  };
  return { ...useCodexSlashActions(actions), actions, api, mock };
}

describe('Codex slash actions', () => {
  beforeEach(resetCodexApiTestState);

  it.each(['skills', 'mcp', 'plugins'] as const)('opens the %s status tab even while disconnected', async (name) => {
    const f = fixture();
    await f.execute({ name, arguments: '' });
    expect(f.actions.openMonitor).toHaveBeenCalledWith(name);
    expect(f.mock.adapter.sendPrompt).not.toHaveBeenCalled();
  });

  it.each(['daily', 'weekly', 'cumulative'] as const)('routes account %s usage to Token', async (view) => {
    const f = fixture();
    await f.execute({ name: 'usage', arguments: view });
    expect(f.actions.openMonitor).toHaveBeenCalledWith('token', view);
  });

  it('rejects unsupported usage actions without silently executing another operation', async () => {
    const f = fixture();
    await expect(f.execute({ name: 'usage', arguments: 'reset' })).rejects.toThrow();
    expect(f.actions.openMonitor).not.toHaveBeenCalled();
  });

  it('toggles Fast from default to the catalog tier and back', async () => {
    const f = fixture();
    await f.api.connect();
    f.api.models.value = [{ id: 'model', model: 'model', displayName: 'Model', serviceTiers: [{ id: 'priority', name: 'Fast', description: '' }] }];
    f.api.selectModel('previous-model');
    f.mock.adapter.writeConfigValue = vi.fn().mockResolvedValue({});
    f.mock.adapter.readConfig = vi.fn().mockResolvedValue({ config: {} });
    await f.execute({ name: 'fast', arguments: '' });
    expect(f.api.selectedServiceTier.value).toBe('priority');
    await f.execute({ name: 'fast', arguments: '' });
    expect(f.api.selectedServiceTier.value).toBe('default');
  });

  it('expands init from the byte-identical official prompt asset', async () => {
    const f = fixture();
    await f.api.connect();
    const source = readFileSync('app/assets/codex/prompt_for_init_command.md');
    const blob = createHash('sha1').update(`blob ${source.length}\0`).update(source).digest('hex');
    expect(blob).toBe('e96b002df7944166dd6c213cbed0783aa4b83e14');
    await expect(f.execute({ name: 'init', arguments: '' })).resolves.toBe('not-handled');
    expect(Buffer.from(f.actions.messageInput.value)).toEqual(source);
  });

  it('sets the advertised Plan mode and forwards only inline task input', async () => {
    const f = fixture();
    await f.api.connect();
    f.api.collaborationModes.value = [{ name: 'Plan', mode: 'plan' }];
    await expect(f.execute({ name: 'plan', arguments: 'task\nsecond line' })).resolves.toBe('not-handled');
    expect(f.actions.selectMode).toHaveBeenCalledWith('plan');
    expect(f.actions.messageInput.value).toBe('task\nsecond line');
  });

  it('does not replace the composer when init is requested during an active turn', async () => {
    const f = fixture();
    await f.api.connect();
    f.api.activeTurn.value = { id: 'active', status: 'inProgress' };
    f.actions.messageInput.value = '/init';
    await expect(f.execute({ name: 'init', arguments: '' })).rejects.toThrow();
    expect(f.actions.messageInput.value).toBe('/init');
  });

  it.each(['default', 'plan'])('toggles Plan from %s without sending a turn', async (mode) => {
    const f = fixture();
    await f.api.connect();
    f.api.collaborationModes.value = [{ name: 'Plan', mode: 'plan' }, { name: 'Default', mode: 'default' }];
    f.actions.selectedMode.value = mode;
    await f.execute({ name: 'plan', arguments: '' });
    expect(f.actions.selectMode).toHaveBeenCalledWith(mode === 'plan' ? 'default' : 'plan');
    expect(f.mock.adapter.sendPrompt).not.toHaveBeenCalled();
  });

  it('allows switching the next message mode while a turn is active', async () => {
    const f = fixture();
    await f.api.connect();
    f.api.collaborationModes.value = [{ name: 'Plan', mode: 'plan' }];
    f.api.activeTurn.value = { id: 'running', status: 'inProgress' };
    await f.execute({ name: 'plan', arguments: '' });
    expect(f.actions.selectMode).toHaveBeenCalledWith('plan');
    expect(f.mock.adapter.sendPrompt).not.toHaveBeenCalled();
  });

  it('archives through the native Codex endpoint and selects the remaining thread', async () => {
    const f = fixture();
    await f.api.connect();
    f.api.activeThreadId.value = 'thr_existing';
    await f.execute({ name: 'archive', arguments: '' });
    expect(f.mock.adapter.archiveThread).toHaveBeenCalledWith({ threadId: 'thr_existing' });
    expect(f.actions.selectSession).toHaveBeenCalledWith('');
    expect(f.actions.archiveSession).not.toHaveBeenCalled();
  });

  it('copies the latest completed realtime response rather than stale hydrated history', async () => {
    const f = fixture();
    await f.api.connect();
    f.api.activeThreadId.value = 'thr_existing';
    const history = (id: string, text: string) => normalizeCodexTurnsToHistory({ sessionId: 'thr_existing', turns: [{ id, status: 'completed', items: [{ id: `${id}-answer`, type: 'agentMessage', text }] }] });
    f.api.canonicalHistory.value = history('old', 'OLD');
    f.api.realtimeHistoryQueue.value = history('latest', 'LATEST');
    const writeText = vi.fn(async () => {});
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    try {
      await f.execute({ name: 'copy', arguments: '' });
      expect(writeText).toHaveBeenCalledWith('LATEST');
    } finally { vi.unstubAllGlobals(); }
  });
});

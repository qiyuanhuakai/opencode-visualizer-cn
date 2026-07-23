import { describe, expect, it, vi } from 'vitest';

import { useAcpBridge } from './useAcpBridge';

const runningAgent = {
  id: 'oh-my-pi',
  name: 'Oh My Pi',
  command: 'omp',
  args: ['--mode', 'acp'],
  enabled: true,
  state: 'running',
  owned: true,
  connected: false,
  droppedFrames: 0,
};
const adoptedOpenCode = {
  id: 'opencode',
  name: 'OpenCode Server',
  command: 'opencode',
  args: ['serve', '--hostname', '127.0.0.1', '--port', '4096'],
  state: 'adopted',
  owned: false,
};
const supervisorStatus = { services: [adoptedOpenCode], acpAgents: [runningAgent] };

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('useAcpBridge', () => {
  it('loads typed ACP status from the configured bridge with auth', async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse(supervisorStatus));
    const api = useAcpBridge({
      fetcher,
      bridgeUrl: 'ws://localhost:23004',
      bridgeToken: 'secret-token',
    });

    await api.refresh();

    expect(fetcher).toHaveBeenCalledWith('http://localhost:23004/api/v1/supervisor', {
      headers: { Authorization: 'Bearer secret-token' },
    });
    expect(api.agents.value).toEqual([runningAgent]);
    expect(api.services.value).toEqual([adoptedOpenCode]);
    expect(api.bridgeAvailable.value).toBe(true);
    expect(api.error.value).toBe('');
  });

  it('updates user settings and replaces the matching runtime status', async () => {
    const disabledAgent = { ...runningAgent, enabled: false, state: 'disabled', owned: false };
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(supervisorStatus))
      .mockResolvedValueOnce(jsonResponse(disabledAgent));
    const api = useAcpBridge({ fetcher, bridgeUrl: 'ws://localhost:23004' });
    await api.refresh();

    await api.updateAgent('oh-my-pi', { enabled: false });

    expect(fetcher).toHaveBeenLastCalledWith('http://localhost:23004/api/v1/agents/oh-my-pi', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });
    expect(api.agents.value).toEqual([disabledAgent]);
  });

  it('reports an unavailable bridge without retaining stale status', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(supervisorStatus))
      .mockRejectedValueOnce(new Error('connection refused'));
    const api = useAcpBridge({ fetcher, bridgeUrl: 'ws://localhost:23004' });
    await api.refresh();

    await api.refresh();

    expect(api.agents.value).toEqual([]);
    expect(api.services.value).toEqual([]);
    expect(api.bridgeAvailable.value).toBe(false);
    expect(api.error.value).toBe('connection refused');
  });
});

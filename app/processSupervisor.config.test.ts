import { describe, expect, it, vi } from 'vitest';

import { createProcessSupervisor } from '../bridge/processSupervisor.js';

describe('native service config', () => {
  it('reports disabled native services without probing credentials, ports, or executables', async () => {
    const spawnProcess = vi.fn();
    const probeService = vi.fn();
    const probeKimiWebHealth = vi.fn();
    const kimiWebTokenProvider = { getAuthorization: vi.fn() };
    const probeDshWebFence = vi.fn();
    const dshVersionProbe = vi.fn();
    const dshExchange = vi.fn();
    const supervisor = createProcessSupervisor({
      spawnProcess,
      probeService,
      probeKimiWebHealth,
      kimiWebTokenProvider,
      probeDshWebFence,
      dshVersionProbe,
      dshExchange,
    });

    await supervisor.start({ opencode: false, codex: false, 'kimi-web': false, dsh: false });

    expect(supervisor.getStatus().map(({ state }) => state)).toEqual([
      'disabled', 'disabled', 'disabled', 'disabled',
    ]);
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(probeService).not.toHaveBeenCalled();
    expect(probeKimiWebHealth).not.toHaveBeenCalled();
    expect(kimiWebTokenProvider.getAuthorization).not.toHaveBeenCalled();
    expect(probeDshWebFence).not.toHaveBeenCalled();
    expect(dshVersionProbe).not.toHaveBeenCalled();
    expect(dshExchange).not.toHaveBeenCalled();
    await supervisor.stop();
    expect(supervisor.getStatus().map(({ state }) => state)).toEqual([
      'disabled', 'disabled', 'disabled', 'disabled',
    ]);
  });
});

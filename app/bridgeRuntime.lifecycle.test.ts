import { describe, expect, it, vi } from 'vitest';

import { createBridgeRuntime } from '../bridge/bridgeRuntime.js';

const agent = {
  id: 'queued',
  name: 'Queued ACP',
  command: process.execPath,
  args: ['-e', ''],
  enabled: true,
};

describe('bridge runtime lifecycle', () => {
  it('closes mutation admission and drains accepted config work before stopping managers', async () => {
    let finishSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      finishSave = resolve;
    });
    const config = { version: 1 as const, acpAgents: [agent] };
    const upsertAgent = vi.fn(async () => {
      if (upsertAgent.mock.calls.length === 1) await saveGate;
      return config;
    });
    const events: string[] = [];
    const acpManager = {
      reconcile: vi.fn(async (value: typeof config.acpAgents) => {
        if (value.length) events.push('reconcile');
        return [];
      }),
      stopAll: vi.fn(async () => {
        events.push('acp-stop');
      }),
      getStatus: vi.fn(() => []),
      attach: vi.fn(),
    };
    const runtime = createBridgeRuntime({
      configStore: {
        configPath: '/tmp/bridge-runtime-lifecycle.json',
        load: vi.fn(async () => ({ version: 1 as const, acpAgents: [] })),
        save: vi.fn(async () => config),
        getConfig: vi.fn(async () => config),
        upsertAgent,
        removeAgent: vi.fn(async () => config),
      },
      nativeSupervisor: {
        start: vi.fn(async () => []),
        stop: vi.fn(async () => {
          events.push('native-stop');
        }),
        getStatus: vi.fn(() => []),
      },
      acpManager,
      clientMethodHandler: Object.assign(vi.fn(async () => ({})), {
        observeClientMessage: vi.fn(),
        observeAgentMessage: vi.fn(),
        releaseAgent: vi.fn(async () => {}),
        resumeAgent: vi.fn(),
        stopAll: vi.fn(async () => {
          events.push('client-stop');
        }),
      }),
    });
    await runtime.start();
    const accepted = runtime.upsertAgent(agent);
    await vi.waitFor(() => expect(upsertAgent).toHaveBeenCalledOnce());

    const stopping = runtime.stop();
    await expect(runtime.upsertAgent({ ...agent, id: 'late' })).rejects.toThrow(
      'Bridge runtime is shutting down',
    );
    expect(acpManager.stopAll).not.toHaveBeenCalled();
    finishSave();
    await accepted;
    await stopping;

    expect(events.indexOf('reconcile')).toBeLessThan(events.indexOf('acp-stop'));
    expect(events.indexOf('acp-stop')).toBeLessThan(events.indexOf('client-stop'));
  });

  it('keeps mutation admission closed when startup fails', async () => {
    const configStore = {
      configPath: '/tmp/bridge-runtime-start-failure.json',
      load: vi.fn(async () => ({ version: 1 as const, acpAgents: [] })),
      save: vi.fn(),
      getConfig: vi.fn(async () => ({ version: 1 as const, acpAgents: [] })),
      upsertAgent: vi.fn(),
      removeAgent: vi.fn(),
    };
    const nativeStop = vi.fn();
    const acpStop = vi.fn();
    const runtime = createBridgeRuntime({
      configStore,
      nativeSupervisor: {
        start: vi.fn(async () => {
          throw new Error('native startup failed');
        }),
        stop: nativeStop,
        getStatus: vi.fn(() => []),
      },
      acpManager: {
        reconcile: vi.fn(),
        stopAll: acpStop,
        getStatus: vi.fn(() => []),
        attach: vi.fn(),
      },
    });

    await expect(runtime.start()).rejects.toThrow('native startup failed');
    await expect(runtime.upsertAgent(agent)).rejects.toThrow('shutting down');
    await runtime.stop();

    expect(configStore.upsertAgent).not.toHaveBeenCalled();
    expect(nativeStop).toHaveBeenCalledOnce();
    expect(acpStop).toHaveBeenCalledOnce();
  });
});

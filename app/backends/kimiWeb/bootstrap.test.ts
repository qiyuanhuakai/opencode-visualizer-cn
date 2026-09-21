import { describe, expect, it, vi } from 'vitest';
import type { KimiWebClient, KimiWebSession } from '../../utils/kimiWeb';
import type { KimiWebWsClient } from '../../utils/kimiWebWs';
import { bootstrapKimiWebWorkspace, type KimiWebBootstrapBridge } from './bootstrap';
import { createKimiWebAdapter } from './kimiWebAdapter';

function rawSession(): KimiWebSession {
  return {
    id: 'session-1',
    workspace_id: 'workspace-1',
    title: 'Existing',
    busy: false,
    main_turn_active: false,
    pending_interaction: 'none',
    archived: false,
    metadata: { cwd: '/work/repo' },
    agent_config: { model: 'kimi-k2' },
  };
}

function restClient(items: KimiWebSession[]) {
  return {
    getMeta: vi.fn(async () => ({ server_version: '1', capabilities: {} })),
    getAuth: vi.fn(async () => ({ models_ready: true })),
    listModels: vi.fn(async () => ({ items: [] })),
    listSessions: vi.fn(async () => ({ items })),
    getMessages: vi.fn(async () => ({ items: [] })),
  } as unknown as KimiWebClient;
}

function transport() {
  return {
    connect: vi.fn(async () => undefined),
    disconnect: vi.fn(),
  } as unknown as KimiWebWsClient;
}

function messageBridge() {
  return {
    subscribe: vi.fn(async () => ({})),
    applyHistory: vi.fn(),
    stop: vi.fn(),
  } satisfies KimiWebBootstrapBridge;
}

describe('bootstrapKimiWebWorkspace', () => {
  it('commits, selects, hydrates, and subscribes an existing workspace session', async () => {
    const adapter = createKimiWebAdapter({
      bridgeUrl: 'ws://localhost:23004/kimi-web/ws',
      client: restClient([rawSession()]),
    });
    const client = transport();
    const bridge = messageBridge();
    const commit = vi.fn();

    const result = await bootstrapKimiWebWorkspace({
      adapter,
      isCurrent: () => true,
      createClient: () => client,
      createBridge: () => bridge,
      commit,
    });

    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({
        selectedProjectId: 'workspace-1',
        selectedSessionId: 'session-1',
        selectedModel: 'kimi-k2',
      }),
    );
    expect(bridge.applyHistory).toHaveBeenCalledWith([]);
    expect(bridge.subscribe).toHaveBeenCalledWith(['session-1']);
    expect(result).toEqual({ client, bridge });
  });

  it('commits an empty tree without opening a websocket', async () => {
    const adapter = createKimiWebAdapter({
      bridgeUrl: 'ws://localhost:23004/kimi-web/ws',
      client: restClient([]),
    });
    const createClient = vi.fn(transport);
    const commit = vi.fn();

    await bootstrapKimiWebWorkspace({
      adapter,
      isCurrent: () => true,
      createClient,
      createBridge: messageBridge,
      commit,
    });

    expect(createClient).not.toHaveBeenCalled();
    expect(commit).toHaveBeenCalledWith({
      projects: {},
      selectedProjectId: '',
      selectedSessionId: '',
      selectedModel: '',
    });
  });

  it('disposes the transport and discards commit when a backend switch interrupts bootstrap', async () => {
    let current = true;
    let finishConnect: (() => void) | undefined;
    const adapter = createKimiWebAdapter({
      bridgeUrl: 'ws://localhost:23004/kimi-web/ws',
      client: restClient([rawSession()]),
    });
    const client = transport();
    client.connect = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishConnect = resolve;
        }),
    );
    const bridge = messageBridge();
    const commit = vi.fn();
    const pending = bootstrapKimiWebWorkspace({
      adapter,
      isCurrent: () => current,
      createClient: () => client,
      createBridge: () => bridge,
      commit,
    });
    await vi.waitFor(() => expect(finishConnect).toBeTypeOf('function'));

    current = false;
    finishConnect?.();
    await pending;

    expect(commit).not.toHaveBeenCalled();
    expect(bridge.stop).toHaveBeenCalledOnce();
    expect(client.disconnect).toHaveBeenCalledOnce();
  });
});

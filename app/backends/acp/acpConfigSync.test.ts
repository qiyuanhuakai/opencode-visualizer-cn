import { beforeEach, describe, expect, it } from 'vitest';

import { createAcpAdapter } from './acpAdapter';

type ListenerMap = {
  open: Array<() => void>;
  message: Array<(event: { data: unknown }) => void>;
  error: Array<() => void>;
  close: Array<(event: { code?: number; reason?: string }) => void>;
};

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  readyState = 0;
  readonly sent: string[] = [];
  private listeners: ListenerMap = { open: [], message: [], error: [], close: [] };

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    MockWebSocket.instances.push(this);
  }

  addEventListener<T extends keyof ListenerMap>(type: T, handler: ListenerMap[T][number]) {
    this.listeners[type].push(handler as never);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {}

  open() {
    this.readyState = 1;
    this.listeners.open.forEach((handler) => handler());
  }

  receive(message: unknown) {
    this.listeners.message.forEach((handler) => handler({ data: JSON.stringify(message) }));
  }
}

function message(socket: MockWebSocket, index: number) {
  return JSON.parse(socket.sent[index] ?? '{}') as Record<string, unknown>;
}

describe('ACP config synchronization', () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
  });

  it('applies model, mode, and thought-level selections before prompting', async () => {
    const adapter = createAcpAdapter({
      url: 'ws://localhost/acp/test',
      agentId: 'test',
      webSocketCtor: MockWebSocket,
    });
    const initializing = adapter.initialize();
    const socket = MockWebSocket.instances[0]!;
    socket.open();
    await Promise.resolve();
    socket.receive({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: 'test', version: '1' },
      },
    });
    await initializing;
    const creating = adapter.createSession('/workspace');
    await expect.poll(() => socket.sent.length).toBe(2);
    socket.receive({
      jsonrpc: '2.0',
      id: 2,
      result: {
        sessionId: 'session-1',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'model-a',
            options: [
              { value: 'model-a', name: 'Model A' },
              { value: 'model-b', name: 'Model B' },
            ],
          },
          {
            id: 'mode',
            name: 'Mode',
            category: 'mode',
            type: 'select',
            currentValue: 'default',
            options: [
              { value: 'default', name: 'Default' },
              { value: 'plan', name: 'Plan' },
            ],
          },
          {
            id: 'thinking',
            name: 'Thinking',
            category: 'thought_level',
            type: 'select',
            currentValue: 'off',
            options: [
              { value: 'off', name: 'Off' },
              { value: 'high', name: 'High' },
            ],
          },
        ],
      },
    });
    await creating;

    const prompting = adapter.sendPromptAsync('session-1', {
      directory: '/workspace',
      agent: 'plan',
      model: { providerID: 'acp', modelID: 'model-b' },
      variant: 'high',
      parts: [{ type: 'text', text: 'hello' }],
    });
    const expected = [
      { id: 3, params: { sessionId: 'session-1', configId: 'model', value: 'model-b' } },
      { id: 4, params: { sessionId: 'session-1', configId: 'mode', value: 'plan' } },
      { id: 5, params: { sessionId: 'session-1', configId: 'thinking', value: 'high' } },
    ];
    for (const item of expected) {
      await expect.poll(() => socket.sent.length).toBe(item.id);
      expect(message(socket, item.id - 1)).toEqual({
        jsonrpc: '2.0',
        id: item.id,
        method: 'session/set_config_option',
        params: item.params,
      });
      socket.receive({ jsonrpc: '2.0', id: item.id, result: {} });
    }
    await expect.poll(() => socket.sent.length).toBe(6);
    expect(message(socket, 5)).toEqual(expect.objectContaining({ method: 'session/prompt' }));
    socket.receive({ jsonrpc: '2.0', id: 6, result: { stopReason: 'end_turn' } });
    await prompting;
  });

  it('syncSessionConfig immediately pushes selection changes to the agent outside prompting', async () => {
    const adapter = createAcpAdapter({
      url: 'ws://localhost/acp/test',
      agentId: 'test',
      webSocketCtor: MockWebSocket,
    });
    const initializing = adapter.initialize();
    const socket = MockWebSocket.instances[0]!;
    socket.open();
    await Promise.resolve();
    socket.receive({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: 1,
        agentCapabilities: {},
        agentInfo: { name: 'test', version: '1' },
      },
    });
    await initializing;
    const creating = adapter.createSession('/workspace');
    await expect.poll(() => socket.sent.length).toBe(2);
    socket.receive({
      jsonrpc: '2.0',
      id: 2,
      result: {
        sessionId: 'session-1',
        configOptions: [
          {
            id: 'model',
            name: 'Model',
            category: 'model',
            type: 'select',
            currentValue: 'model-a',
            options: [
              { value: 'model-a', name: 'Model A' },
              { value: 'model-b', name: 'Model B' },
            ],
          },
          {
            id: 'mode',
            name: 'Mode',
            category: 'mode',
            type: 'select',
            currentValue: 'default',
            options: [
              { value: 'default', name: 'Default' },
              { value: 'plan', name: 'Plan' },
            ],
          },
          {
            id: 'thinking',
            name: 'Thinking',
            category: 'thought_level',
            type: 'select',
            currentValue: 'off',
            options: [
              { value: 'off', name: 'Off' },
              { value: 'high', name: 'High' },
            ],
          },
        ],
      },
    });
    await creating;

    const syncing = adapter.syncSessionConfig('session-1', {
      model: 'model-b',
      mode: 'plan',
      thoughtLevel: 'high',
    });
    const expected = [
      { id: 3, params: { sessionId: 'session-1', configId: 'model', value: 'model-b' } },
      { id: 4, params: { sessionId: 'session-1', configId: 'mode', value: 'plan' } },
      { id: 5, params: { sessionId: 'session-1', configId: 'thinking', value: 'high' } },
    ];
    for (const item of expected) {
      await expect.poll(() => socket.sent.length).toBe(item.id);
      expect(message(socket, item.id - 1)).toEqual({
        jsonrpc: '2.0',
        id: item.id,
        method: 'session/set_config_option',
        params: item.params,
      });
      socket.receive({ jsonrpc: '2.0', id: item.id, result: {} });
    }
    await syncing;

    // Local config options reflect the synced values so re-hydration is a no-op.
    const options = adapter.getSessionConfigOptions() as Array<{ id: string; currentValue: string }>;
    expect(options.find((option) => option.id === 'model')?.currentValue).toBe('model-b');
    expect(options.find((option) => option.id === 'mode')?.currentValue).toBe('plan');
    expect(options.find((option) => option.id === 'thinking')?.currentValue).toBe('high');
  });
});

import { createAcpAdapter } from './acpAdapter';
import type { AcpClientOptions } from './acpClientTypes';

type ListenerMap = {
  open: Array<() => void>;
  message: Array<(event: { data: unknown }) => void>;
  error: Array<() => void>;
  close: Array<(event: { code?: number; reason?: string }) => void>;
};

export class MockAcpWebSocket {
  static instances: MockAcpWebSocket[] = [];
  readyState = 0;
  readonly sent: string[] = [];
  private readonly listeners: ListenerMap = { open: [], message: [], error: [], close: [] };

  constructor(readonly url: string) {
    MockAcpWebSocket.instances.push(this);
  }

  addEventListener<T extends keyof ListenerMap>(type: T, listener: ListenerMap[T][number]) {
    this.listeners[type].push(listener as never);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    for (const listener of this.listeners.close) listener({});
  }

  open() {
    this.readyState = 1;
    for (const listener of this.listeners.open) listener();
  }

  fail() {
    for (const listener of this.listeners.error) listener();
  }

  receive(message: unknown) {
    for (const listener of this.listeners.message) listener({ data: JSON.stringify(message) });
  }
}

export function sent(socket: MockAcpWebSocket, index: number) {
  return JSON.parse(socket.sent[index] ?? '{}') as Record<string, unknown>;
}

export async function initializeAdapter() {
  const adapter = createAcpAdapter({
    url: 'ws://localhost:23004/acp/oh-my-pi?token=secret',
    agentId: 'oh-my-pi',
    now: () => 1_700_000_000_000,
    webSocketCtor: MockAcpWebSocket,
  });
  const initializing = adapter.initialize();
  const socket = MockAcpWebSocket.instances[0];
  if (!socket) throw new Error('Expected ACP WebSocket instance.');
  socket.open();
  await Promise.resolve();
  socket.receive({
    jsonrpc: '2.0',
    id: 1,
    result: {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
        sessionCapabilities: { list: {} },
      },
      agentInfo: { name: 'oh-my-pi', title: 'Oh My Pi', version: '14.9.2' },
    },
  });
  await initializing;
  return { adapter, socket };
}

export async function initializeAdapterWithOptions(options?: Partial<AcpClientOptions> & { initializeAuthMethods?: unknown[] }) {
  MockAcpWebSocket.instances = [];
  const adapter = createAcpAdapter({
    url: 'ws://localhost:23004/acp/oh-my-pi?token=secret',
    agentId: 'oh-my-pi',
    now: () => 1_700_000_000_000,
    webSocketCtor: MockAcpWebSocket,
    ...options,
  });
  const initializing = adapter.initialize();
  const socket = MockAcpWebSocket.instances[0];
  if (!socket) throw new Error('Expected ACP WebSocket instance.');
  socket.open();
  await Promise.resolve();
  socket.receive({
    jsonrpc: '2.0',
    id: 1,
    result: {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true },
        sessionCapabilities: { list: {} },
      },
      agentInfo: { name: 'oh-my-pi', title: 'Oh My Pi', version: '14.9.2' },
      ...(options?.initializeAuthMethods ? { authMethods: options.initializeAuthMethods } : {}),
    },
  });
  await initializing;
  return { adapter, socket };
}

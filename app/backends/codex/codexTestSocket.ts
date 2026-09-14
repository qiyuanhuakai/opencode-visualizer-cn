type ListenerMap = {
  open: Array<() => void>;
  message: Array<(event: { data: unknown }) => void>;
  error: Array<() => void>;
  close: Array<(event: { code?: number; reason?: string }) => void>;
};

export class CodexTestSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: CodexTestSocket[] = [];

  readyState = CodexTestSocket.CONNECTING;
  readonly sent: string[] = [];
  private readonly listeners: ListenerMap = {
    open: [],
    message: [],
    error: [],
    close: [],
  };

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    CodexTestSocket.instances.push(this);
  }

  addEventListener<T extends keyof ListenerMap>(type: T, listener: ListenerMap[T][number]) {
    this.listeners[type].push(listener as never);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close(code?: number, reason = '') {
    this.readyState = CodexTestSocket.CLOSED;
    this.emitClose(reason, code);
  }

  emitOpen() {
    this.readyState = CodexTestSocket.OPEN;
    for (const listener of this.listeners.open) listener();
  }

  open() {
    this.emitOpen();
  }

  emitMessage(data: unknown) {
    for (const listener of this.listeners.message) listener({ data });
  }

  emitError() {
    for (const listener of this.listeners.error) listener();
  }

  emitClose(reason = '', code?: number) {
    this.readyState = CodexTestSocket.CLOSED;
    for (const listener of this.listeners.close) listener({ code, reason });
  }

  respond(id: number, result: unknown): void;
  respond(payload: unknown): void;
  respond(idOrPayload: unknown, result?: unknown) {
    const payload = typeof idOrPayload === 'number' ? { id: idOrPayload, result } : idOrPayload;
    this.emitMessage(JSON.stringify(payload));
  }

  reject(id: number, message: string, code = -32000) {
    this.emitMessage(JSON.stringify({ id, error: { code, message } }));
  }
}

export async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

export async function waitForSent(socket: CodexTestSocket, count: number) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (socket.sent.length >= count) return;
    await flushPromises();
  }
  throw new Error(`Expected ${count} sent messages, received ${socket.sent.length}.`);
}

export function closeCodexTestSockets() {
  for (const socket of CodexTestSocket.instances) {
    if (socket.readyState !== CodexTestSocket.CLOSED) socket.close();
  }
  CodexTestSocket.instances = [];
}

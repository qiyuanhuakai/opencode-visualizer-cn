export type CodexJsonRpcId = number | string;

export type CodexJsonRpcNotification = {
  method: string;
  params?: unknown;
};

export type CodexJsonRpcServerRequest = CodexJsonRpcNotification & {
  id: CodexJsonRpcId;
};

type CodexJsonRpcResponse = {
  id: CodexJsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

type CodexWebSocketMessageEvent = {
  data: unknown;
};

type CodexWebSocketCloseEvent = {
  code?: number;
  reason?: string;
};

export type CodexWebSocket = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'message', listener: (event: CodexWebSocketMessageEvent) => void): void;
  addEventListener(type: 'close', listener: (event: CodexWebSocketCloseEvent) => void): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'error', listener: () => void): void;
};

export type CodexWebSocketConstructor = new (
  url: string,
  protocols?: string | string[],
) => CodexWebSocket;

export type CodexJsonRpcClientOptions = {
  url: string;
  protocols?: string | string[];
  requestTimeoutMs?: number;
  webSocketCtor?: CodexWebSocketConstructor;
};

export class CodexJsonRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.name = 'CodexJsonRpcError';
    this.code = code;
    this.data = data;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isJsonRpcId(value: unknown): value is CodexJsonRpcId {
  return typeof value === 'number' || typeof value === 'string';
}

function redactUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.searchParams.has('token')) url.searchParams.set('token', 'REDACTED');
    return url.toString();
  } catch {
    return value.replace(/([?&]token=)[^&]*/u, '$1REDACTED');
  }
}

function parseIncomingMessage(raw: string): CodexJsonRpcResponse | CodexJsonRpcNotification | CodexJsonRpcServerRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) return null;

  if (isJsonRpcId(parsed.id) && typeof parsed.method === 'string') {
    return {
      id: parsed.id,
      method: parsed.method,
      params: parsed.params,
    };
  }

  if (isJsonRpcId(parsed.id)) {
    const response: CodexJsonRpcResponse = { id: parsed.id };
    if ('result' in parsed) response.result = parsed.result;
    if (isRecord(parsed.error)) {
      const code = parsed.error.code;
      const message = parsed.error.message;
      if (typeof code === 'number' && typeof message === 'string') {
        response.error = {
          code,
          message,
          data: parsed.error.data,
        };
      }
    }
    return response;
  }

  if (typeof parsed.method === 'string') {
    return {
      method: parsed.method,
      params: parsed.params,
    };
  }

  return null;
}

export class CodexJsonRpcClient {
  private readonly url: string;
  private readonly protocols?: string | string[];
  private readonly requestTimeoutMs: number;
  private readonly webSocketCtor?: CodexWebSocketConstructor;
  private socket: CodexWebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<CodexJsonRpcId, PendingRequest>();
  private readonly notificationHandlers = new Set<(notification: CodexJsonRpcNotification) => void>();
  private readonly serverRequestHandlers = new Set<(request: CodexJsonRpcServerRequest) => void>();

  constructor(options: CodexJsonRpcClientOptions) {
    this.url = options.url;
    this.protocols = options.protocols;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.webSocketCtor = options.webSocketCtor;
  }

  isConnected() {
    return this.socket?.readyState === 1;
  }

  connect() {
    if (this.isConnected()) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    const WebSocketCtor: CodexWebSocketConstructor | undefined =
      this.webSocketCtor ?? (globalThis.WebSocket as unknown as CodexWebSocketConstructor | undefined);
    if (!WebSocketCtor) {
      return Promise.reject(new Error('WebSocket is not available in this environment.'));
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const safeUrl = redactUrl(this.url);
      const socket = new WebSocketCtor(this.url, this.protocols);
      this.socket = socket;
      let settled = false;

      const settle = (handler: () => void) => {
        if (settled) return;
        settled = true;
        this.connectPromise = null;
        handler();
      };

      socket.addEventListener('open', () => {
        settle(resolve);
      });

      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        this.handleMessage(event.data);
      });

      socket.addEventListener('error', () => {
        settle(() => reject(new Error(`Codex WebSocket connection failed: ${safeUrl}`)));
      });

      socket.addEventListener('close', (event) => {
        const reason = event.reason ? `: ${event.reason}` : '';
        this.rejectAllPending(new Error(`Codex WebSocket closed${reason}`));
        if (this.socket === socket) this.socket = null;
        settle(() => reject(new Error(`Codex WebSocket closed before opening${reason}`)));
      });
    });

    return this.connectPromise;
  }

  disconnect() {
    const socket = this.socket;
    this.socket = null;
    this.connectPromise = null;
    this.rejectAllPending(new Error('Codex WebSocket disconnected.'));
    if (socket && socket.readyState !== 3) {
      socket.close();
    }
  }

  onNotification(handler: (notification: CodexJsonRpcNotification) => void) {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  onServerRequest(handler: (request: CodexJsonRpcServerRequest) => void) {
    this.serverRequestHandlers.add(handler);
    return () => {
      this.serverRequestHandlers.delete(handler);
    };
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    const socket = this.requireOpenSocket();
    const id = this.nextId;
    this.nextId += 1;

    const message: Record<string, unknown> = { id, method };
    if (params !== undefined) message.params = params;

    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex JSON-RPC request timed out: ${method}`));
      }, this.requestTimeoutMs);

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeoutId,
      });

      try {
        socket.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timeoutId);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params?: unknown) {
    const socket = this.requireOpenSocket();
    const message: Record<string, unknown> = { method };
    if (params !== undefined) message.params = params;
    socket.send(JSON.stringify(message));
  }

  respond(id: CodexJsonRpcId, result: unknown) {
    const socket = this.requireOpenSocket();
    socket.send(JSON.stringify({ id, result }));
  }

  private requireOpenSocket() {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) {
      throw new Error('Codex JSON-RPC client is not connected.');
    }
    return socket;
  }

  private handleMessage(raw: string) {
    const message = parseIncomingMessage(raw);
    if (!message) return;

    if ('id' in message && 'method' in message) {
      for (const handler of this.serverRequestHandlers) {
        handler(message);
      }
      return;
    }

    if ('id' in message) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeoutId);

      if (message.error) {
        pending.reject(new CodexJsonRpcError(
          message.error.code,
          message.error.message,
          message.error.data,
        ));
        return;
      }

      pending.resolve(message.result);
      return;
    }

    for (const handler of this.notificationHandlers) {
      handler(message);
    }
  }

  private rejectAllPending(error: Error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeoutId);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

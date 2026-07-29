import {
  CodexJsonRpcError,
  parseCodexJsonRpcMessage,
  redactCodexUrl,
  type CodexJsonRpcId,
  type CodexJsonRpcNotification,
  type CodexJsonRpcServerRequest,
  type CodexWebSocket,
  type CodexWebSocketConstructor,
} from './jsonRpcProtocol';
import {
  isCodexOverload,
  overloadRetryDelayMs,
  waitForRetry,
  type CodexRequestOptions,
} from './jsonRpcRetry';

export { CodexJsonRpcError } from './jsonRpcProtocol';
export type {
  CodexJsonRpcId,
  CodexJsonRpcNotification,
  CodexJsonRpcServerRequest,
} from './jsonRpcProtocol';

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

export type { CodexWebSocket, CodexWebSocketConstructor } from './jsonRpcProtocol';

export type CodexJsonRpcClientOptions = {
  url: string;
  connectionLabel?: string;
  protocols?: string | string[];
  jsonRpcVersion?: '2.0';
  requestTimeoutMs?: number;
  webSocketCtor?: CodexWebSocketConstructor;
};

export class CodexJsonRpcClient {
  private readonly url: string;
  private readonly connectionLabel: string;
  private readonly protocols?: string | string[];
  private readonly requestTimeoutMs: number;
  private readonly webSocketCtor?: CodexWebSocketConstructor;
  private readonly jsonRpcVersion?: '2.0';
  private socket: CodexWebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private connectionGeneration = 0;
  private nextId = 1;
  private readonly pending = new Map<CodexJsonRpcId, PendingRequest>();
  private readonly notificationHandlers = new Set<
    (notification: CodexJsonRpcNotification) => void
  >();
  private readonly serverRequestHandlers = new Set<(request: CodexJsonRpcServerRequest) => void>();

  constructor(options: CodexJsonRpcClientOptions) {
    this.url = options.url;
    this.connectionLabel = options.connectionLabel ?? 'Codex';
    this.protocols = options.protocols;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.webSocketCtor = options.webSocketCtor;
    this.jsonRpcVersion = options.jsonRpcVersion;
  }

  isConnected() {
    return this.socket?.readyState === 1;
  }

  connect() {
    if (this.isConnected()) return Promise.resolve();
    if (this.connectPromise) return this.connectPromise;

    const WebSocketCtor: CodexWebSocketConstructor | undefined =
      this.webSocketCtor ??
      (globalThis.WebSocket as unknown as CodexWebSocketConstructor | undefined);
    if (!WebSocketCtor) {
      return Promise.reject(new Error('WebSocket is not available in this environment.'));
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const safeUrl = redactCodexUrl(this.url);
      const socket = new WebSocketCtor(this.url, this.protocols);
      this.connectionGeneration += 1;
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
        settle(() =>
          reject(new Error(`${this.connectionLabel} WebSocket connection failed: ${safeUrl}`)),
        );
      });

      socket.addEventListener('close', (event) => {
        const reason = event.reason ? `: ${event.reason}` : '';
        this.rejectAllPending(new Error(`${this.connectionLabel} WebSocket closed${reason}`));
        if (this.socket === socket) this.socket = null;
        settle(() =>
          reject(new Error(`${this.connectionLabel} WebSocket closed before opening${reason}`)),
        );
      });
    });

    return this.connectPromise;
  }

  disconnect() {
    const socket = this.socket;
    this.socket = null;
    this.connectPromise = null;
    this.rejectAllPending(new Error(`${this.connectionLabel} WebSocket disconnected.`));
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

  request<T = unknown>(method: string, params?: unknown, options?: CodexRequestOptions): Promise<T> {
    const policy = options?.retryOverloaded;
    if (!policy) return this.sendRequest<T>(method, params, options?.timeoutMs);
    const generation = this.connectionGeneration;
    return this.requestWithOverloadRetry<T>(method, params, policy, generation, options?.timeoutMs);
  }

  private async requestWithOverloadRetry<T>(
    method: string,
    params: unknown,
    policy: NonNullable<CodexRequestOptions['retryOverloaded']>,
    generation: number,
    timeoutMs: number | undefined,
  ): Promise<T> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.sendRequest<T>(method, params, timeoutMs);
      } catch (error) {
        if (!isCodexOverload(error) || attempt >= policy.maxAttempts) throw error;
        await waitForRetry(overloadRetryDelayMs(error, attempt, policy));
        if (generation !== this.connectionGeneration) {
          throw new Error(`${this.connectionLabel} JSON-RPC connection changed before retry: ${method}`);
        }
      }
    }
  }

  private sendRequest<T>(method: string, params?: unknown, timeoutMs = this.requestTimeoutMs): Promise<T> {
    const socket = this.requireOpenSocket();
    const id = this.nextId;
    this.nextId += 1;

    const message: Record<string, unknown> = this.withVersion({ id, method });
    if (params !== undefined) message.params = params;

    return new Promise<T>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.connectionLabel} JSON-RPC request timed out: ${method}`));
      }, timeoutMs);

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
    const message: Record<string, unknown> = this.withVersion({ method });
    if (params !== undefined) message.params = params;
    socket.send(JSON.stringify(message));
  }

  respond(id: CodexJsonRpcId, result: unknown) {
    const socket = this.requireOpenSocket();
    socket.send(JSON.stringify(this.withVersion({ id, result })));
  }

  respondError(id: CodexJsonRpcId, code: number, message: string, data?: unknown) {
    const socket = this.requireOpenSocket();
    const error: Record<string, unknown> = { code, message };
    if (data !== undefined) error.data = data;
    socket.send(JSON.stringify(this.withVersion({ id, error })));
  }

  private withVersion(message: Record<string, unknown>) {
    if (!this.jsonRpcVersion) return message;
    return { jsonrpc: this.jsonRpcVersion, ...message };
  }

  private requireOpenSocket() {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) {
      throw new Error(`${this.connectionLabel} JSON-RPC client is not connected.`);
    }
    return socket;
  }

  private handleMessage(raw: string) {
    const message = parseCodexJsonRpcMessage(raw);
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
        pending.reject(
          new CodexJsonRpcError(message.error.code, message.error.message, message.error.data),
        );
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

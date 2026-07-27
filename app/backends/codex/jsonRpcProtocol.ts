export type CodexJsonRpcId = number | string;

export type CodexJsonRpcNotification = {
  method: string;
  params?: unknown;
};

export type CodexJsonRpcServerRequest = CodexJsonRpcNotification & {
  id: CodexJsonRpcId;
};

export type CodexJsonRpcResponse = {
  id: CodexJsonRpcId;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
};

export type CodexWebSocketMessageEvent = { data: unknown };
export type CodexWebSocketCloseEvent = { code?: number; reason?: string };

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

export function redactCodexUrl(value: string) {
  try {
    const url = new URL(value);
    if (url.searchParams.has('token')) url.searchParams.set('token', 'REDACTED');
    return url.toString();
  } catch {
    return value.replace(/([?&]token=)[^&]*/u, '$1REDACTED');
  }
}

export function parseCodexJsonRpcMessage(
  raw: string,
): CodexJsonRpcResponse | CodexJsonRpcNotification | CodexJsonRpcServerRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  if (isJsonRpcId(parsed.id) && typeof parsed.method === 'string') {
    return { id: parsed.id, method: parsed.method, params: parsed.params };
  }
  if (isJsonRpcId(parsed.id)) {
    const response: CodexJsonRpcResponse = { id: parsed.id };
    if ('result' in parsed) response.result = parsed.result;
    if (isRecord(parsed.error)) {
      const code = parsed.error.code;
      const message = parsed.error.message;
      if (typeof code === 'number' && typeof message === 'string') {
        response.error = { code, message, data: parsed.error.data };
      }
    }
    return response;
  }
  if (typeof parsed.method === 'string') {
    return { method: parsed.method, params: parsed.params };
  }
  return null;
}

import type { SsePacket } from '../types/sse';

export type SseConnectionOptions = {
  baseUrl: string;
  authorization?: string;
  errorMessages?: {
    emptyBaseUrl?: string;
    authenticationFailed?: string;
    streamClosed?: string;
    httpError?: (status: number) => string;
  };
};

export type SseConnectionConnectOptions = {
  failFast?: boolean;
  timeoutMs?: number;
};

export type SseConnectionCallbacks = {
  onPacket: (packet: SsePacket) => void;
  onOpen: (isReconnect: boolean) => void;
  onError: (message: string, statusCode?: number) => void;
};

export type SseConnection = {
  connect: (options: SseConnectionOptions) => void;
  disconnect: () => void;
  isConnected: () => boolean;
};

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, '');
}

export function parsePacket(raw: string): SsePacket | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const record = parsed as Record<string, unknown>;
  if (!record.payload || typeof record.payload !== 'object') return null;
  const payload = record.payload as Record<string, unknown>;
  if (typeof payload.type !== 'string') return null;
  if (!payload.properties || typeof payload.properties !== 'object') return null;
  return {
    directory: typeof record.directory === 'string' ? record.directory : '',
    payload: {
      type: payload.type,
      properties: payload.properties as Record<string, unknown>,
    },
  };
}

export function createSseConnection(callbacks: SseConnectionCallbacks): SseConnection {
  let abortController: AbortController | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let disconnectRequested = false;
  let connected = false;
  let target: SseConnectionOptions | undefined;

  function keyOf(options: SseConnectionOptions) {
    return `${normalizeBaseUrl(options.baseUrl)}\u0000${options.authorization ?? ''}`;
  }

  function clearReconnectTimer() {
    if (!reconnectTimer) return;
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  function scheduleReconnect() {
    if (disconnectRequested || reconnectTimer || !target) return;
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect(target!);
    }, 1000);
  }

  function handleStream(reader: ReadableStreamDefaultReader<Uint8Array>) {
    const decoder = new TextDecoder();
    let buffer = '';

    const loop = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split('\n\n');
          buffer = blocks.pop() || '';

          for (const block of blocks) {
            if (!block.trim()) continue;
            const prefix = 'data: ';
            if (!block.startsWith(prefix)) {
              console.warn('Invalid SSE packet?', block);
              continue;
            }
            const packet = parsePacket(block.slice(prefix.length));
            if (packet) callbacks.onPacket(packet);
          }
        }
      } catch (error) {
        if (abortController?.signal.aborted) return;
        callbacks.onError(String(error));
        abortController = undefined;
        connected = false;
        scheduleReconnect();
        return;
      }

      callbacks.onError(target?.errorMessages?.streamClosed ?? 'SSE stream closed.');
      abortController = undefined;
      connected = false;
      scheduleReconnect();
    };

    void loop();
  }

  function startFetch(options: SseConnectionOptions, isReconnect: boolean) {
    const effectiveBaseUrl = normalizeBaseUrl(options.baseUrl);
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
    };
    if (options.authorization) {
      headers['Authorization'] = options.authorization;
    }

    void (async () => {
      try {
        const response = await fetch(`${effectiveBaseUrl}/global/event`, {
          signal: abortController!.signal,
          headers,
        });

        if (response.status === 401) {
          abortController = undefined;
          connected = false;
          callbacks.onError(target?.errorMessages?.authenticationFailed ?? 'Authentication failed.', 401);
          return;
        }

        if (!response.ok || !response.body) {
          abortController = undefined;
          connected = false;
          callbacks.onError(`HTTP ${response.status}`);
          scheduleReconnect();
          return;
        }

        reconnectAttempt = 0;
        connected = true;
        callbacks.onOpen(isReconnect);
        handleStream(response.body.getReader());
      } catch (error) {
        abortController = undefined;
        connected = false;

        if (disconnectRequested) return;

        console.error('[SSE] Fetch failed:', error);
        callbacks.onError(String(error));
        scheduleReconnect();
      }
    })();
  }

  function connect(options: SseConnectionOptions) {
    const normalized: SseConnectionOptions = {
      baseUrl: normalizeBaseUrl(options.baseUrl),
      authorization: options.authorization,
      errorMessages: options.errorMessages,
    };
    if (!normalized.baseUrl) {
      callbacks.onError(normalized.errorMessages?.emptyBaseUrl ?? 'SSE base URL is empty.');
      return;
    }

    const nextKey = keyOf(normalized);
    const prevKey = target ? keyOf(target) : '';
    const changed = prevKey !== '' && prevKey !== nextKey;

    target = normalized;
    disconnectRequested = false;

    if (changed) {
      clearReconnectTimer();
      abortController?.abort();
      abortController = undefined;
      connected = false;
    }

    if (abortController) return;

    const isReconnect = reconnectAttempt > 0;
    abortController = new AbortController();
    connected = false;
    startFetch(normalized, isReconnect);
  }

  function disconnect() {
    disconnectRequested = true;
    clearReconnectTimer();
    abortController?.abort();
    abortController = undefined;
    connected = false;
    reconnectAttempt = 0;
  }

  return {
    connect,
    disconnect,
    isConnected: () => connected,
  };
}

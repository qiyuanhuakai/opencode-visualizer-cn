import type { SsePacket } from '../types/sse';

const MAX_SSE_EVENT_BUFFER_BYTES = 1 * 1024 * 1024;

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

export type SseConnectionCallbacks = {
  onPacket: (packet: SsePacket) => void;
  onOpen: (isReconnect: boolean) => void;
  onError: (message: string, statusCode?: number) => void;
};

export type SseEventParserInstrumentation = {
  readonly onScan?: (scannedBytes: number) => void;
  readonly onBlockEncoded?: (encodedBytes: number) => void;
};

export type SseEventParser = {
  readonly push: (chunk: Uint8Array) => void;
};

export type SseConnection = {
  connect: (options: SseConnectionOptions) => void;
  disconnect: () => void;
  isConnected: () => boolean;
};

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, '');
}

export function createSseEventParser(
  onBlock: (block: string) => void,
  instrumentation?: SseEventParserInstrumentation,
): SseEventParser {
  let pending = new Uint8Array(0);
  let pendingLength = 0;
  const decoder = new TextDecoder();

  function ensureCapacity(requiredLength: number): void {
    if (requiredLength <= pending.byteLength) return;
    const doubledLength = pending.byteLength > 0 ? pending.byteLength * 2 : 64;
    const nextLength = Math.min(
      MAX_SSE_EVENT_BUFFER_BYTES + 2,
      Math.max(requiredLength, doubledLength),
    );
    const next = new Uint8Array(nextLength);
    next.set(pending.subarray(0, pendingLength));
    pending = next;
  }

  function pushSegment(chunk: Uint8Array): void {
    const oldLength = pendingLength;
    ensureCapacity(oldLength + chunk.byteLength);
    pending.set(chunk, oldLength);
    pendingLength += chunk.byteLength;

    let consumedBytes = 0;
    let blockStart = 0;
    let scannedBytes = 0;
    for (let index = Math.max(0, oldLength - 1); index + 1 < pendingLength; index += 1) {
      scannedBytes += 1;
      if (pending[index] !== 10 || pending[index + 1] !== 10) continue;

      const block = pending.subarray(blockStart, index);
      const decodedBlock = decoder.decode(block);
      instrumentation?.onBlockEncoded?.(block.byteLength);
      if (block.byteLength > MAX_SSE_EVENT_BUFFER_BYTES) {
        throw new Error('SSE event buffer exceeded 1 MiB.');
      }
      onBlock(decodedBlock);

      consumedBytes = index + 2;
      blockStart = consumedBytes;
      index += 1;
    }
    instrumentation?.onScan?.(scannedBytes);

    if (consumedBytes > 0) {
      pending.copyWithin(0, consumedBytes, pendingLength);
      pendingLength -= consumedBytes;
    }
    if (pendingLength > MAX_SSE_EVENT_BUFFER_BYTES) {
      throw new Error('SSE event buffer exceeded 1 MiB.');
    }
  }

  function push(chunk: Uint8Array): void {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const availableBeforeLimit = MAX_SSE_EVENT_BUFFER_BYTES + 2 - pendingLength;
      if (availableBeforeLimit <= 0) {
        throw new Error('SSE event buffer exceeded 1 MiB.');
      }
      const segmentLength = Math.min(chunk.byteLength - offset, availableBeforeLimit);
      pushSegment(chunk.subarray(offset, offset + segmentLength));
      offset += segmentLength;
    }
  }

  return { push };
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
      const nextTarget = target;
      if (nextTarget) connect(nextTarget);
    }, 1000);
  }

  function handleStream(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    controller: AbortController,
  ) {
    const ownsStream = () => !controller.signal.aborted && abortController === controller;
    const parser = createSseEventParser((block) => {
      if (!ownsStream()) return;
      if (!block.trim()) return;
      const prefix = 'data: ';
      if (!block.startsWith(prefix)) {
        console.warn('Invalid SSE packet?', block);
        return;
      }
      const packet = parsePacket(block.slice(prefix.length));
      if (packet && ownsStream()) callbacks.onPacket(packet);
    });

    const loop = async () => {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (!ownsStream()) {
            await Promise.allSettled([reader.cancel()]);
            return;
          }
          if (done) break;
          parser.push(value);
        }
      } catch (error) {
        if (controller.signal.aborted || abortController !== controller) return;
        await Promise.allSettled([reader.cancel()]);
        controller.abort();
        if (abortController !== controller) return;
        callbacks.onError(String(error));
        abortController = undefined;
        connected = false;
        scheduleReconnect();
        return;
      }

      if (controller.signal.aborted || abortController !== controller) return;
      callbacks.onError(target?.errorMessages?.streamClosed ?? 'SSE stream closed.');
      abortController = undefined;
      connected = false;
      scheduleReconnect();
    };

    void loop();
  }

  function startFetch(
    options: SseConnectionOptions,
    isReconnect: boolean,
    controller: AbortController,
  ) {
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
          signal: controller.signal,
          headers,
        });

        if (controller.signal.aborted || abortController !== controller) return;

        if (response.status === 401) {
          controller.abort();
          abortController = undefined;
          connected = false;
          callbacks.onError(
            target?.errorMessages?.authenticationFailed ?? 'Authentication failed.',
            401,
          );
          return;
        }

        if (!response.ok || !response.body) {
          controller.abort();
          abortController = undefined;
          connected = false;
          callbacks.onError(`HTTP ${response.status}`);
          scheduleReconnect();
          return;
        }

        reconnectAttempt = 0;
        connected = true;
        callbacks.onOpen(isReconnect);
        handleStream(response.body.getReader(), controller);
      } catch (error) {
        if (controller.signal.aborted || abortController !== controller) return;
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
    const controller = new AbortController();
    abortController = controller;
    connected = false;
    startFetch(normalized, isReconnect, controller);
  }

  function disconnect() {
    disconnectRequested = true;
    clearReconnectTimer();
    const controller = abortController;
    controller?.abort();
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

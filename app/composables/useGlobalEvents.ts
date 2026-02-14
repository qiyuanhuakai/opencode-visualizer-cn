import { type Ref, watchEffect } from 'vue';
import type { GlobalEventMap, SseEnvelope } from '../types/sse';
import { TypedEmitter } from '../utils/eventEmitter';

type EventKey = keyof GlobalEventMap;
type ConnectionOptions = { baseUrl?: string; failFast?: boolean; timeoutMs?: number; authorization?: string };

export type SessionScope = {
  on<K extends EventKey>(event: K, listener: (payload: GlobalEventMap[K]) => void): () => void;
  on(event: string, listener: (payload: any) => void): () => void;
  dispose(): void;
};

export type MainSessionScope = SessionScope;

const KNOWN_EVENT_TYPES = new Set<EventKey>([
  'message.updated',
  'message.removed',
  'message.part.updated',
  'message.part.delta',
  'message.part.removed',
  'session.created',
  'session.updated',
  'session.deleted',
  'session.diff',
  'session.error',
  'session.status',
  'session.compacted',
  'permission.asked',
  'permission.replied',
  'question.asked',
  'question.replied',
  'question.rejected',
  'todo.updated',
  'pty.created',
  'pty.updated',
  'pty.exited',
  'pty.deleted',
  'worktree.ready',
  'worktree.failed',
  'project.updated',
  'vcs.branch.updated',
  'file.edited',
  'lsp.updated',
  'lsp.client.diagnostics',
  'command.executed',
  'installation.updated',
  'installation.update-available',
  'mcp.tools.changed',
  'connection.open',
  'connection.error',
  'connection.reconnected',
]);

function isKnownEventType(value: string): value is EventKey {
  return KNOWN_EVENT_TYPES.has(value as EventKey);
}

function parseEnvelope(raw: string): SseEnvelope | null {
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

function extractSessionId(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const record = payload as Record<string, unknown>;
  if (typeof record.sessionID === 'string') return record.sessionID;
  if (typeof record.sessionId === 'string') return record.sessionId;

  const info =
    record.info && typeof record.info === 'object'
      ? (record.info as Record<string, unknown>)
      : undefined;
  if (typeof info?.sessionID === 'string') return info.sessionID;
  if (typeof info?.sessionId === 'string') return info.sessionId;

  const part =
    record.part && typeof record.part === 'object'
      ? (record.part as Record<string, unknown>)
      : undefined;
  if (typeof part?.sessionID === 'string') return part.sessionID;
  if (typeof part?.sessionId === 'string') return part.sessionId;

  return undefined;
}

function computeAllowedSessionIds(
  rootId: string,
  parents: Readonly<Record<string, string | undefined>>,
): Set<string> {
  const allowed = new Set<string>();
  if (!rootId) return allowed;
  const childrenByParent = new Map<string, string[]>();
  Object.entries(parents).forEach(([sessionId, parentId]) => {
    if (!parentId) return;
    const bucket = childrenByParent.get(parentId) ?? [];
    bucket.push(sessionId);
    childrenByParent.set(parentId, bucket);
  });
  const stack = [rootId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (allowed.has(current)) continue;
    allowed.add(current);
    const children = childrenByParent.get(current);
    if (children) stack.push(...children);
  }
  return allowed;
}

export function useGlobalEvents(baseUrl: string) {
  const emitter = new TypedEmitter<GlobalEventMap>();
  let abortController: AbortController | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let disconnectRequested = false;
  let connectionResolved = false;

  function routeEnvelope(envelope: SseEnvelope) {
    const type = envelope.payload.type;
    if (!isKnownEventType(type)) return;
    emitter.emit(type, envelope.payload.properties as GlobalEventMap[typeof type]);
  }

  let openResolver: ((value: void) => void) | null = null;
  let openRejector: ((reason: Error) => void) | null = null;

  function waitForOpen(timeoutMs = 5000) {
    return new Promise<void>((resolve, reject) => {
      if (!abortController) {
        reject(new Error('SSE connection is not initialized.'));
        return;
      }
      if (connectionResolved) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        openResolver = null;
        openRejector = null;
        reject(new Error('SSE connection timed out.'));
      }, timeoutMs);
      openResolver = (value) => {
        clearTimeout(timer);
        resolve(value);
        openResolver = null;
        openRejector = null;
      };
      openRejector = (error) => {
        clearTimeout(timer);
        reject(error);
        openResolver = null;
        openRejector = null;
      };
    });
  }

  function readStream(reader: ReadableStreamDefaultReader<Uint8Array>, options: ConnectionOptions) {
    const decoder = new TextDecoder();
    let buffer = '';

    async function loop() {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            const dataPrefix = 'data: ';
            if (line.startsWith(dataPrefix)) {
              const jsonStr = line.slice(dataPrefix.length);
              const envelope = parseEnvelope(jsonStr);
              if (envelope) {
                routeEnvelope(envelope);
              }
            }
          }
        }
      } catch (error) {
        if (abortController?.signal.aborted) {
          return;
        }
        emitter.emit('connection.error', { message: String(error) });
        abortController = undefined;
        connectionResolved = false;
        if (!disconnectRequested && !reconnectTimer) {
          reconnectAttempt += 1;
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            void connect(options);
          }, 1000);
        }
        return;
      }

      emitter.emit('connection.error', { message: 'SSE stream closed.' });
      abortController = undefined;
      connectionResolved = false;

      if (!disconnectRequested && !reconnectTimer) {
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          void connect(options);
        }, 1000);
      }
    }

    void loop();
  }

  async function connect(options: ConnectionOptions = {}) {
    disconnectRequested = false;
    if (abortController) {
      if (options.failFast) await waitForOpen(options.timeoutMs ?? 5000);
      return;
    }

    const isReconnect = reconnectAttempt > 0;
    abortController = new AbortController();
    connectionResolved = false;

    const headers: Record<string, string> = {};
    if (options.authorization) {
      headers['Authorization'] = options.authorization;
    }

    const effectiveBaseUrl = options.baseUrl || baseUrl;
    try {
      const response = await fetch(`${effectiveBaseUrl}/global/event`, {
        signal: abortController.signal,
        headers,
      });

      if (response.status === 401) {
        abortController = undefined;
        emitter.emit('connection.error', { message: 'Authentication failed.', statusCode: 401 });
        if (openRejector) {
          openRejector(new Error('Authentication failed.'));
        }
        return;
      }

      if (!response.ok || !response.body) {
        abortController = undefined;
        emitter.emit('connection.error', { message: `HTTP ${response.status}` });
        if (openRejector) {
          openRejector(new Error(`HTTP ${response.status}`));
        }
        if (!disconnectRequested && !reconnectTimer) {
          reconnectAttempt += 1;
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            void connect(options);
          }, 1000);
        }
        return;
      }

      reconnectAttempt = 0;
      connectionResolved = true;
      emitter.emit('connection.open', {});
      if (isReconnect) {
        emitter.emit('connection.reconnected', {});
      }
      if (openResolver) {
        openResolver();
      }

      // Read stream in background — do NOT await so connect() can return
      readStream(response.body.getReader(), options);
    } catch (error) {
      abortController = undefined;
      connectionResolved = false;

      if (disconnectRequested) return;

      emitter.emit('connection.error', { message: String(error) });
      if (openRejector) {
        openRejector(error instanceof Error ? error : new Error(String(error)));
      }

      if (!reconnectTimer) {
        reconnectAttempt += 1;
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          void connect(options);
        }, 1000);
      }
    }

    if (options.failFast) await waitForOpen(options.timeoutMs ?? 5000);
  }

  function disconnect() {
    disconnectRequested = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    abortController?.abort();
    abortController = undefined;
    connectionResolved = false;
  }

  function on<K extends EventKey>(event: K, listener: (payload: GlobalEventMap[K]) => void): () => void;
  function on(event: string, listener: (payload: any) => void): () => void;
  function on(event: string, listener: (payload: any) => void): () => void {
    if (!isKnownEventType(event)) return () => {};
    return emitter.on(event, listener as any);
  }

  function session(
    selectedSessionId: Ref<string>,
    sessionParentById: Readonly<Record<string, string | undefined>>,
  ): SessionScope {
    let allowed = new Set<string>();
    const stop = watchEffect(() => {
      allowed = computeAllowedSessionIds(selectedSessionId.value, sessionParentById);
    });
    const disposers = new Set<() => void>();

    function scopedOn<K extends EventKey>(
      event: K,
      listener: (payload: GlobalEventMap[K]) => void,
    ): () => void;
    function scopedOn(event: string, listener: (payload: any) => void): () => void;
    function scopedOn(event: string, listener: (payload: any) => void): () => void {
      if (!isKnownEventType(event)) return () => {};
      const off = on(event, (payload) => {
        const sessionId = extractSessionId(payload);
        if (!sessionId || allowed.has(sessionId)) {
          listener(payload);
        }
      });
      disposers.add(off);
      return () => {
        off();
        disposers.delete(off);
      };
    }

    function dispose() {
      stop();
      for (const off of disposers) off();
      disposers.clear();
    }

    return { on: scopedOn, dispose };
  }

  function mainSession(selectedSessionId: Ref<string>): MainSessionScope {
    const disposers = new Set<() => void>();

    function scopedOn<K extends EventKey>(
      event: K,
      listener: (payload: GlobalEventMap[K]) => void,
    ): () => void;
    function scopedOn(event: string, listener: (payload: any) => void): () => void;
    function scopedOn(event: string, listener: (payload: any) => void): () => void {
      if (!isKnownEventType(event)) return () => {};
      const off = on(event, (payload) => {
        const sessionId = extractSessionId(payload);
        if (!sessionId || sessionId === selectedSessionId.value) {
          listener(payload);
        }
      });
      disposers.add(off);
      return () => {
        off();
        disposers.delete(off);
      };
    }

    function dispose() {
      for (const off of disposers) off();
      disposers.clear();
    }

    return { on: scopedOn, dispose };
  }

  return { on, connect, disconnect, session, mainSession };
}

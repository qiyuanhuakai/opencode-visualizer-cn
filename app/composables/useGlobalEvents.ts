import { type Ref, watch, watchEffect } from 'vue';
import type { GlobalEventMap, SsePacket } from '../types/sse';
import type { TabToWorkerMessage, WorkerToTabMessage } from '../types/sse-worker';
import { createSseConnection } from '../utils/sseConnection';
import { TypedEmitter } from '../utils/eventEmitter';
import SseSharedWorker from '../workers/sse-shared-worker?sharedworker';

type EventKey = keyof GlobalEventMap;
type ConnectOptions = { failFast?: boolean; timeoutMs?: number };

type CredentialsBinding = {
  baseUrl: Ref<string>;
  authHeader: Ref<string | undefined>;
};

type TransportCallbacks = {
  onPacket: (packet: SsePacket) => void;
  onOpen: () => void;
  onError: (message: string, statusCode?: number) => void;
  onReconnected: () => void;
  onWorkerMessage?: (message: WorkerToTabMessage) => boolean;
};

type Transport = {
  connect: (
    baseUrl: string,
    authorization: string | undefined,
    options?: ConnectOptions,
  ) => Promise<void>;
  disconnect: () => void;
  sendToWorker: (message: TabToWorkerMessage) => boolean;
};

export type SessionScope = {
  on<K extends EventKey>(event: K, listener: (payload: GlobalEventMap[K]) => void): () => void;
  on(event: string, listener: (payload: unknown) => void): () => void;
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
  'file.watcher.updated',
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
    const current = stack.pop();
    if (!current || allowed.has(current)) continue;
    allowed.add(current);
    const children = childrenByParent.get(current);
    if (children) stack.push(...children);
  }
  return allowed;
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, '');
}

function createDirectTransport(callbacks: TransportCallbacks): Transport {
  let connected = false;
  let openResolver: ((value: void) => void) | null = null;
  let openRejector: ((reason: Error) => void) | null = null;

  const connection = createSseConnection({
    onPacket(packet) {
      callbacks.onPacket(packet);
    },
    onOpen(isReconnect) {
      connected = true;
      callbacks.onOpen();
      if (isReconnect) callbacks.onReconnected();
      if (openResolver) {
        openResolver();
        openResolver = null;
        openRejector = null;
      }
    },
    onError(message, statusCode) {
      connected = false;
      callbacks.onError(message, statusCode);
      if (openRejector) {
        openRejector(new Error(message));
        openResolver = null;
        openRejector = null;
      }
    },
  });

  function waitForOpen(timeoutMs = 5000) {
    return new Promise<void>((resolve, reject) => {
      if (connected || connection.isConnected()) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        openResolver = null;
        openRejector = null;
        reject(new Error('SSE connection timed out.'));
      }, timeoutMs);
      openResolver = () => {
        clearTimeout(timer);
        resolve();
      };
      openRejector = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
  }

  return {
    async connect(baseUrl, authorization, options = {}) {
      const normalized = normalizeBaseUrl(baseUrl);
      if (!normalized) {
        throw new Error('SSE base URL is empty.');
      }
      connection.connect({ baseUrl: normalized, authorization });
      if (options.failFast) {
        await waitForOpen(options.timeoutMs ?? 5000);
      }
    },
    disconnect() {
      connected = false;
      connection.disconnect();
      if (openRejector) {
        openRejector(new Error('SSE connection aborted.'));
        openResolver = null;
        openRejector = null;
      }
    },
    sendToWorker() {
      return false;
    },
  };
}

function createSharedWorkerTransport(callbacks: TransportCallbacks): Transport {
  let worker: SharedWorker | null = null;
  let connected = false;
  let openResolver: ((value: void) => void) | null = null;
  let openRejector: ((reason: Error) => void) | null = null;

  function ensureWorker() {
    if (worker) return worker;
    const instance = new SseSharedWorker();
    instance.port.onmessage = (event: MessageEvent<WorkerToTabMessage>) => {
      const message = event.data;
      if (!message || typeof message !== 'object') return;

      if (callbacks.onWorkerMessage?.(message)) {
        return;
      }

      if (message.type === 'packet') {
        callbacks.onPacket(message.packet);
        return;
      }
      if (message.type === 'connection.open') {
        connected = true;
        callbacks.onOpen();
        if (openResolver) {
          openResolver();
          openResolver = null;
          openRejector = null;
        }
        return;
      }
      if (message.type === 'connection.reconnected') {
        callbacks.onReconnected();
        return;
      }
      if (message.type === 'connection.error') {
        connected = false;
        callbacks.onError(message.message, message.statusCode);
        if (openRejector) {
          openRejector(new Error(message.message));
          openResolver = null;
          openRejector = null;
        }
      }
    };
    instance.port.start();
    worker = instance;
    return instance;
  }

  function waitForOpen(timeoutMs = 5000) {
    return new Promise<void>((resolve, reject) => {
      if (connected) {
        resolve();
        return;
      }
      const timer = setTimeout(() => {
        openResolver = null;
        openRejector = null;
        reject(new Error('SSE connection timed out.'));
      }, timeoutMs);
      openResolver = () => {
        clearTimeout(timer);
        resolve();
      };
      openRejector = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
  }

  return {
    async connect(baseUrl, authorization, options = {}) {
      const normalized = normalizeBaseUrl(baseUrl);
      if (!normalized) {
        throw new Error('SSE base URL is empty.');
      }
      connected = false;
      const message: TabToWorkerMessage = {
        type: 'connect',
        baseUrl: normalized,
        authorization,
      };
      ensureWorker().port.postMessage(message);
      if (options.failFast) {
        await waitForOpen(options.timeoutMs ?? 5000);
      }
    },
    disconnect() {
      connected = false;
      if (worker) {
        const message: TabToWorkerMessage = { type: 'disconnect' };
        worker.port.postMessage(message);
      }
      if (openRejector) {
        openRejector(new Error('SSE connection aborted.'));
        openResolver = null;
        openRejector = null;
      }
    },
    sendToWorker(message) {
      if (!worker) return false;
      worker.port.postMessage(message);
      return true;
    },
  };
}

export function useGlobalEvents(credentials: CredentialsBinding) {
  const emitter = new TypedEmitter<GlobalEventMap>();
  let workerMessageHandler: ((message: WorkerToTabMessage) => boolean) | undefined;

  function routePacket(packet: SsePacket) {
    const type = packet.payload.type;
    if (!isKnownEventType(type)) return;
    emitter.emit(type, packet.payload.properties as GlobalEventMap[typeof type]);
  }

  const transport =
    typeof SharedWorker !== 'undefined'
      ? createSharedWorkerTransport({
          onPacket: routePacket,
          onOpen: () => emitter.emit('connection.open', {}),
          onError: (message, statusCode) =>
            emitter.emit('connection.error', { message, statusCode }),
          onReconnected: () => emitter.emit('connection.reconnected', {}),
          onWorkerMessage: (message) => workerMessageHandler?.(message) ?? false,
        })
      : createDirectTransport({
          onPacket: routePacket,
          onOpen: () => emitter.emit('connection.open', {}),
          onError: (message, statusCode) =>
            emitter.emit('connection.error', { message, statusCode }),
          onReconnected: () => emitter.emit('connection.reconnected', {}),
          onWorkerMessage: (message) => workerMessageHandler?.(message) ?? false,
        });

  let requested = false;
  let lastKey = '';
  const stopCredentialSync = watch(
    [() => credentials.baseUrl.value, () => credentials.authHeader.value],
    ([baseUrl, authHeader]) => {
      if (!requested) return;
      const normalized = normalizeBaseUrl(baseUrl);
      if (!normalized) {
        transport.disconnect();
        lastKey = '';
        return;
      }
      const nextKey = `${normalized}\u0000${authHeader ?? ''}`;
      if (nextKey === lastKey) return;
      lastKey = nextKey;
      void transport.connect(normalized, authHeader);
    },
  );

  async function connect(options: ConnectOptions = {}) {
    const baseUrl = normalizeBaseUrl(credentials.baseUrl.value);
    if (!baseUrl) throw new Error('SSE base URL is empty.');
    requested = true;
    lastKey = `${baseUrl}\u0000${credentials.authHeader.value ?? ''}`;
    await transport.connect(baseUrl, credentials.authHeader.value, options);
  }

  function disconnect() {
    requested = false;
    lastKey = '';
    transport.disconnect();
  }

  function setWorkerMessageHandler(handler?: (message: WorkerToTabMessage) => boolean) {
    workerMessageHandler = handler;
  }

  function sendToWorker(message: TabToWorkerMessage) {
    return transport.sendToWorker(message);
  }

  function onKnown<K extends EventKey>(event: K, listener: (payload: GlobalEventMap[K]) => void) {
    return emitter.on(event, listener);
  }

  function on<K extends EventKey>(
    event: K,
    listener: (payload: GlobalEventMap[K]) => void,
  ): () => void;
  function on(event: string, listener: (payload: unknown) => void): () => void;
  function on(event: string, listener: (payload: unknown) => void): () => void {
    if (!isKnownEventType(event)) return () => {};
    return onKnown(event, (payload) => listener(payload));
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
    function scopedOn(event: string, listener: (payload: unknown) => void): () => void;
    function scopedOn(event: string, listener: (payload: unknown) => void): () => void {
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
    function scopedOn(event: string, listener: (payload: unknown) => void): () => void;
    function scopedOn(event: string, listener: (payload: unknown) => void): () => void {
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

  const stopAutoDisconnect = watch(
    () => credentials.baseUrl.value,
    (baseUrl) => {
      if (baseUrl.trim()) return;
      disconnect();
    },
  );

  return {
    on,
    connect,
    disconnect,
    setWorkerMessageHandler,
    sendToWorker,
    session,
    mainSession,
    dispose() {
      stopCredentialSync();
      stopAutoDisconnect();
      disconnect();
    },
  };
}

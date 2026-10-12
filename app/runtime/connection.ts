import { decodeBinary, decodeFrame, encodeFrame, LIMITS, type Frame, type Hello, type Request } from '../../shared/runtime/protocol.js';
import type { ErrorCode } from '../../shared/runtime/capabilities.js';
import { connectionError, parseConnectionReference, RuntimeConnectionError, type ConnectionReference, type RuntimeAuthentication } from './connectionProfile';

export type RuntimeConnectionStatus = Readonly<{ state: 'idle' | 'connecting' | 'ready' | 'disconnected' | 'error'; generation: number; error?: Readonly<{ code: ErrorCode; message: string }> }>;
export type RuntimeConnectionEvent =
  | Readonly<{ kind: 'hello'; hello: Hello; generation: number }>
  | Readonly<{ kind: 'frame'; frame: Frame; generation: number }>
  | Readonly<{ kind: 'binary'; bytes: Uint8Array; generation: number }>
  | Readonly<{ kind: 'disconnected'; generation: number }>
  | Readonly<{ kind: 'error'; error: Readonly<{ code: ErrorCode; message: string }>; generation: number }>;
export type RuntimeSocket = Pick<WebSocket, 'binaryType' | 'readyState' | 'bufferedAmount' | 'close' | 'addEventListener' | 'removeEventListener'> & { send(data: string | Uint8Array<ArrayBuffer>): void };
export type RuntimeConnection = Readonly<{
  connect(): Promise<Hello>; send(frame: Request | Uint8Array): void;
  subscribe(listener: (event: RuntimeConnectionEvent) => void): () => void;
  reserveOutbound(bytes: number): () => void;
  disconnect(): void; dispose(): void;
  status: RuntimeConnectionStatus; bufferedAmount: number;
}>;
export type RuntimeConnectionOptions = Readonly<{
  reference: ConnectionReference;
  resolveAuthentication(reference: ConnectionReference): Promise<RuntimeAuthentication>;
  createWebSocket?: (url: string) => RuntimeSocket;
  clock?: () => number;
  timers?: Readonly<{ setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout }>;
}>;

export function createRuntimeConnection(options: RuntimeConnectionOptions): RuntimeConnection {
  const reference = parseConnectionReference(options.reference);
  const timers = options.timers ?? { setTimeout: setTimeout.bind(globalThis), clearTimeout: clearTimeout.bind(globalThis) };
  const clock = options.clock ?? Date.now;
  const createSocket = options.createWebSocket ?? ((url: string) => new WebSocket(url));
  const listeners = new Set<(event: RuntimeConnectionEvent) => void>();
  let status: RuntimeConnectionStatus = Object.freeze({ state: 'idle', generation: 0 });
  let socket: RuntimeSocket | undefined;
  let hello: Hello | undefined;
  let disposed = false;
  let retained = 0;
  let budgetOwner = {};
  let retries = 0;
  let removeSocketListeners = () => {};
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let pending: Readonly<{ promise: Promise<Hello>; resolve: (hello: Hello) => void; reject: (error: RuntimeConnectionError) => void }> | undefined;
  const emit = (event: RuntimeConnectionEvent) => { for (const listener of Array.from(listeners)) listener(event); };
  function clearTimers() {
    if (deadline !== undefined) timers.clearTimeout(deadline);
    if (reconnect !== undefined) timers.clearTimeout(reconnect);
    deadline = reconnect = undefined;
  }
  function releaseSocket() {
    removeSocketListeners(); removeSocketListeners = () => {};
    const previous = socket; socket = undefined; hello = undefined; retained = 0; budgetOwner = {};
    previous?.close();
  }
  function end(error?: RuntimeConnectionError) {
    clearTimers();
    pending?.reject(error ?? new RuntimeConnectionError('cancelled')); pending = undefined;
    releaseSocket();
    const publicError = error ? Object.freeze({ code: error.code, message: error.message }) : undefined;
    status = Object.freeze({ state: error ? 'error' : 'disconnected', generation: status.generation, ...(publicError ? { error: publicError } : {}) });
    if (publicError) emit({ kind: 'error', error: publicError, generation: status.generation });
    emit({ kind: 'disconnected', generation: status.generation });
  }
  function begin(): Promise<Hello> {
    if (disposed) return Promise.reject(new RuntimeConnectionError('cancelled'));
    if (pending) return pending.promise;
    if (hello && status.state === 'ready') return Promise.resolve(hello);
    clearTimers();
    status = Object.freeze({ state: 'connecting', generation: status.generation + 1 });
    const generation = status.generation;
    const started = clock();
    const current = () => !disposed && status.generation === generation && status.state === 'connecting';
    let resolveHello: (value: Hello) => void = () => {};
    let rejectHello: (error: RuntimeConnectionError) => void = () => {};
    const promise = new Promise<Hello>((resolve, reject) => { resolveHello = resolve; rejectHello = reject; });
    pending = { promise, resolve: resolveHello, reject: rejectHello };
    deadline = timers.setTimeout(() => { if (current()) end(new RuntimeConnectionError('timeout')); }, 15000);
    void Promise.resolve().then(() => options.resolveAuthentication(reference)).then(authentication => {
      if (!current()) return;
      if (clock() - started >= 15000) { end(new RuntimeConnectionError('timeout')); return; }
      const privateUrl = new URL(reference.url);
      if (authentication.bridgeToken) privateUrl.searchParams.set('token', authentication.bridgeToken);
      const owned = createSocket(privateUrl.toString());
      socket = owned; owned.binaryType = 'arraybuffer';
      const owns = () => !disposed && status.generation === generation && socket === owned;
      const onMessage = (event: Event) => {
        if (!owns()) return;
        try {
          const data = 'data' in event ? event.data : undefined;
          if (typeof data !== 'string') {
            if (!hello || !(data instanceof ArrayBuffer)) throw new RuntimeConnectionError('invalid_request');
            const bytes = new Uint8Array(data); decodeBinary(bytes);
            emit({ kind: 'binary', bytes, generation }); return;
          }
          const frame = decodeFrame(data);
          if (!hello) {
            if (frame.kind !== 'hello') throw new RuntimeConnectionError('invalid_request');
            if (reference.expectedEnvironmentId && reference.expectedEnvironmentId !== frame.target) throw new RuntimeConnectionError('conflict');
            hello = frame;
            if (deadline !== undefined) timers.clearTimeout(deadline);
            deadline = undefined;
            status = Object.freeze({ state: 'ready', generation });
            const waiting = pending; pending = undefined;
            emit({ kind: 'hello', hello: frame, generation }); waiting?.resolve(frame); return;
          }
          if (frame.kind === 'hello') throw new RuntimeConnectionError('conflict');
          const publicFrame = frame.kind === 'result' && !frame.ok
            ? { ...frame, typedError: { code: frame.typedError.code, message: `Runtime response: ${frame.typedError.code}` } }
            : frame;
          emit({ kind: 'frame', frame: publicFrame, generation });
        } catch (error) { if (owns()) end(connectionError(error)); }
      };
      const onError = () => { if (owns()) end(new RuntimeConnectionError('source_unavailable')); };
      const onClose = () => {
        if (!owns()) return;
        const wasReady = status.state === 'ready'; end();
        if (wasReady && retries < 3 && !disposed) {
          const delay = [250, 1000, 4000][retries++];
          reconnect = timers.setTimeout(() => { if (!disposed && status.generation === generation && status.state === 'disconnected') void begin().catch(() => undefined); }, delay);
        }
      };
      owned.addEventListener('message', onMessage); owned.addEventListener('error', onError); owned.addEventListener('close', onClose);
      removeSocketListeners = () => {
        owned.removeEventListener('message', onMessage); owned.removeEventListener('error', onError); owned.removeEventListener('close', onClose);
      };
    }).catch(error => { if (current()) end(connectionError(error)); });
    return promise;
  }
  function requireReady() {
    if (disposed || status.state !== 'ready' || !socket || socket.readyState !== 1) throw new RuntimeConnectionError('source_unavailable');
    return socket;
  }
  function checkBudget(bytes: number) {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RuntimeConnectionError('invalid_request');
    if (retained + (socket?.bufferedAmount ?? 0) + bytes > LIMITS.outboundBytes) throw new RuntimeConnectionError('source_unavailable');
  }
  return {
    get status() { return status; },
    get bufferedAmount() { return retained + (socket?.bufferedAmount ?? 0); },
    connect() { retries = 0; return begin(); },
    send(frame) {
      const owned = requireReady();
      let data: string | Uint8Array<ArrayBuffer>;
      if (frame instanceof Uint8Array) { decodeBinary(frame); data = new Uint8Array(frame); }
      else { if (frame.kind !== 'request') throw new RuntimeConnectionError('invalid_request'); data = encodeFrame(frame); }
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data).byteLength : data.byteLength;
      // Retained caller bytes and socket buffers count independently until their owners release them.
      checkBudget(bytes);
      try { owned.send(data); } catch (error) { const safe = connectionError(error); end(safe); throw safe; }
    },
    reserveOutbound(bytes) {
      requireReady(); checkBudget(bytes); retained += bytes;
      const generation = status.generation;
      const owner = budgetOwner;
      let released = false;
      return () => { if (!released && generation === status.generation && owner === budgetOwner) retained -= bytes; released = true; };
    },
    subscribe(listener) {
      if (disposed) throw new RuntimeConnectionError('cancelled');
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
    disconnect() { if (!disposed) { end(); status = Object.freeze({ state: 'disconnected', generation: status.generation + 1 }); } },
    dispose() { if (!disposed) { end(); disposed = true; status = Object.freeze({ state: 'disconnected', generation: status.generation + 1 }); listeners.clear(); } },
  };
}

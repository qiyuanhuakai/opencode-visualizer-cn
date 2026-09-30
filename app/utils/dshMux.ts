/**
 * dsh web WS mux client — the browser side of the `/dsh/ws` bridge route.
 *
 * Transport boundary (plan Todo 5; docs/dsh.md §6):
 * - The frontend only ever connects to the **bridge** WebSocket URL. The
 *   credential is the **bridge token**, resolved via `getBridgeToken()` and
 *   attached exactly like every other bridge WS route (`?token=…`, see
 *   `appendCodexBridgeToken`). The dsh upstream cookie is never held, read, or
 *   sent here — cookie injection lives on the bridge side only, and the
 *   upstream dsh URL never appears in this module.
 * - The bridge is a byte pipe for this route: frame contents are the upstream
 *   mux frames verbatim, endpoints keep their upstream names
 *   (`$events`, `workspace/follow`, `session/follow`, …).
 * - Frame vocabulary is exactly the upstream one (docs/dsh.md §6.2):
 *   `open` / `item` / `end` / `cancel` (client→host) and `item` / `end` /
 *   `error` (host→client). Nothing else is defined; in particular there is no
 *   application-layer heartbeat frame — the host's 2s protocol-level ping is
 *   answered automatically by the browser/`ws` implementation, so this module
 *   must never synthesize heartbeat frames of its own.
 * - Frames arriving for an unknown or already-settled stream are late frames:
 *   the host silently drops them (docs/dsh.md §6.2), and so does this client.
 *
 * Failure policy:
 * - A `close` event (server terminate or network drop) schedules an
 *   exponential-backoff reconnect and re-opens every in-flight stream. Resume
 *   parameters are supplied by the upper layer at `open()` time, so replay
 *   semantics stay owned above this module (the replay boundary contract).
 * - A binary frame or unusable frame text is a protocol violation: in-flight
 *   streams fail immediately and the client does **not** reconnect — retrying
 *   would only replay the violation.
 *
 * The client is frame-layer only: it never interprets payload business
 * semantics. Inbound validation is delegated to the Todo 3 classified wire
 * parser (`parseDshWireLine`), so a frame the host would reject is rejected
 * here with a classified error instead of being silently accepted.
 */

import { appendCodexBridgeToken } from '../backends/codex/bridgeUrl';
import {
  parseDshWireLine,
  type DshJsonValue,
  type DshMuxCancelFrame,
  type DshMuxClientFrame,
  type DshMuxEndFrame,
  type DshMuxFrame,
  type DshMuxItemFrame,
  type DshMuxOpenFrame,
  type DshRpcArgs,
  type DshRemoteError,
} from '../backends/dsh/types';

// ---------------------------------------------------------------------------
// Pure frame codecs (exported for unit tests and for upper layers that need
// to construct exact wire frames)
// ---------------------------------------------------------------------------

export function buildDshMuxOpenFrame(streamId: string, endpoint: string, payload: DshRpcArgs): DshMuxOpenFrame {
  return { type: 'open', streamId, endpoint, payload };
}

export function buildDshMuxItemFrame(streamId: string, value?: DshJsonValue): DshMuxItemFrame {
  return value === undefined ? { type: 'item', streamId } : { type: 'item', streamId, value };
}

export function buildDshMuxEndFrame(streamId: string): DshMuxEndFrame {
  return { type: 'end', streamId };
}

export function buildDshMuxCancelFrame(streamId: string): DshMuxCancelFrame {
  return { type: 'cancel', streamId };
}

/** Serializes a client frame to its wire text (one JSON mux frame). */
export function encodeDshMuxFrame(frame: DshMuxClientFrame): string {
  return JSON.stringify(frame);
}

/** Parses wire text into a mux frame via the Todo 3 classified parser. */
export function decodeDshMuxFrame(text: string): DshMuxFrame {
  return parseDshWireLine(text);
}

/**
 * Builds the bridge socket URL for a connection attempt. The bridge token is
 * attached per the shared bridge WS convention; nothing else is added.
 */
export function dshMuxBridgeUrl(bridgeUrl: string, token?: string | null): string {
  const trimmed = bridgeUrl.trim();
  if (!trimmed) throw new Error('dsh mux bridge URL is required.');
  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw new Error(`dsh mux bridge URL must be ws:// or wss:// (got ${parsed.protocol})`);
  }
  return appendCodexBridgeToken(parsed.toString(), token ?? undefined);
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type DshMuxErrorCode =
  /** Host sent an `error` frame; `remoteError` carries the wire error. */
  | 'stream-error'
  /** Local `cancel()`. */
  | 'stream-cancelled'
  /** Host sent a `cancel` frame for the stream. */
  | 'host-cancelled'
  /** Host sent a client-only frame type (e.g. `open`). */
  | 'unexpected-server-frame'
  /** Non-text frame: protocol violation, no reconnect. */
  | 'binary-frame'
  /** Unparseable or classified-invalid frame text: protocol violation, no reconnect. */
  | 'invalid-json'
  /** Socket failed before opening (connect() only; reconnects continue). */
  | 'connection-failed'
  /** `getBridgeToken()` failed or returned nothing usable. */
  | 'bridge-token-unavailable'
  /** `disconnect()` was called. */
  | 'disposed';

export class DshMuxError extends Error {
  readonly code: DshMuxErrorCode;
  /** The wire error of the host `error` frame that failed this stream. */
  readonly remoteError?: DshRemoteError;

  constructor(
    code: DshMuxErrorCode,
    message: string,
    options: { remoteError?: DshRemoteError; cause?: unknown } = {},
  ) {
    super(message);
    this.name = 'DshMuxError';
    this.code = code;
    if (options.remoteError !== undefined) this.remoteError = options.remoteError;
    if (options.cause !== undefined) this.cause = options.cause;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Structural socket + injectable seams
// ---------------------------------------------------------------------------

export type DshMuxSocketEvent = { data?: unknown };

/** Minimal structural view of a WebSocket (browser or `ws`). */
export type DshMuxSocket = {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: () => void): void;
  addEventListener(type: 'message', listener: (event: DshMuxSocketEvent) => void): void;
  addEventListener(type: 'error' | 'close', listener: (event?: unknown) => void): void;
};

export type DshMuxSocketCtor = new (url: string) => DshMuxSocket;

/** Injectable timer seam so backoff is deterministic under test. */
export type DshMuxScheduler = {
  /** Schedules `callback` after `delayMs`; the returned function cancels it. */
  setTimeout(callback: () => void, delayMs: number): () => void;
};

const DEFAULT_SCHEDULER: DshMuxScheduler = {
  setTimeout(callback, delayMs) {
    const id = setTimeout(callback, delayMs);
    return () => clearTimeout(id);
  },
};

/** Mirrors the kimi web client: 500ms → 8s, last entry repeats. */
export const DEFAULT_DSH_MUX_RECONNECT_DELAYS_MS: readonly number[] = [500, 1000, 2000, 4000, 8000];

const SOCKET_OPEN = 1;

// ---------------------------------------------------------------------------
// Client surface
// ---------------------------------------------------------------------------

/** Parameters a stream is (re-)opened with. */
export type DshMuxOpenParams = {
  endpoint: string;
  payload: DshRpcArgs;
};

export type DshMuxOpenOptions = {
  /**
   * Params used to re-open this stream after a reconnect. Injected from above
   * because only the upper layer knows the replay/resume semantics (replay
   * boundary contract). Defaults to the original open params.
   */
  resume?: DshMuxOpenParams | ((streamId: string) => DshMuxOpenParams);
};

export type DshMuxStreamHandle = {
  readonly streamId: string;
  /** Resolves with every accumulated item value on `end`; rejects on `error` or client failure. */
  readonly promise: Promise<readonly (DshJsonValue | undefined)[]>;
  /** Live item callback; the returned function unsubscribes. */
  onItem(listener: (value: DshJsonValue | undefined) => void): () => void;
  /** Sends `cancel` for this stream and settles it. */
  cancel(): void;
};

export type DshMuxClientOptions = {
  /** Bridge WS URL, e.g. `ws://localhost:23004/dsh/ws`. */
  url: string;
  /** Bridge token resolver; resolved once per connection attempt. */
  getBridgeToken?: () => string | null | undefined | Promise<string | null | undefined>;
  /** Injectable WebSocket constructor (tests). Defaults to the global WebSocket. */
  webSocketCtor?: DshMuxSocketCtor;
  /** Injectable timer seam (tests). Defaults to real timers. */
  scheduler?: DshMuxScheduler;
  /** Backoff schedule in ms; the last entry repeats. Defaults to 500→8000. */
  reconnectDelaysMs?: readonly number[];
  /** Auto-reconnect on close (default true). */
  autoReconnect?: boolean;
};

export type DshMuxClient = {
  /** Ensures a socket; resolves when it is open. */
  connect(): Promise<void>;
  /** Opens a stream and returns its handle (auto-connects when needed). */
  open(endpoint: string, payload: DshRpcArgs, options?: DshMuxOpenOptions): DshMuxStreamHandle;
  /** Sends `cancel` for a stream id; unknown ids are ignored (late frames). */
  cancel(streamId: string): void;
  /** Permanent teardown: settles in-flight streams and stops reconnecting. */
  disconnect(): void;
  isConnected(): boolean;
};

type StreamRecord = {
  readonly streamId: string;
  readonly endpoint: string;
  readonly payload: DshRpcArgs;
  readonly resume?: DshMuxOpenOptions['resume'];
  readonly items: (DshJsonValue | undefined)[];
  readonly itemListeners: Set<(value: DshJsonValue | undefined) => void>;
  readonly promise: Promise<readonly (DshJsonValue | undefined)[]>;
  readonly resolveFn: (values: readonly (DshJsonValue | undefined)[]) => void;
  readonly rejectFn: (error: Error) => void;
  settled: boolean;
  /** The `open` frame is (re)sent on the next open socket while false. */
  openSent: boolean;
};

export function createDshMuxClient(options: DshMuxClientOptions): DshMuxClient {
  const scheduler = options.scheduler ?? DEFAULT_SCHEDULER;
  const delays =
    options.reconnectDelaysMs && options.reconnectDelaysMs.length > 0
      ? options.reconnectDelaysMs
      : DEFAULT_DSH_MUX_RECONNECT_DELAYS_MS;
  const autoReconnect = options.autoReconnect ?? true;
  const webSocketCtor =
    options.webSocketCtor ?? (globalThis.WebSocket as unknown as DshMuxSocketCtor | undefined);

  const streams = new Map<string, StreamRecord>();
  let streamCounter = 0;
  let socket: DshMuxSocket | null = null;
  let connecting: Promise<void> | null = null;
  let reconnectTimer: (() => void) | null = null;
  let reconnectAttempt = 0;
  /** Set by disconnect() or a fatal frame: no further reconnects. */
  let stopped = false;
  let fatalError: DshMuxError | null = null;
  let disposedError: DshMuxError | null = null;
  /** Rejects the in-flight `connect()` promise when its socket dies early. */
  let openWaiterReject: ((error: Error) => void) | null = null;

  function isConnected(): boolean {
    return socket !== null && socket.readyState === SOCKET_OPEN;
  }

  function createRecord(
    streamId: string,
    endpoint: string,
    payload: DshRpcArgs,
    resume: DshMuxOpenOptions['resume'],
  ): StreamRecord {
    let resolveFn!: (values: readonly (DshJsonValue | undefined)[]) => void;
    let rejectFn!: (error: Error) => void;
    const promise = new Promise<readonly (DshJsonValue | undefined)[]>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });
    // Streams nobody awaits must not surface as unhandled rejections; callers
    // attach their own handlers to the very same promise.
    void promise.catch(() => undefined);
    return {
      streamId,
      endpoint,
      payload,
      resume,
      items: [],
      itemListeners: new Set(),
      promise,
      resolveFn,
      rejectFn,
      settled: false,
      openSent: false,
    };
  }

  function settle(
    record: StreamRecord,
    outcome:
      | { ok: true; values: readonly (DshJsonValue | undefined)[] }
      | { ok: false; error: DshMuxError },
  ): void {
    if (record.settled) return;
    record.settled = true;
    streams.delete(record.streamId);
    if (outcome.ok) record.resolveFn(outcome.values.slice());
    else record.rejectFn(outcome.error);
  }

  function rejectAll(error: DshMuxError): void {
    for (const record of streams.values()) settle(record, { ok: false, error });
    streams.clear();
  }

  function resolveOpenParams(record: StreamRecord): DshMuxOpenParams {
    if (!record.resume) return { endpoint: record.endpoint, payload: record.payload };
    return typeof record.resume === 'function' ? record.resume(record.streamId) : record.resume;
  }

  function flushPendingOpens(): void {
    if (!isConnected() || socket === null) return;
    for (const record of streams.values()) {
      if (record.openSent) continue;
      record.openSent = true;
      const params = resolveOpenParams(record);
      socket.send(encodeDshMuxFrame(buildDshMuxOpenFrame(record.streamId, params.endpoint, params.payload)));
    }
  }

  function scheduleReconnect(): void {
    if (stopped || !autoReconnect || reconnectTimer !== null) return;
    const delay = delays[Math.min(reconnectAttempt, delays.length - 1)];
    reconnectAttempt += 1;
    reconnectTimer = scheduler.setTimeout(() => {
      reconnectTimer = null;
      void ensureConnection().catch(() => {
        // The next failure path (close or another rejection) schedules again.
      });
    }, delay);
  }

  async function attemptConnection(validatedUrl: string): Promise<void> {
    if (!webSocketCtor) {
      throw new DshMuxError('connection-failed', 'dsh mux: no WebSocket implementation is available');
    }
    let token: string | null | undefined;
    try {
      token = await options.getBridgeToken?.();
    } catch (error) {
      throw new DshMuxError('bridge-token-unavailable', `dsh mux: bridge token unavailable (${errorMessage(error)})`, {
        cause: error,
      });
    }
    const ws = new webSocketCtor(dshMuxBridgeUrl(validatedUrl, token));
    socket = ws;
    await new Promise<void>((resolve, reject) => {
      openWaiterReject = reject;
      const settleWaiter = (error?: DshMuxError) => {
        if (openWaiterReject === reject) openWaiterReject = null;
        if (error) reject(error);
        else resolve();
      };
      ws.addEventListener('open', () => {
        settleWaiter();
        reconnectAttempt = 0;
        flushPendingOpens();
      });
      ws.addEventListener('message', (event) => handleSocketMessage(event));
      ws.addEventListener('error', () => {
        settleWaiter(new DshMuxError('connection-failed', 'dsh mux: websocket error'));
      });
      ws.addEventListener('close', () => {
        if (socket === ws) socket = null;
        settleWaiter(new DshMuxError('connection-failed', 'dsh mux: websocket closed before open'));
        if (stopped) return;
        // Every in-flight stream must be re-opened on the next socket.
        for (const record of streams.values()) record.openSent = false;
        scheduleReconnect();
      });
    });
  }

  function ensureConnection(): Promise<void> {
    if (disposedError) return Promise.reject(disposedError);
    if (fatalError) return Promise.reject(fatalError);
    if (isConnected()) return Promise.resolve();
    if (connecting) return connecting;
    // A missing socket implementation or an undialable bridge URL is a
    // permanent setup mistake: rejecting here keeps it from becoming an
    // infinite reconnect loop.
    if (!webSocketCtor) {
      return Promise.reject(
        new DshMuxError('connection-failed', 'dsh mux: no WebSocket implementation is available'),
      );
    }
    let url: string;
    try {
      url = dshMuxBridgeUrl(options.url);
    } catch (error) {
      return Promise.reject(
        new DshMuxError('connection-failed', `dsh mux: ${errorMessage(error)}`, { cause: error }),
      );
    }
    connecting = attemptConnection(url)
      .catch((error: unknown) => {
        scheduleReconnect();
        throw error instanceof DshMuxError
          ? error
          : new DshMuxError('connection-failed', `dsh mux: connection failed (${errorMessage(error)})`, {
              cause: error,
            });
      })
      .finally(() => {
        connecting = null;
      });
    return connecting;
  }

  function handleSocketMessage(event: DshMuxSocketEvent): void {
    if (stopped) return;
    if (typeof event.data !== 'string') {
      failConnection(new DshMuxError('binary-frame', 'dsh mux: binary frame received; the mux contract is text-only JSON'));
      return;
    }
    let frame: DshMuxFrame;
    try {
      frame = decodeDshMuxFrame(event.data);
    } catch (error) {
      failConnection(
        new DshMuxError('invalid-json', `dsh mux: unusable frame text (${errorMessage(error)})`, { cause: error }),
      );
      return;
    }
    routeFrame(frame);
  }

  function routeFrame(frame: DshMuxFrame): void {
    const record = streams.get(frame.streamId);
    if (!record || record.settled) return; // late frame: silently dropped
    switch (frame.type) {
      case 'item': {
        record.items.push(frame.value);
        const listeners = [...record.itemListeners];
        for (const listener of listeners) listener(frame.value);
        return;
      }
      case 'end':
        settle(record, { ok: true, values: record.items });
        return;
      case 'error':
        settle(record, {
          ok: false,
          error: new DshMuxError('stream-error', frame.error.message, { remoteError: frame.error }),
        });
        return;
      case 'cancel':
        settle(record, {
          ok: false,
          error: new DshMuxError('host-cancelled', `dsh mux: host cancelled stream ${frame.streamId}`),
        });
        return;
      case 'open':
        settle(record, {
          ok: false,
          error: new DshMuxError(
            'unexpected-server-frame',
            `dsh mux: host sent a client-only open frame for stream ${frame.streamId}`,
          ),
        });
        return;
    }
  }

  /** Binary / invalid frames fail every stream and forbid reconnecting. */
  function failConnection(error: DshMuxError): void {
    if (stopped) return;
    stopped = true;
    fatalError = error;
    if (reconnectTimer !== null) {
      reconnectTimer();
      reconnectTimer = null;
    }
    const dead = socket;
    socket = null;
    if (openWaiterReject) {
      const reject = openWaiterReject;
      openWaiterReject = null;
      reject(new DshMuxError('connection-failed', `dsh mux: connection failed (${error.code})`, { cause: error }));
    }
    rejectAll(error);
    try {
      dead?.close();
    } catch {
      // A socket that cannot be closed is already gone.
    }
  }

  function handleFor(record: StreamRecord): DshMuxStreamHandle {
    return {
      streamId: record.streamId,
      promise: record.promise,
      onItem(listener) {
        if (record.settled) return () => undefined;
        record.itemListeners.add(listener);
        return () => {
          record.itemListeners.delete(listener);
        };
      },
      cancel() {
        cancel(record.streamId);
      },
    };
  }

  function open(endpoint: string, payload: DshRpcArgs, openOptions: DshMuxOpenOptions = {}): DshMuxStreamHandle {
    if (typeof endpoint !== 'string' || endpoint.length === 0) {
      throw new TypeError('dsh mux: open endpoint must be a non-empty string');
    }
    if (typeof payload !== 'object' || payload === null || typeof (payload as DshRpcArgs).args !== 'object') {
      throw new TypeError('dsh mux: open payload must be { args: { ... } }');
    }
    streamCounter += 1;
    const streamId = String(streamCounter);
    const record = createRecord(streamId, endpoint, payload, openOptions.resume);
    const handle = handleFor(record);
    if (disposedError) {
      settle(record, { ok: false, error: disposedError });
      return handle;
    }
    if (fatalError) {
      settle(record, { ok: false, error: fatalError });
      return handle;
    }
    streams.set(streamId, record);
    if (isConnected()) flushPendingOpens();
    else void ensureConnection().catch(() => undefined);
    return handle;
  }

  function cancel(streamId: string): void {
    const record = streams.get(streamId);
    if (!record) return;
    settle(record, {
      ok: false,
      error: new DshMuxError('stream-cancelled', `dsh mux: stream ${streamId} cancelled locally`),
    });
    if (isConnected() && socket !== null) {
      try {
        socket.send(encodeDshMuxFrame(buildDshMuxCancelFrame(streamId)));
      } catch {
        // Socket torn down mid-cancel: the stream is already settled locally.
      }
    }
  }

  function disconnect(): void {
    stopped = true;
    disposedError = new DshMuxError('disposed', 'dsh mux: client disconnected');
    if (reconnectTimer !== null) {
      reconnectTimer();
      reconnectTimer = null;
    }
    if (openWaiterReject) {
      const reject = openWaiterReject;
      openWaiterReject = null;
      reject(disposedError);
    }
    const dead = socket;
    socket = null;
    rejectAll(disposedError);
    try {
      dead?.close();
    } catch {
      // Already gone.
    }
  }

  return {
    connect: () => ensureConnection(),
    open,
    cancel,
    disconnect,
    isConnected,
  };
}

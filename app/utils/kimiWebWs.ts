/**
 * Public surface of the kimi web WebSocket client; Todos 14/18/22 import from
 * here and nowhere deeper. Protocol invariants implemented (measured, see
 * `.omo/evidence/kimi-web-adapt/task-26/REPLAY-BOUNDARY-CONTRACT.md`):
 * - The `ack` of a control frame is the replay -> live switch point and the
 *   server emits it after the replayed durable frames.
 * - Volatile frames are never replayed and never advance a cursor; durable
 *   frames do, so a reconnect resubscribes from each session's cursor.
 * - `resync_required` (standalone frame or `ack.payload.resync_required[]`)
 *   surfaces through `onResyncRequired` even though `ack.code` stays 0.
 * - A hung subscription (no ack) recycles the connection instead of hanging.
 * - Non-manual closes are classified via the REST precheck before the UI sees
 *   them, so a generic close is never reported as an upstream 401.
 *
 * Implementation is split by responsibility: `kimiWebWsProtocol.ts` (wire
 * vocabulary, parsing, cursors, URL helpers), `kimiWebWsConnection.ts` (socket
 * lifecycle + reconnect) and `kimiWebWsCloseClassification.ts` (REST precheck).
 */

import { createKimiWebWsConnection } from './kimiWebWsConnection';
import { createKimiWebWsControlChannel } from './kimiWebWsControl';
import {
  applyAckCursors,
  cursorsFor,
  errorMessage,
  kimiWebProxyHttpUrl,
  parseFrameText,
  readAckResyncSessions,
  readPingNonce,
  readResyncFrame,
  readServerHello,
  trackDurableFrame,
  KimiWebWsError,
  type KimiWebWsAck,
  type KimiWebWsCursor,
  type KimiWebWsCursorMap,
  type KimiWebWsFrame,
  type KimiWebWsHello,
  type KimiWebWsResyncRequest,
  type KimiWebWsSocketCtor,
  type KimiWebWsSocketEvent,
} from './kimiWebWsProtocol';
import {
  classifyKimiWebWsClose,
  type KimiWebWsCloseInfo,
  type KimiWebWsFetcher,
} from './kimiWebWsCloseClassification';

const DEFAULT_ACK_TIMEOUT_MS = 5000;
const DEFAULT_PRECHECK_TIMEOUT_MS = 4000;

export type KimiWebWsClientOptions = {
  /** Bridge proxy WS URL, e.g. `kimiWebWsUrl(DEFAULT_KIMI_WEB_BRIDGE_URL, token)`. */
  url: string;
  /** Stable id sent in `client_hello`; generated when omitted. */
  clientId?: string;
  /** Bridge token used by the REST precheck (`Authorization: Bearer`). */
  getToken?: () => string | null | undefined | Promise<string | null | undefined>;
  /** Bridge REST proxy root; derived from `url` when omitted. */
  proxyHttpUrl?: string;
  webSocketCtor?: KimiWebWsSocketCtor;
  fetcher?: KimiWebWsFetcher;
  /** Auto-reconnect + cursor resubscribe on close; defaults to `true`. */
  autoReconnect?: boolean;
  /** Backoff schedule in ms; the last entry repeats. Defaults to 500→8000. */
  reconnectDelaysMs?: readonly number[];
  ackTimeoutMs?: number;
  precheckTimeoutMs?: number;
};

export type KimiWebWsClient = {
  /** Opens the socket and sends `client_hello` with subscriptions + cursors. */
  connect(): Promise<void>;
  /** Permanent teardown: closes the socket and stops auto-reconnect. */
  disconnect(): void;
  isConnected(): boolean;
  hello(): KimiWebWsHello | null;
  cursors(): Record<string, KimiWebWsCursor>;
  subscriptions(): string[];
  /** Adds subscriptions and sends `subscribe` with per-session cursors. */
  subscribe(sessionIds: string[], cursors?: Record<string, KimiWebWsCursor>): Promise<KimiWebWsAck>;
  unsubscribe(sessionIds: string[]): Promise<KimiWebWsAck>;
  /** WS abort (`{session_id, prompt_id}`); REST `:abort` stays available as fallback. */
  abort(sessionId: string, promptId: string): Promise<KimiWebWsAck>;
  /** Every parsed event frame, in arrival order (control frames excluded). */
  onFrame(listener: (frame: KimiWebWsFrame) => void): () => void;
  /** Snapshot rebuild signal; must trigger `GET …/snapshot` in the upper layer. */
  onResyncRequired(listener: (request: KimiWebWsResyncRequest) => void): () => void;
  /** Auto-reconnect socket opened and is about to send its cursor-bearing `client_hello`. */
  onReconnectStart(listener: () => void): () => void;
  /** Auto-reconnect replay ended at the matching `client_hello` ack (contract §5.1, lines 159-165). */
  onReconnectReady(listener: (ack: KimiWebWsAck) => void): () => void;
  onClose(listener: (info: KimiWebWsCloseInfo) => void): () => void;
};

export function createKimiWebWsClient(options: KimiWebWsClientOptions): KimiWebWsClient {
  const clientId =
    options.clientId ?? `kimi-web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
  const precheckTimeoutMs = options.precheckTimeoutMs ?? DEFAULT_PRECHECK_TIMEOUT_MS;
  const proxyHttpUrl = options.proxyHttpUrl ?? kimiWebProxyHttpUrl(options.url);
  const fetcher = options.fetcher ?? (globalThis.fetch as unknown as KimiWebWsFetcher | undefined);

  const cursors: KimiWebWsCursorMap = new Map();
  const subscriptions = new Set<string>();
  const notifiedResync = new Set<string>();
  const frameListeners = new Set<(frame: KimiWebWsFrame) => void>();
  const resyncListeners = new Set<(request: KimiWebWsResyncRequest) => void>();
  const closeListeners = new Set<(info: KimiWebWsCloseInfo) => void>();
  const reconnectStartListeners = new Set<() => void>();
  const reconnectReadyListeners = new Set<(ack: KimiWebWsAck) => void>();
  let helloFrame: KimiWebWsHello | null = null;

  const connection = createKimiWebWsConnection({
    url: options.url,
    webSocketCtor: options.webSocketCtor,
    autoReconnect: options.autoReconnect ?? true,
    reconnectDelaysMs: options.reconnectDelaysMs,
    onOpen: (reconnecting) => {
      notifiedResync.clear();
      const sessions = [...subscriptions];
      if (reconnecting) {
        for (const listener of reconnectStartListeners) listener();
      }
      const helloAck = control.send('client_hello', {
        client_id: clientId,
        subscriptions: sessions,
        ...cursorsFor(cursors, sessions),
      });
      if (reconnecting) {
        void helloAck.then((ack) => {
          for (const listener of reconnectReadyListeners) listener(ack);
        }).catch(() => undefined);
      }
    },
    onMessage: handleMessage,
    onClose: (event, manual) => {
      void handleClose(event, manual);
    },
  });

  const control = createKimiWebWsControlChannel({
    clientId,
    ackTimeoutMs,
    isOpen: () => connection.isOpen(),
    send: (text) => connection.send(text),
    recycle: () => connection.recycle(),
  });

  function emitResync(request: KimiWebWsResyncRequest) {
    if (notifiedResync.has(request.sessionId)) return;
    notifiedResync.add(request.sessionId);
    for (const listener of resyncListeners) listener(request);
  }

  function handleAckPayload(payload: Record<string, unknown> | undefined) {
    applyAckCursors(cursors, payload);
    for (const sessionId of readAckResyncSessions(payload)) {
      const cursor = cursors.get(sessionId);
      emitResync({
        sessionId,
        reason: 'ack',
        currentSeq: cursor?.seq,
        epoch: cursor?.epoch,
        source: 'ack',
      });
    }
  }

  function handleMessage(event: KimiWebWsSocketEvent) {
    if (typeof event.data !== 'string') return;
    const frame = parseFrameText(event.data);
    if (!frame) return;

    if (frame.type === 'server_hello') {
      helloFrame = readServerHello(frame);
      return;
    }
    if (frame.type === 'ping') {
      const pong = readPingNonce(frame.payload);
      if (!pong || !connection.isOpen()) return;
      connection.send(JSON.stringify({ type: 'pong', payload: pong }));
      return;
    }
    if (frame.type === 'ack') {
      handleAckPayload(control.handleAck(frame));
      return;
    }
    if (frame.type === 'resync_required') {
      const request = readResyncFrame(frame);
      if (request) emitResync(request);
      return;
    }
    if (frame.type === 'pong') return;

    trackDurableFrame(cursors, frame);
    for (const listener of frameListeners) listener(frame);
  }

  async function classifyAfterClose(code: number, reason: string) {
    let authorization: string | undefined;
    try {
      const token = await options.getToken?.();
      if (token) authorization = `Bearer ${token}`;
    } catch (error) {
      return {
        kind: 'bridge-credential' as const,
        detail: `Kimi Web bridge token is unavailable: ${errorMessage(error)}`,
      };
    }
    return classifyKimiWebWsClose({
      code,
      reason,
      proxyHttpUrl,
      authorization,
      fetcher,
      timeoutMs: precheckTimeoutMs,
    });
  }

  async function handleClose(event: KimiWebWsSocketEvent, manual: boolean) {
    const code = typeof event.code === 'number' ? event.code : 1006;
    const reason = typeof event.reason === 'string' ? event.reason : '';
    control.rejectAll(
      new KimiWebWsError('connection-failed', 'Kimi Web WebSocket closed; pending acks dropped.'),
    );
    const classification = manual ? null : await classifyAfterClose(code, reason);
    const info: KimiWebWsCloseInfo = {
      code,
      reason,
      wasClean: event.wasClean === true,
      manual,
      classification,
    };
    for (const listener of closeListeners) listener(info);
  }

  function subscribe(sessionIds: string[], nextCursors?: Record<string, KimiWebWsCursor>) {
    for (const sessionId of sessionIds) subscriptions.add(sessionId);
    if (nextCursors) {
      for (const [sessionId, cursor] of Object.entries(nextCursors)) {
        subscriptions.add(sessionId);
        // Caller-provided cursors are authoritative: a rebuild may deliberately
        // resubscribe from a snapshot boundary below the tracked cursor.
        cursors.set(sessionId, { ...cursor });
      }
    }
    notifiedResync.clear();
    return control.send('subscribe', { session_ids: sessionIds, ...cursorsFor(cursors, sessionIds) });
  }

  function unsubscribe(sessionIds: string[]) {
    for (const sessionId of sessionIds) subscriptions.delete(sessionId);
    return control.send('unsubscribe', { session_ids: sessionIds });
  }

  function disconnect() {
    control.rejectAll(new KimiWebWsError('disposed', 'Kimi Web WebSocket client was disconnected.'));
    connection.disconnect();
  }

  return {
    connect: () => connection.connect(),
    disconnect,
    isConnected: () => connection.isOpen(),
    hello: () => helloFrame,
    cursors: () =>
      Object.fromEntries([...cursors].map(([sessionId, cursor]) => [sessionId, { ...cursor }])),
    subscriptions: () => [...subscriptions],
    subscribe,
    unsubscribe,
    abort: (sessionId, promptId) =>
      control.send('abort', { session_id: sessionId, prompt_id: promptId }),
    onFrame: (listener) => {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    onResyncRequired: (listener) => {
      resyncListeners.add(listener);
      return () => resyncListeners.delete(listener);
    },
    onReconnectStart: (listener) => {
      reconnectStartListeners.add(listener);
      return () => reconnectStartListeners.delete(listener);
    },
    onReconnectReady: (listener) => {
      reconnectReadyListeners.add(listener);
      return () => reconnectReadyListeners.delete(listener);
    },
    onClose: (listener) => {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
  };
}

export { KimiWebWsError, kimiWebProxyHttpUrl, kimiWebWsUrl } from './kimiWebWsProtocol';
export type {
  KimiWebWsAck,
  KimiWebWsCursor,
  KimiWebWsErrorCode,
  KimiWebWsFrame,
  KimiWebWsHello,
  KimiWebWsResyncRequest,
  KimiWebWsSocket,
  KimiWebWsSocketCtor,
} from './kimiWebWsProtocol';
export type {
  KimiWebWsCloseClassification,
  KimiWebWsCloseInfo,
  KimiWebWsFailureKind,
  KimiWebWsFetcher,
} from './kimiWebWsCloseClassification';

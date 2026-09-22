/**
 * Socket lifecycle for the kimi web bridge route: dialing, cursor-blind
 * auto-reconnect with backoff, and manual teardown. Protocol meaning
 * (subscriptions, cursors, acks) lives in `kimiWebWs.ts`; this module only owns
 * "is there a live socket, and when do we dial the next one".
 */

import {
  KimiWebWsError,
  type KimiWebWsSocket,
  type KimiWebWsSocketCtor,
  type KimiWebWsSocketEvent,
} from './kimiWebWsProtocol';

const DEFAULT_RECONNECT_DELAYS_MS = [500, 1000, 2000, 4000, 8000];

export type KimiWebWsConnectionOptions = {
  url: string;
  webSocketCtor?: KimiWebWsSocketCtor;
  autoReconnect: boolean;
  /** Backoff schedule in ms; the last entry repeats. Defaults to 500→8000. */
  reconnectDelaysMs?: readonly number[];
  onOpen(reconnecting: boolean): void;
  onMessage(event: KimiWebWsSocketEvent): void;
  onClose(event: KimiWebWsSocketEvent, manual: boolean): void;
};

export type KimiWebWsConnection = {
  connect(): Promise<void>;
  disconnect(): void;
  isOpen(): boolean;
  send(text: string): void;
  /** Closes the current socket without marking it manual so auto-reconnect applies. */
  recycle(): void;
};

export function createKimiWebWsConnection(options: KimiWebWsConnectionOptions): KimiWebWsConnection {
  const reconnectDelaysMs = options.reconnectDelaysMs?.length
    ? options.reconnectDelaysMs
    : DEFAULT_RECONNECT_DELAYS_MS;
  let socket: KimiWebWsSocket | null = null;
  let connectPromise: Promise<void> | null = null;
  let disposed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let hasOpened = false;
  const manualSockets = new WeakSet<object>();

  function scheduleReconnect() {
    if (reconnectTimer !== null || disposed) return;
    const delay = reconnectDelaysMs[Math.min(reconnectAttempt, reconnectDelaysMs.length - 1)];
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect().catch(() => {
        // The close path schedules the next attempt (or autoReconnect is off).
      });
    }, delay);
  }

  function connect(): Promise<void> {
    if (disposed) {
      return Promise.reject(new KimiWebWsError('disposed', 'Kimi Web WebSocket client is disposed.'));
    }
    if (socket?.readyState === 1) return Promise.resolve();
    if (connectPromise) return connectPromise;

    const Ctor =
      options.webSocketCtor ?? (globalThis.WebSocket as unknown as KimiWebWsSocketCtor | undefined);
    if (!Ctor) {
      return Promise.reject(
        new KimiWebWsError('connection-failed', 'WebSocket is not available in this environment.'),
      );
    }

    connectPromise = new Promise<void>((resolve, reject) => {
      const ws = new Ctor(options.url);
      socket = ws;
      let settled = false;
      const settle = (next: () => void) => {
        if (settled) return;
        settled = true;
        connectPromise = null;
        next();
      };

      ws.addEventListener('open', () => {
        reconnectAttempt = 0;
        const reconnecting = hasOpened;
        hasOpened = true;
        options.onOpen(reconnecting);
        settle(() => resolve());
      });

      ws.addEventListener('message', (event) => {
        if (socket === ws) options.onMessage(event);
      });

      ws.addEventListener('close', (event) => {
        if (socket === ws) socket = null;
        const manual = manualSockets.has(ws);
        if (!manual && options.autoReconnect) scheduleReconnect();
        settle(() =>
          reject(
            new KimiWebWsError(
              'connection-failed',
              `Kimi Web WebSocket closed before opening (code ${event.code ?? 1006}).`,
            ),
          ),
        );
        options.onClose(event, manual);
      });
    });

    return connectPromise;
  }

  function disconnect() {
    disposed = true;
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const ws = socket;
    socket = null;
    if (ws && ws.readyState !== 3) {
      manualSockets.add(ws);
      ws.close(1000, 'client disconnect');
    }
  }

  return {
    connect,
    disconnect,
    isOpen: () => socket?.readyState === 1,
    send: (text) => {
      if (!socket || socket.readyState !== 1) {
        throw new KimiWebWsError('not-connected', 'Kimi Web WebSocket is not connected.');
      }
      socket.send(text);
    },
    recycle: () => {
      if (socket && socket.readyState !== 3) socket.close();
    },
  };
}

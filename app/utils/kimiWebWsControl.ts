/**
 * Control-frame channel for the kimi web client: assigns control ids, pairs
 * server acks by id, enforces the ack timeout and recycles the connection when
 * a subscription control frame is never answered (contract 6.1).
 */

import {
  KimiWebWsError,
  readAckPayload,
  type KimiWebWsAck,
  type KimiWebWsFrame,
} from './kimiWebWsProtocol';

export type KimiWebWsControlChannelOptions = {
  clientId: string;
  ackTimeoutMs: number;
  isOpen(): boolean;
  send(text: string): void;
  recycle(): void;
};

export type KimiWebWsControlChannel = {
  send(type: string, payload: Record<string, unknown>): Promise<KimiWebWsAck>;
  /** Settles the pending ack for `frame.id` and returns the ack payload. */
  handleAck(frame: KimiWebWsFrame): Record<string, unknown> | undefined;
  rejectAll(error: KimiWebWsError): void;
};

type PendingAck = {
  resolve: (ack: KimiWebWsAck) => void;
  reject: (error: KimiWebWsError) => void;
  timer: ReturnType<typeof setTimeout>;
  type: string;
};

export function createKimiWebWsControlChannel(
  options: KimiWebWsControlChannelOptions,
): KimiWebWsControlChannel {
  const pendingAcks = new Map<string, PendingAck>();
  let controlCounter = 0;

  function send(type: string, payload: Record<string, unknown>) {
    if (!options.isOpen()) {
      return Promise.reject(
        new KimiWebWsError('not-connected', `Kimi Web WebSocket is not connected (${type}).`),
      );
    }
    controlCounter += 1;
    const id = `${options.clientId}_${controlCounter}`;
    const promise = new Promise<KimiWebWsAck>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingAcks.delete(id);
        reject(new KimiWebWsError('ack-timeout', `Kimi Web ${type} was not acknowledged in time.`));
        if (type === 'subscribe' || type === 'client_hello') options.recycle();
      }, options.ackTimeoutMs);
      pendingAcks.set(id, { resolve, reject, timer, type });
    });
    // The returned promise still rejects for callers that await it; this guard
    // only keeps fire-and-forget callers from producing unhandled rejections.
    promise.catch(() => {});
    options.send(JSON.stringify({ type, id, payload }));
    return promise;
  }

  function handleAck(frame: KimiWebWsFrame) {
    const id = String(frame.id);
    const pending = pendingAcks.get(id);
    const payload = readAckPayload(frame);
    if (!pending) return payload;
    pendingAcks.delete(id);
    clearTimeout(pending.timer);
    const code = typeof frame.code === 'number' ? frame.code : -1;
    const msg = typeof frame.msg === 'string' ? frame.msg : undefined;
    if (code === 0) pending.resolve({ id, code, msg, payload });
    else {
      pending.reject(
        new KimiWebWsError('ack-failed', `Kimi Web ${pending.type} was rejected: ${msg ?? code}`, {
          ack: { id, code, msg, payload },
        }),
      );
    }
    return payload;
  }

  function rejectAll(error: KimiWebWsError) {
    for (const pending of pendingAcks.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    pendingAcks.clear();
  }

  return { send, handleAck, rejectAll };
}

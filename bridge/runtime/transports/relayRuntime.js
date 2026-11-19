import { randomUUID } from 'node:crypto';
import { decodeFrame, encodeFrame, LIMITS } from '../../../shared/runtime/protocol.js';
import { requireValue } from '../../../shared/runtime/capabilities.js';

function packet(data) {
  const json = typeof data === 'string';
  const bytes = json ? Buffer.from(data) : Buffer.from(data);
  requireValue(bytes.length <= (json ? LIMITS.jsonBytes : LIMITS.binaryBytes + 24), 'relay.runtime.size');
  return Buffer.concat([Buffer.from([json ? 0 : 1]), bytes]);
}

function unpack(data) {
  requireValue(data.length > 0 && (data[0] === 0 || data[0] === 1), 'relay.runtime.kind');
  const bytes = data.subarray(1);
  requireValue(bytes.length <= (data[0] === 0 ? LIMITS.jsonBytes : LIMITS.binaryBytes + 24), 'relay.runtime.size');
  return data[0] === 0 ? bytes.toString('utf8') : Uint8Array.from(bytes).buffer;
}

/** Only invoked after the relay's mutual credential proof succeeds. */
export function attachRelayRuntime(channel, host) {
  const connection = host.connect(randomUUID());
  const dispatcher = connection.openRuntime({
    send: frame => channel.sendData(packet(encodeFrame(frame))),
    sendBinary: bytes => channel.sendData(packet(bytes)),
    canSend: size => (channel.bufferedAmount ?? 0) + size <= LIMITS.outboundBytes,
    retire: () => channel.close(),
  });
  requireValue(dispatcher, 'relay.runtime', 'source_unavailable');
  channel.onData(bytes => {
    try {
      const data = unpack(bytes);
      if (typeof data === 'string') void dispatcher.request(decodeFrame(data));
      else dispatcher.binary(new Uint8Array(data));
    } catch { channel.close(); }
  });
  channel.onClose(() => connection.disconnect());
  channel.sendData(packet(encodeFrame(dispatcher.hello())));
  return dispatcher;
}

/** Adapts an authenticated relay to the same client protocol used by WebSocket targets. */
export function relayRuntimeSocket(channel) {
  const listeners = new Map();
  channel.onClose(() => listeners.get('close')?.({}));
  return {
    get bufferedAmount() { return channel.bufferedAmount ?? 0; },
    addEventListener(kind, listener) {
      listeners.set(kind, listener);
      if (kind === 'message') channel.onData(bytes => {
        try { listener({ data: unpack(bytes) }); }
        catch { channel.close(); }
      });
    },
    send: data => channel.sendData(packet(data)),
    close: () => channel.close(),
  };
}

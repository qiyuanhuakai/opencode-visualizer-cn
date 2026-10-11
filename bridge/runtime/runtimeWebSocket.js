import { randomUUID } from 'node:crypto';
import {
  assertWebSocketRequest,
  isAllowedOrigin,
  isAuthorized,
  requiresPtyToken,
  writeHttpResponse,
} from '../bridgeHttp.js';
import {
  createWebSocketAccept,
  encodeWebSocketFrame,
  decodeWebSocketFrames,
} from '../webSocketFrames.js';
import { decodeFrame, encodeFrame, LIMITS, ProtocolError } from '../../shared/runtime/protocol.js';

export async function handleRuntimeUpgrade(request, socket, head, options) {
  if (
    requiresPtyToken(options) ||
    !isAllowedOrigin(request.headers.origin, options.bridgeToken) ||
    !isAuthorized(request, options.bridgeToken)
  ) {
    writeHttpResponse(socket, 403, 'Forbidden', { error: 'Unauthorized runtime connection.' });
    return;
  }
  let connection;
  try {
    const key = assertWebSocketRequest(request);
    if (!options.runtime?.getRuntimeHost) throw new ProtocolError('unsupported', 'runtime');
    const host = await options.runtime.getRuntimeHost();
    if (socket.destroyed) return;
    connection = host.connect(randomUUID());
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${createWebSocketAccept(key)}`,
        '',
        '',
      ].join('\r\n'),
    );
    let dispatcher;
    const canSend = (size) => !socket.destroyed && socket.writableLength + size <= LIMITS.outboundBytes;
    const send = (frame) => {
      const bytes = encodeWebSocketFrame(encodeFrame(frame));
      if (!canSend(bytes.length)) {
        socket.destroy();
        return;
      }
      socket.write(bytes);
    };
    const sendBinary = (data) => {
      const bytes = encodeWebSocketFrame(Buffer.from(data), 2);
      if (!canSend(bytes.length)) { socket.destroy(); return; }
      socket.write(bytes);
    };
    dispatcher = connection.openRuntime?.({ send, sendBinary, canSend });
    const hello = dispatcher?.hello() ?? connection.hello();
    send(hello);
    let buffer = Buffer.alloc(0);
    let fragmented;
    const consume = (chunk) => {
      try {
        if (buffer.length + chunk.length + (fragmented?.payload.length ?? 0) > LIMITS.outboundBytes)
          throw new ProtocolError('invalid_request', 'frame.size');
        buffer = Buffer.concat([buffer, chunk]);
        const decoded = decodeWebSocketFrames(buffer, { maxPayloadBytes: LIMITS.jsonBytes });
        const encoded = buffer;
        buffer = decoded.remaining;
        let frameOffset = 0;
        for (const frame of decoded.frames) {
          const reserved = encoded[frameOffset] & 0x70;
          const lengthTag = encoded[frameOffset + 1] & 0x7f;
          frameOffset += 2 + (lengthTag === 126 ? 2 : lengthTag === 127 ? 8 : 0) + (frame.masked ? 4 : 0) + frame.payload.length;
          if (reserved || !frame.masked) throw new ProtocolError('invalid_request', 'frame');
          if (frame.opcode >= 8 && (!frame.fin || frame.payload.length > 125))
            throw new ProtocolError('invalid_request', 'frame.control');
          if (frame.opcode === 8) {
            socket.end(encodeWebSocketFrame(frame.payload, 8));
            return;
          }
          if (frame.opcode === 9) {
            socket.write(encodeWebSocketFrame(frame.payload, 10));
            continue;
          }
          if (frame.opcode === 10) continue;
          let opcode = frame.opcode, payload = frame.payload;
          if (opcode === 0) {
            if (!fragmented || fragmented.length + payload.length > fragmented.payload.length)
              throw new ProtocolError('invalid_request', 'frame.continuation');
            payload.copy(fragmented.payload, fragmented.length); fragmented.length += payload.length;
            if (!frame.fin) continue;
            opcode = fragmented.opcode; payload = fragmented.payload.subarray(0, fragmented.length); fragmented = undefined;
          } else {
            if (fragmented || (opcode !== 1 && opcode !== 2)) throw new ProtocolError('invalid_request', 'frame.opcode');
            const maximum = opcode === 1 ? LIMITS.jsonBytes : 24 + LIMITS.binaryBytes;
            if (payload.length > maximum) throw new ProtocolError('invalid_request', 'frame.size');
            if (!frame.fin) {
              fragmented = { opcode, payload: Buffer.allocUnsafe(maximum), length: payload.length };
              payload.copy(fragmented.payload); continue;
            }
          }
          if (opcode === 2 && dispatcher) { dispatcher.binary(payload); continue; }
          if (opcode !== 1) throw new ProtocolError('unsupported', 'frame.binary');
          const requestFrame = decodeFrame(payload.toString('utf8'));
          if (requestFrame.kind !== 'request')
            throw new ProtocolError('invalid_request', 'request');
          if (dispatcher) { void dispatcher.request(requestFrame).catch(() => socket.destroy()); continue; }
          const base = {
            version: 1,
            kind: 'result',
            target: hello.target,
            epoch: hello.epoch,
            generation: hello.generation,
            id: requestFrame.id,
          };
          try {
            connection.assertCurrent();
            if (
              requestFrame.target !== hello.target ||
              requestFrame.epoch !== hello.epoch ||
              requestFrame.generation !== hello.generation
            )
              throw new ProtocolError('reconcile_required', 'binding');
            if (requestFrame.method !== 'runtime.inspect')
              throw new ProtocolError('unsupported', 'method');
            send({ ...base, ok: true, phase: 'read', result: connection.inspect() });
          } catch (error) {
            if (!(error instanceof ProtocolError)) throw error;
            send({ ...base, ok: false, typedError: { code: error.code, message: error.message } });
          }
        }
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        socket.destroy();
      }
    };
    socket.on('data', consume);
    socket.once('close', () => connection.disconnect());
    socket.once('error', () => connection.disconnect());
    if (head.length) consume(head);
  } catch (error) {
    connection?.disconnect();
    if (!(error instanceof Error)) throw error;
    writeHttpResponse(socket, 503, 'Service Unavailable', { error: 'Runtime unavailable.' });
  }
}

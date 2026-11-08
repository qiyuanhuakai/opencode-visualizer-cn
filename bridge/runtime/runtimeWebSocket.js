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
    const hello = connection.hello();
    const send = (frame) => {
      const bytes = encodeWebSocketFrame(encodeFrame(frame));
      if (socket.writableLength + bytes.length > LIMITS.outboundBytes) {
        socket.destroy();
        return;
      }
      socket.write(bytes);
    };
    send(hello);
    let buffer = Buffer.alloc(0);
    const consume = (chunk) => {
      try {
        if (buffer.length + chunk.length > LIMITS.jsonBytes + 14)
          throw new ProtocolError('invalid_request', 'frame.size');
        buffer = Buffer.concat([buffer, chunk]);
        const decoded = decodeWebSocketFrames(buffer, { maxPayloadBytes: LIMITS.jsonBytes });
        buffer = decoded.remaining;
        for (const frame of decoded.frames) {
          if (!frame.masked || !frame.fin) throw new ProtocolError('invalid_request', 'frame');
          if (frame.opcode === 8) {
            socket.end(encodeWebSocketFrame(frame.payload, 8));
            return;
          }
          if (frame.opcode === 9) {
            socket.write(encodeWebSocketFrame(frame.payload, 10));
            continue;
          }
          if (frame.opcode !== 1) throw new ProtocolError('unsupported', 'frame.binary');
          const requestFrame = decodeFrame(frame.payload.toString('utf8'));
          if (requestFrame.kind !== 'request')
            throw new ProtocolError('invalid_request', 'request');
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

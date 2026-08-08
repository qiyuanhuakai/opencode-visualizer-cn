import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function createWebSocketAccept(secWebSocketKey) {
  return createHash('sha1').update(`${secWebSocketKey}${WS_GUID}`).digest('base64');
}

export function encodeWebSocketFrame(data, opcode = 1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  const length = payload.length;
  if (length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]);
  if (length <= 0xffff) {
    const header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header[0] = 0x80 | opcode;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}

export function decodeWebSocketFrames(buffer, options = {}) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      const bigLength = buffer.readBigUInt64BE(offset + 2);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error('WebSocket frame too large.');
      length = Number(bigLength);
      headerLength = 10;
    }
    if (options.maxPayloadBytes !== undefined && length > options.maxPayloadBytes) {
      throw new Error('WebSocket frame too large.');
    }
    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + length;
    if (buffer.length - offset < frameLength) break;
    const mask = masked
      ? buffer.subarray(offset + headerLength, offset + headerLength + 4)
      : undefined;
    const payloadStart = offset + headerLength + maskLength;
    const payload = Buffer.from(buffer.subarray(payloadStart, payloadStart + length));
    if (mask) {
      for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
    }
    frames.push({ fin, opcode, masked, payload });
    offset += frameLength;
  }
  return { frames, remaining: buffer.subarray(offset) };
}

function closePayload(code, reason) {
  const text = Buffer.from(reason, 'utf8');
  const payload = Buffer.alloc(2 + text.length);
  payload.writeUInt16BE(code, 0);
  text.copy(payload, 2);
  return payload;
}

export function createRawWebSocketPeer(socket, head = Buffer.alloc(0), options = {}) {
  const peer = new EventEmitter();
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentOpcode;
  let closed = false;
  let alive = true;
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 0;
  const heartbeat =
    heartbeatIntervalMs > 0
      ? setInterval(() => {
          if (!alive) {
            socket.destroy();
            emitClose();
            return;
          }
          alive = false;
          socket.write(encodeWebSocketFrame(Buffer.alloc(0), 9));
        }, heartbeatIntervalMs)
      : undefined;
  heartbeat?.unref?.();

  function emitClose() {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    peer.emit('close');
  }

  function close(code = 1000, reason = '') {
    if (closed) return;
    socket.end(encodeWebSocketFrame(closePayload(code, reason), 8));
    emitClose();
  }

  function emitDataFrame(opcode, payload, fin) {
    if (opcode === 0) {
      if (fragmentOpcode === undefined) return close(1002, 'Unexpected continuation frame.');
      fragments.push(payload);
      if (!fin) return;
      const complete = Buffer.concat(fragments);
      const completeOpcode = fragmentOpcode;
      fragments = [];
      fragmentOpcode = undefined;
      if (completeOpcode === 1) peer.emit('message', complete.toString('utf8'));
      else close(1003, 'Binary messages are not supported.');
      return;
    }
    if (!fin) {
      fragmentOpcode = opcode;
      fragments = [payload];
      return;
    }
    if (opcode === 1) peer.emit('message', payload.toString('utf8'));
    else close(1003, 'Binary messages are not supported.');
  }

  function consume(chunk) {
    if (closed) return;
    alive = true;
    buffer = Buffer.concat([buffer, chunk]);
    let decoded;
    try {
      decoded = decodeWebSocketFrames(buffer);
    } catch {
      close(1002, 'Invalid WebSocket frame.');
      return;
    }
    buffer = decoded.remaining;
    for (const frame of decoded.frames) {
      if (!frame.masked) {
        close(1002, 'Client frames must be masked.');
        return;
      }
      if (frame.opcode === 8) {
        close();
        return;
      }
      if (frame.opcode === 9) {
        socket.write(encodeWebSocketFrame(frame.payload, 10));
        continue;
      }
      if (frame.opcode === 10) continue;
      emitDataFrame(frame.opcode, frame.payload, frame.fin);
    }
  }

  peer.send = (message) => {
    if (!closed) socket.write(encodeWebSocketFrame(message));
  };
  peer.close = close;
  socket.on('data', consume);
  socket.once('close', emitClose);
  socket.once('error', emitClose);
  if (head.length > 0) queueMicrotask(() => consume(head));
  return peer;
}

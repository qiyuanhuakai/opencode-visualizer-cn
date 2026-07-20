import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import {
  createRawWebSocketPeer,
  createWebSocketAccept,
  decodeWebSocketFrames,
  encodeWebSocketFrame,
} from '../bridge/webSocketFrames.js';

function encodeMaskedTextFrame(text: string) {
  const payload = Buffer.from(text, 'utf8');
  const mask = Buffer.from([1, 2, 3, 4]);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) masked[index] ^= mask[index % 4];
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
}

class TestSocket extends EventEmitter {
  writes: Buffer[] = [];
  destroyed = false;

  write(data: string | Buffer) {
    this.writes.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
    return true;
  }

  destroy() {
    this.destroyed = true;
    this.emit('close');
  }

  end(data?: string | Buffer) {
    if (data !== undefined) this.write(data);
    this.destroy();
  }
}

describe('webSocketFrames', () => {
  it('preserves the RFC handshake and masked-frame behavior used by existing bridge routes', () => {
    expect(createWebSocketAccept('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    const decoded = decodeWebSocketFrames(encodeMaskedTextFrame('{"id":1}'));
    expect(decoded.remaining).toHaveLength(0);
    expect(decoded.frames).toEqual([
      expect.objectContaining({ opcode: 1, payload: Buffer.from('{"id":1}') }),
    ]);

    const encoded = encodeWebSocketFrame('ok');
    expect(encoded).toEqual(Buffer.from([0x81, 2, 0x6f, 0x6b]));
  });

  it('adapts a raw upgraded socket to the ACP client message interface', async () => {
    const socket = new TestSocket();
    const peer = createRawWebSocketPeer(socket, encodeMaskedTextFrame('{"method":"initialize"}'));
    const onMessage = vi.fn();
    peer.on('message', onMessage);
    await Promise.resolve();

    socket.emit('data', encodeMaskedTextFrame('{"id":2}'));
    peer.send('{"id":2,"result":{}}');
    peer.close(1000, 'done');

    expect(onMessage).toHaveBeenNthCalledWith(1, '{"method":"initialize"}');
    expect(onMessage).toHaveBeenNthCalledWith(2, '{"id":2}');
    expect(
      socket.writes.some(
        (frame) =>
          frame[0] === 0x81 && frame.subarray(2).toString('utf8') === '{"id":2,"result":{}}',
      ),
    ).toBe(true);
    expect(socket.writes.some((frame) => (frame[0] & 0x0f) === 8)).toBe(true);
    expect(socket.destroyed).toBe(true);
  });

  it('releases peers that stop answering heartbeat pings', async () => {
    vi.useFakeTimers();
    try {
      const socket = new TestSocket();
      const peer = createRawWebSocketPeer(socket, Buffer.alloc(0), { heartbeatIntervalMs: 10 });
      const onClose = vi.fn();
      peer.on('close', onClose);

      await vi.advanceTimersByTimeAsync(10);
      expect(socket.writes.some((frame) => (frame[0] & 0x0f) === 9)).toBe(true);
      await vi.advanceTimersByTimeAsync(10);

      expect(socket.destroyed).toBe(true);
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});

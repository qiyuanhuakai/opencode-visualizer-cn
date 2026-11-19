import { randomBytes } from 'node:crypto';
import type { Socket } from 'node:net';
import { connectUpstreamWebSocket } from '../../bridge/codexWebSocketProxy.js';
import { decodeWebSocketFrames, encodeWebSocketFrame } from '../../bridge/webSocketFrames.js';

/** A browser-shaped socket over real loopback TCP, restricted to one owned server. */
export function loopbackRuntimeSocket(endpoint: string) {
  const sockets = new Set<LoopbackSocket>();
  const frames: Array<{ direction: 'send' | 'receive'; value: unknown }> = [];
  class LoopbackSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readyState = 0;
    binaryType = 'arraybuffer';
    private socket?: Socket;
    private buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    private closed = false;
    constructor(url: string) {
      super();
      const target = new URL(url), owned = new URL(endpoint);
      if (target.origin !== owned.origin || target.pathname !== '/runtime') throw new Error('Test attempted a non-owned connection');
      sockets.add(this);
      void connectUpstreamWebSocket(url).then(({ socket, head }) => {
        if (this.closed) { socket.destroy(); return; }
        this.socket = socket;
        this.readyState = 1;
        socket.on('data', bytes => this.consume(bytes));
        socket.once('close', () => this.finish());
        socket.once('error', () => { this.dispatchEvent(new Event('error')); this.close(); });
        this.dispatchEvent(new Event('open'));
        if (head.length) this.consume(head);
      }).catch(() => { this.dispatchEvent(new Event('error')); this.finish(); });
    }
    get bufferedAmount() { return this.socket?.writableLength ?? 0; }
    private consume(bytes: Buffer) {
      this.buffer = Buffer.concat([this.buffer, bytes]);
      const parsed = decodeWebSocketFrames(this.buffer, { maxPayloadBytes: 1048576 });
      this.buffer = parsed.remaining;
      for (const frame of parsed.frames) {
        if (frame.opcode === 8) { this.close(); break; }
        if (frame.opcode === 9) { this.write(frame.payload, 10); continue; }
        if (frame.opcode === 10) continue;
        const data = frame.opcode === 1 ? frame.payload.toString('utf8') : Uint8Array.from(frame.payload).buffer;
        if (typeof data === 'string') frames.push({ direction: 'receive', value: JSON.parse(data) });
        this.dispatchEvent(new MessageEvent('message', { data }));
      }
    }
    private write(data: Buffer, opcode: number) {
      const plain = encodeWebSocketFrame(data, opcode);
      const headerLength = plain.length - data.length;
      const mask = randomBytes(4), masked = Buffer.alloc(plain.length + 4);
      plain.copy(masked, 0, 0, headerLength);
      masked[1] = masked[1]! | 0x80;
      mask.copy(masked, headerLength);
      for (let i = 0; i < data.length; i++) masked[headerLength + 4 + i] = data[i]! ^ mask[i % 4]!;
      this.socket?.write(masked);
    }
    send(data: string | Uint8Array) {
      if (this.readyState !== 1) throw new Error('Test socket is closed');
      if (typeof data === 'string') frames.push({ direction: 'send', value: JSON.parse(data) });
      this.write(typeof data === 'string' ? Buffer.from(data) : Buffer.from(data), typeof data === 'string' ? 1 : 2);
    }
    private finish() {
      if (this.closed) return;
      this.closed = true;
      this.readyState = 3;
      sockets.delete(this);
      this.dispatchEvent(new Event('close'));
    }
    close() { this.socket?.destroy(); this.finish(); }
  }
  return { Socket: LoopbackSocket, frames, close: () => { for (const socket of sockets) socket.close(); }, size: () => sockets.size };
}

import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { createPtyManager } from '../bridge/ptyManager.js';

function clientFrame(payload: string, opcode: number, fin: boolean): Buffer {
  const data = Buffer.from(payload);
  return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode, data.length]), data]);
}

function createFixture() {
  let onData: ((value: string) => void) | undefined;
  const pty = {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    onData: vi.fn((listener: (value: string) => void) => {
      onData = listener;
    }),
    onExit: vi.fn(),
  };
  const manager = createPtyManager({ ptyModule: { spawn: vi.fn(() => pty) } });
  return { manager, pty, output: (value: string) => onData?.(value) };
}

function createSocket(writeResult = true) {
  return Object.assign(new EventEmitter(), {
    destroyed: false,
    write: vi.fn(() => writeResult),
    end: vi.fn(),
    destroy: vi.fn(),
  });
}

describe('PTY transport boundaries', () => {
  it('reassembles fragmented terminal input before writing to the PTY', async () => {
    const { manager, pty } = createFixture();
    const { id } = await manager.create({ command: 'shell' });
    const socket = createSocket();
    manager.attach(id, socket, Buffer.alloc(0));

    socket.emit('data', clientFrame('hel', 1, false));
    socket.emit('data', clientFrame('lo', 0, true));

    expect(pty.write).toHaveBeenCalledExactlyOnceWith('hello');
  });

  it('destroys a client that declares an oversized inbound frame', async () => {
    const { manager } = createFixture();
    const { id } = await manager.create({ command: 'shell' });
    const socket = createSocket();
    manager.attach(id, socket, Buffer.alloc(0));
    const header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(3 * 1024 * 1024), 2);

    socket.emit('data', header);

    expect(socket.destroy).toHaveBeenCalledOnce();
  });

  it('drops a slow client when its outbound queue applies backpressure', async () => {
    const { manager, output } = createFixture();
    const { id } = await manager.create({ command: 'shell' });
    const socket = createSocket(false);
    manager.attach(id, socket, Buffer.alloc(0));

    output('terminal output');

    expect(socket.destroy).toHaveBeenCalledOnce();
  });
});

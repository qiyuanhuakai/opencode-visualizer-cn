import { describe, expect, it, vi } from 'vitest';

import { handlePtyUpgrade } from '../bridge/bridgeWebSocketRoutes.js';

describe('bridge WebSocket route boundaries', () => {
  it('returns a 400 response for a malformed encoded PTY id', () => {
    const socket = {
      write: vi.fn(() => true),
      end: vi.fn(),
      destroy: vi.fn(),
    };
    const request = {
      url: '/pty/%/connect',
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      },
    };

    expect(() =>
      handlePtyUpgrade(request, socket, Buffer.alloc(0), { host: '127.0.0.1' }, { attach: vi.fn() }),
    ).not.toThrow();
    expect(socket.write).toHaveBeenCalledWith(expect.stringContaining('400 Bad Request'));
  });
});

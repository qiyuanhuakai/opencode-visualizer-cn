import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { writeHttpResponse } from '../bridge/bridgeHttp.js';
import { handlePtyHttpRequest, readJsonBody } from '../bridge/bridgeHttpRoutes.js';

describe('bridge HTTP boundaries', () => {
  it('rejects a JSON body before buffering beyond the configured limit', async () => {
    const request = new EventEmitter();
    const reading = readJsonBody(request, 32);

    request.emit('data', Buffer.from(JSON.stringify({ value: 'x'.repeat(64) })));
    request.emit('end');

    await expect(reading).rejects.toThrow('request body exceeded');
  });

  it('ends a raw HTTP response so queued bytes can flush', () => {
    const socket = {
      write: vi.fn(() => false),
      end: vi.fn(),
      destroy: vi.fn(),
    };

    writeHttpResponse(socket, 400, 'Bad Request', { error: 'bad request' });

    expect(socket.end).toHaveBeenCalledOnce();
    expect(socket.destroy).not.toHaveBeenCalled();
  });

  it('returns 413 without resetting the connection for an oversized JSON body', async () => {
    const request = Object.assign(new EventEmitter(), {
      method: 'POST',
      pause: vi.fn(),
    });
    const response = {
      writeHead: vi.fn(),
      end: vi.fn(),
    };
    const manager = {
      create: vi.fn(),
      list: vi.fn(),
      resize: vi.fn(),
      remove: vi.fn(),
    };
    const handling = handlePtyHttpRequest(
      request,
      response,
      new URL('http://localhost/pty'),
      manager,
    );

    request.emit('data', Buffer.alloc(2 * 1024 * 1024 + 1));
    await handling;

    expect(request.pause).toHaveBeenCalledOnce();
    expect(manager.create).not.toHaveBeenCalled();
    expect(response.writeHead).toHaveBeenCalledWith(413, expect.any(Object));
    expect(response.end).toHaveBeenCalledOnce();
  });

  it('returns 400 instead of 500 for malformed JSON input', async () => {
    const request = Object.assign(new EventEmitter(), {
      method: 'POST',
      pause: vi.fn(),
    });
    const response = {
      writeHead: vi.fn(),
      end: vi.fn(),
    };
    const manager = {
      create: vi.fn(),
      list: vi.fn(),
      resize: vi.fn(),
      remove: vi.fn(),
    };
    const handling = handlePtyHttpRequest(
      request,
      response,
      new URL('http://localhost/pty'),
      manager,
    );

    request.emit('data', Buffer.from('{invalid-json'));
    request.emit('end');
    await handling;

    expect(response.writeHead).toHaveBeenCalledWith(400, expect.any(Object));
    expect(manager.create).not.toHaveBeenCalled();
  });
});

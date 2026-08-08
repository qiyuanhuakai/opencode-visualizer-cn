import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { writeHttpResponse } from '../bridge/bridgeHttp.js';
import { readJsonBody } from '../bridge/bridgeHttpRoutes.js';

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
});

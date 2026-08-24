import { describe, expect, it, vi } from 'vitest';

import { acknowledgeDaemonStop } from '../bridge/daemonProcess.js';

describe('daemon stop acknowledgement', () => {
  it('closes command admission before acknowledging HTTP 202', async () => {
    // Given: shutdown records when command admission closes relative to the response.
    const events: string[] = [];
    const shutdown = vi.fn(() => {
      events.push('admission-closed');
      return Promise.resolve();
    });
    const exitProcess = vi.fn();
    const response = {
      writeHead: vi.fn((statusCode: number) => {
        events.push(`response:${statusCode}`);
        return { end: vi.fn() };
      }),
    };

    // When: the authenticated control handler acknowledges shutdown.
    acknowledgeDaemonStop(response, shutdown, exitProcess);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await Promise.resolve();

    // Then: admission is closed before 202 can become observable.
    expect(events).toEqual(['admission-closed', 'response:202']);
    expect(exitProcess).toHaveBeenCalledOnce();
  });
});

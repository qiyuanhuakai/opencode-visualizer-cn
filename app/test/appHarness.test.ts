import { describe, expect, it, vi } from 'vitest';
import { HarnessWebSocket } from './appHarness';

describe('Given the harness WebSocket double standing in for the browser socket', () => {
  it('When a listener is removed before the event is dispatched, Then the removed listener is never called', async () => {
    const socket = new HarnessWebSocket();
    const kept = vi.fn();
    const removed = vi.fn();
    socket.addEventListener('open', kept);
    socket.addEventListener('open', removed);
    socket.removeEventListener('open', removed);
    await Promise.resolve();
    expect(kept).toHaveBeenCalledTimes(1);
    expect(removed).not.toHaveBeenCalled();
  });

  it('When teardown unregisters every listener it registered, Then a second removal of the same listener is a no-op', () => {
    const socket = new HarnessWebSocket();
    const onMessage = vi.fn();
    const onError = vi.fn();
    const onClose = vi.fn();
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
    socket.removeEventListener('message', onMessage);
    socket.removeEventListener('error', onError);
    socket.removeEventListener('close', onClose);
    expect(() => {
      socket.removeEventListener('message', onMessage);
      socket.removeEventListener('never-registered', onMessage);
    }).not.toThrow();
  });

  it('When the socket is still open, Then a listener registered after another was removed keeps receiving', async () => {
    const socket = new HarnessWebSocket();
    const first = vi.fn();
    const second = vi.fn();
    socket.addEventListener('open', first);
    socket.removeEventListener('open', first);
    socket.addEventListener('open', second);
    await Promise.resolve();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});

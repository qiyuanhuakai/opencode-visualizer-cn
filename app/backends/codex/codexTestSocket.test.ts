import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeCodexTestSockets, CodexTestSocket } from './codexTestSocket';

describe('CodexTestSocket', () => {
  afterEach(closeCodexTestSockets);

  it('records transport sends without generating a business response', () => {
    const socket = new CodexTestSocket('ws://localhost:4500', ['codex-json-rpc']);
    const message = vi.fn();
    socket.addEventListener('message', message);

    socket.send(JSON.stringify({ id: 1, method: 'thread/list' }));

    expect(socket.sent).toEqual([JSON.stringify({ id: 1, method: 'thread/list' })]);
    expect(socket.protocols).toEqual(['codex-json-rpc']);
    expect(message).not.toHaveBeenCalled();
  });

  it('closes every owned socket through callbacks and clears the registry', () => {
    const first = new CodexTestSocket('ws://localhost:4500/first');
    const second = new CodexTestSocket('ws://localhost:4500/second');
    const firstClosed = vi.fn();
    const secondClosed = vi.fn();
    first.addEventListener('close', firstClosed);
    second.addEventListener('close', secondClosed);
    first.emitOpen();
    second.emitOpen();

    closeCodexTestSockets();

    expect(first.readyState).toBe(CodexTestSocket.CLOSED);
    expect(second.readyState).toBe(CodexTestSocket.CLOSED);
    expect(firstClosed).toHaveBeenCalledOnce();
    expect(secondClosed).toHaveBeenCalledOnce();
    expect(CodexTestSocket.instances).toEqual([]);
  });
});

import { describe, expect, it, vi } from 'vitest';

import { DSH_ADAPTER_METHODS, DSH_CAPABILITIES } from '../backends/dsh/dshAdapter';
import {
  DSH_TERMINAL_SOCKET_OPEN,
  DshTerminalError,
  createDshTerminal,
  dshShellAvailable,
  type DshTerminalSocket,
} from './dshTerminal';

type RecordedCall = { method: string; args: unknown[] };

function createHarness() {
  const calls: RecordedCall[] = [];
  const urls: string[] = [];
  const sent: Array<string | Uint8Array> = [];
  const listeners = new Map<string, (event: unknown) => void>();
  // The double's readyState is mutable through a closure variable: the typed
  // seam declares it readonly, so the cast cannot carry the write.
  let readyState = DSH_TERMINAL_SOCKET_OPEN;
  const socket = {
    get readyState() {
      return readyState;
    },
    send: (data: string | Uint8Array) => {
      sent.push(data);
    },
    close: () => {
      readyState = 3;
    },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners.set(type, listener);
    },
  } as DshTerminalSocket;

  const pty = {
    createPty: vi.fn(async (payload: unknown) => {
      calls.push({ method: 'createPty', args: [payload] });
      return { id: 'pty-9' };
    }),
    listPtys: vi.fn(async (directory?: string) => {
      calls.push({ method: 'listPtys', args: [directory] });
      return [{ id: 'pty-9' }];
    }),
    updatePtySize: vi.fn(async (id: string, payload: unknown) => {
      calls.push({ method: 'updatePtySize', args: [id, payload] });
    }),
    deletePty: vi.fn(async (id: string, directory?: string) => {
      calls.push({ method: 'deletePty', args: [id, directory] });
    }),
    createPtyWebSocketUrl: vi.fn((path: string) => {
      calls.push({ method: 'createPtyWebSocketUrl', args: [path] });
      return `ws://bridge.test${path}?token=bridge-token`;
    }),
  };

  const sink = { write: vi.fn<(data: string | Uint8Array) => void>() };
  const createSocket = (url: string) => {
    urls.push(url);
    return socket;
  };

  return { pty, sink, createSocket, urls, sent, listeners, calls, socket };
}

function emit(listeners: Map<string, (event: unknown) => void>, type: string, event: unknown) {
  const listener = listeners.get(type);
  if (!listener) throw new Error(`no listener for ${type}`);
  listener(event);
}

describe('dsh Shell seam (bridge native PTY, dsh terminal RPC excluded)', () => {
  it('creates the PTY through the bridge surface and connects over the bridge WebSocket', async () => {
    const h = createHarness();
    const terminal = createDshTerminal({
      pty: h.pty,
      sink: h.sink,
      directory: '/tmp/dsh/repo',
      createSocket: h.createSocket,
    });

    const session = await terminal.open({ command: 'zsh', title: 'Shell' });

    expect(session.id).toBe('pty-9');
    expect(h.pty.createPty).toHaveBeenCalledWith({
      command: 'zsh',
      title: 'Shell',
      directory: '/tmp/dsh/repo',
      cwd: '/tmp/dsh/repo',
    });
    expect(h.pty.createPtyWebSocketUrl).toHaveBeenCalledWith('/pty/pty-9/connect');
    expect(h.urls).toEqual(['ws://bridge.test/pty/pty-9/connect?token=bridge-token']);
  });

  it('renders createPty output streamed over the WebSocket at the sink', async () => {
    const h = createHarness();
    const terminal = createDshTerminal({
      pty: h.pty,
      sink: h.sink,
      directory: '/tmp/dsh/repo',
      createSocket: h.createSocket,
    });
    await terminal.open();

    emit(h.listeners, 'message', { data: 'hello' });
    emit(h.listeners, 'message', { data: new Uint8Array([104, 105]) });
    emit(h.listeners, 'message', { data: new ArrayBuffer(1) });

    expect(h.sink.write).toHaveBeenNthCalledWith(1, 'hello');
    expect(h.sink.write).toHaveBeenNthCalledWith(2, new Uint8Array([104, 105]));
    expect(h.sink.write).toHaveBeenNthCalledWith(3, new Uint8Array([0]));
  });

  it('resizes and deletes through the bridge PTY routes', async () => {
    const h = createHarness();
    const terminal = createDshTerminal({
      pty: h.pty,
      sink: h.sink,
      directory: '/tmp/dsh/repo',
      createSocket: h.createSocket,
    });
    await terminal.open();

    await terminal.resize('pty-9', 80, 24);
    expect(h.pty.updatePtySize).toHaveBeenCalledWith('pty-9', {
      directory: '/tmp/dsh/repo',
      rows: 24,
      cols: 80,
    });

    await terminal.close('pty-9');
    expect(h.socket.readyState).toBe(3);
    expect(h.pty.deletePty).toHaveBeenCalledWith('pty-9', '/tmp/dsh/repo');
  });

  it('sends keystrokes only while the socket is open', async () => {
    const h = createHarness();
    const terminal = createDshTerminal({
      pty: h.pty,
      sink: h.sink,
      directory: '/tmp/dsh/repo',
      createSocket: h.createSocket,
    });
    await terminal.open();

    terminal.write('pty-9', 'ls\n');
    expect(h.sent).toEqual(['ls\n']);

    await terminal.close('pty-9');
    expect(() => terminal.write('pty-9', 'x')).toThrow(DshTerminalError);
  });
});

describe('dsh capability wiring for the Shell and the pipeline surfaces', () => {
  it('shows the Shell only when the terminal capability is on', () => {
    expect(dshShellAvailable(DSH_CAPABILITIES)).toBe(true);
    expect(dshShellAvailable({ ...DSH_CAPABILITIES, terminal: false })).toBe(false);
  });

  it('hides worktrees/todos/questions and shows files/terminal for dsh', () => {
    expect(DSH_CAPABILITIES.worktrees).toBe(false);
    expect(DSH_CAPABILITIES.todos).toBe(false);
    expect(DSH_CAPABILITIES.questions).toBe(false);
    expect(DSH_CAPABILITIES.files).toBe(true);
    expect(DSH_CAPABILITIES.terminal).toBe(true);
  });

  it('exposes no todo/question/terminal-RPC surface for dsh to bypass the matrix', () => {
    const methods = new Set<string>(DSH_ADAPTER_METHODS);
    for (const excluded of [
      'getSessionTodos',
      'listPendingQuestions',
      'replyQuestion',
      'rejectQuestion',
      'terminalCreate',
      'terminalFollow',
      'createTerminal',
    ]) {
      expect(methods.has(excluded)).toBe(false);
    }
    expect(methods.has('createPty')).toBe(true);
    expect(methods.has('createPtyWebSocketUrl')).toBe(true);
  });
});

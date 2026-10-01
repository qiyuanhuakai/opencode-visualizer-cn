import type { BackendAdapter, BackendCapabilities } from '../backends/types';

/**
 * dsh Shell seam.
 *
 * The dsh Shell is served by vis_bridge's NATIVE PTY surface (`/pty`,
 * `/pty/:id`, `/pty/:id/connect`). dsh's own `terminal/*` RPCs are explicitly
 * excluded, so this module's surface type carries ONLY the bridge PTY methods
 * and can never reach a dsh terminal endpoint.
 */
export type DshTerminalPtySurface = Required<
  Pick<
    BackendAdapter,
    'createPty' | 'listPtys' | 'updatePtySize' | 'deletePty' | 'createPtyWebSocketUrl'
  >
>;

/** Render sink for PTY output (xterm's `write` in production). */
export type DshTerminalSink = {
  write(data: string | Uint8Array): void;
};

export type DshTerminalSocket = {
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
};

export type DshTerminalSocketFactory = (url: string) => DshTerminalSocket;

export type DshTerminalCreatePayload = {
  command?: string;
  args?: string[];
  title?: string;
  cwd?: string;
};

export type DshTerminalOptions = {
  /** The dsh adapter's bridge PTY methods (never dsh terminal RPCs). */
  pty: DshTerminalPtySurface;
  /** Where PTY output is rendered. */
  sink: DshTerminalSink;
  /** dsh session working directory; also the PTY cwd. */
  directory?: string;
  /** Injectable socket constructor for tests; defaults to global WebSocket. */
  createSocket?: DshTerminalSocketFactory;
};

export type DshTerminalSession = {
  readonly id: string;
  readonly socket: DshTerminalSocket;
};

export class DshTerminalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DshTerminalError';
  }
}

export const DSH_TERMINAL_SOCKET_OPEN = 1;

/** Capability gate: the Shell surface is shown only when `terminal` is true. */
export function dshShellAvailable(capabilities: BackendCapabilities): boolean {
  return capabilities.terminal === true;
}

function defaultSocketFactory(url: string): DshTerminalSocket {
  if (typeof WebSocket === 'undefined') {
    throw new DshTerminalError('WebSocket is not available in this environment.');
  }
  return new WebSocket(url) as unknown as DshTerminalSocket;
}

function readPtyId(value: unknown): string {
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const id = record.id ?? record.ptyId;
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  throw new DshTerminalError('dsh bridge PTY create did not return a PTY id.');
}

function toSocketData(data: unknown): string | Uint8Array | null {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}

export function createDshTerminal(options: DshTerminalOptions) {
  const { pty, sink } = options;
  const directory = options.directory;
  const createSocket = options.createSocket ?? defaultSocketFactory;
  const sessions = new Map<string, DshTerminalSession>();

  async function open(payload: DshTerminalCreatePayload = {}): Promise<DshTerminalSession> {
    const created = await pty.createPty({
      ...payload,
      ...(directory ? { directory, cwd: payload.cwd ?? directory } : {}),
    });
    const id = readPtyId(created);
    const url = pty.createPtyWebSocketUrl(`/pty/${encodeURIComponent(id)}/connect`);
    const socket = createSocket(url);
    socket.addEventListener('message', (event) => {
      const data = (event as { data?: unknown } | null)?.data;
      const normalized = toSocketData(data);
      if (normalized !== null) sink.write(normalized);
    });
    socket.addEventListener('close', () => {
      sessions.delete(id);
    });
    const session: DshTerminalSession = { id, socket };
    sessions.set(id, session);
    return session;
  }

  async function resize(id: string, cols: number, rows: number): Promise<void> {
    await pty.updatePtySize(id, { ...(directory ? { directory } : {}), rows, cols });
  }

  function write(id: string, data: string | Uint8Array): void {
    const session = sessions.get(id);
    if (!session || session.socket.readyState !== DSH_TERMINAL_SOCKET_OPEN) {
      throw new DshTerminalError('dsh Shell socket is not open.');
    }
    session.socket.send(data);
  }

  async function close(id: string): Promise<void> {
    sessions.get(id)?.socket.close();
    sessions.delete(id);
    await pty.deletePty(id, directory);
  }

  async function list(): Promise<unknown> {
    return pty.listPtys(directory);
  }

  return { open, resize, write, close, list, sessions };
}

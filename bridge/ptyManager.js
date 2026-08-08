import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { decodeWebSocketFrames, encodeWebSocketFrame } from './webSocketFrames.js';

async function loadNodePty(ptyModule) {
  if (ptyModule) return ptyModule;
  try {
    const runtimeImport = new Function('specifier', 'return import(specifier)');
    return await runtimeImport('node-pty');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`PTY support requires the optional node-pty package: ${message}`);
  }
}

function defaultPtyShell() {
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe';
  return process.env.SHELL || 'bash';
}

function normalizePtyCwd(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : homedir();
}

const PTY_BUFFER_LIMIT = 2 * 1024 * 1024;
const PTY_EXIT_GRACE_MS = 1500;

function encodePtyMetaFrame(meta) {
  const payload = Buffer.concat([Buffer.from([0]), Buffer.from(JSON.stringify(meta), 'utf8')]);
  return encodeWebSocketFrame(payload, 2);
}

function trimPtyBuffer(buffer) {
  if (buffer.length <= PTY_BUFFER_LIMIT) return buffer;
  return buffer.slice(buffer.length - PTY_BUFFER_LIMIT);
}

export function createPtyManager(options = {}) {
  const sessions = new Map();

  function scheduleCleanup(session, delay = PTY_EXIT_GRACE_MS) {
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    session.cleanupTimer = setTimeout(() => {
      if (sessions.get(session.id) !== session) return;
      sessions.delete(session.id);
    }, delay);
  }

  function appendOutput(session, data) {
    const chunk = String(data);
    session.buffer = trimPtyBuffer(session.buffer + chunk);
    for (const socket of session.sockets) {
      if (socket.destroyed) continue;
      if (!socket.write(encodeWebSocketFrame(chunk, 1))) {
        session.sockets.delete(socket);
        socket.destroy();
      }
    }
  }

  function sendExitToSocket(session, socket) {
    if (socket.destroyed) return;
    if (typeof session.exitCode === 'number') {
      socket.write(encodePtyMetaFrame({ exitCode: session.exitCode }));
    }
    socket.end(encodeWebSocketFrame(Buffer.alloc(0), 8));
  }

  async function create(payload = {}) {
    const nodePty = await loadNodePty(options.ptyModule);
    const id = randomBytes(16).toString('hex');
    const command =
      typeof payload.command === 'string' && payload.command.trim()
        ? payload.command.trim()
        : defaultPtyShell();
    const args = Array.isArray(payload.args) ? payload.args.map(String) : [];
    const ptyProcess = nodePty.spawn(command, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: normalizePtyCwd(payload.cwd || payload.directory),
      env: process.env,
    });
    const session = {
      id,
      command,
      args,
      cwd: normalizePtyCwd(payload.cwd || payload.directory),
      title: typeof payload.title === 'string' ? payload.title : undefined,
      createdAt: Date.now(),
      pty: ptyProcess,
      sockets: new Set(),
      buffer: '',
      status: 'running',
      exitCode: undefined,
      cleanupTimer: undefined,
      disposed: false,
    };
    sessions.set(id, session);
    ptyProcess.onData?.((data) => {
      appendOutput(session, data);
    });
    ptyProcess.onExit?.((event = {}) => {
      session.disposed = true;
      session.status = 'exited';
      if (typeof event.exitCode === 'number') session.exitCode = event.exitCode;
      for (const socket of session.sockets) {
        try {
          sendExitToSocket(session, socket);
        } catch {}
      }
      scheduleCleanup(session);
    });
    return { id };
  }

  function list() {
    return [...sessions.values()].map((session) => ({
      id: session.id,
      command: session.command,
      args: session.args,
      cwd: session.cwd,
      title: session.title,
      status: session.status,
      ...(typeof session.exitCode === 'number' ? { exitCode: session.exitCode } : {}),
      createdAt: session.createdAt,
    }));
  }

  function resize(id, rows, cols) {
    const session = sessions.get(id);
    if (!session) return false;
    session.pty.resize(Number(cols) || 80, Number(rows) || 24);
    return true;
  }

  function remove(id) {
    const session = sessions.get(id);
    if (!session) return false;
    if (session.cleanupTimer) clearTimeout(session.cleanupTimer);
    sessions.delete(id);
    session.disposed = true;
    for (const socket of session.sockets) socket.destroy();
    try {
      session.pty.kill();
    } catch {}
    return true;
  }

  function disposeAll() {
    for (const id of sessions.keys()) remove(id);
  }

  function attach(id, socket, head) {
    const session = sessions.get(id);
    if (!session) return false;
    let buffer = Buffer.alloc(0);
    let fragments = [];
    let fragmentBytes = 0;
    let fragmentOpcode;
    session.sockets.add(socket);
    if (session.buffer) {
      socket.write(encodeWebSocketFrame(session.buffer, 1));
    }
    const detach = () => {
      session.sockets.delete(socket);
    };
    socket.on('data', (chunk) => {
      try {
        if (buffer.length + chunk.length > PTY_BUFFER_LIMIT) {
          throw new Error('WebSocket frame buffer too large.');
        }
        buffer = Buffer.concat([buffer, chunk]);
        const decoded = decodeWebSocketFrames(buffer, { maxPayloadBytes: PTY_BUFFER_LIMIT });
        buffer = decoded.remaining;
        for (const frame of decoded.frames) {
          if (frame.opcode === 8) {
            socket.end(encodeWebSocketFrame(Buffer.alloc(0), 8));
            return;
          }
          if (frame.opcode === 9) {
            socket.write(encodeWebSocketFrame(frame.payload, 10));
            continue;
          }
          if (frame.opcode === 0) {
            if (fragmentOpcode === undefined) throw new Error('Unexpected continuation frame.');
            fragmentBytes += frame.payload.length;
            if (fragmentBytes > PTY_BUFFER_LIMIT) throw new Error('WebSocket message too large.');
            fragments.push(frame.payload);
            if (!frame.fin) continue;
            session.pty.write(Buffer.concat(fragments).toString('utf8'));
            fragments = [];
            fragmentBytes = 0;
            fragmentOpcode = undefined;
            continue;
          }
          if (frame.opcode !== 1 && frame.opcode !== 2) continue;
          if (!frame.fin) {
            fragmentOpcode = frame.opcode;
            fragments = [frame.payload];
            fragmentBytes = frame.payload.length;
            continue;
          }
          session.pty.write(frame.payload.toString('utf8'));
        }
      } catch {
        socket.destroy();
      }
    });
    socket.once('close', detach);
    socket.once('error', detach);
    if (head.length > 0) socket.emit('data', head);
    if (session.status === 'exited') {
      sendExitToSocket(session, socket);
      scheduleCleanup(session, 100);
    }
    return true;
  }

  return { create, list, resize, remove, disposeAll, attach };
}

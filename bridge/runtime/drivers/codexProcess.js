import { spawn } from 'node:child_process';
import { detachedProcessOptions, stopProcessTree } from '../../processTree.js';
import { requireValue } from '../../../shared/runtime/capabilities.js';

/** Trusted Bridge configuration only: caller-facing operations cannot alter executable or environment. */
export function createCodexProcess({
  executable = 'codex',
  args = ['app-server'],
  cwd,
  env = process.env,
  maxFrameBytes = 4 * 1024 * 1024,
}) {
  const child = spawn(executable, args, {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
    ...detachedProcessOptions(),
  });
  const messages = new Set(),
    endings = new Set();
  let buffer = Buffer.alloc(0),
    closed = false,
    cleanup,
    failed = false;
  let stderrBytes = 0;
  const exited = new Promise((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal, pid: child.pid })),
  );
  function close() {
    if (!cleanup) {
      closed = true;
      buffer = Buffer.alloc(0);
      child.stdin.end();
      cleanup = stopProcessTree(child);
    }
    return cleanup;
  }
  function fail() {
    if (failed) return;
    failed = true;
    for (const callback of endings) callback();
    void close();
  }
  child.on('error', fail);
  child.stdin.on('error', fail);
  child.on('exit', fail);
  child.stderr.on('data', (chunk) => {
    stderrBytes = Math.min(65536, stderrBytes + chunk.length);
  });
  child.stdout.on('data', (chunk) => {
    if (closed) return;
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      const part = chunk.subarray(start, end);
      if (buffer.length + part.length > maxFrameBytes) {
        fail();
        return;
      }
      buffer = Buffer.concat([buffer, part]);
      if (newline >= 0) {
        const line = buffer.toString('utf8');
        buffer = Buffer.alloc(0);
        for (const callback of messages) callback(line);
      }
      start = end + 1;
    }
  });
  return {
    pid: child.pid,
    exited,
    send(raw) {
      requireValue(
        !closed && !failed && child.stdin.writable,
        'codex.process',
        'source_unavailable',
      );
      requireValue(
        child.stdin.writableLength + Buffer.byteLength(raw) <= 4 * 1024 * 1024,
        'codex.stdin',
        'reconcile_required',
      );
      child.stdin.write(`${raw}\n`);
    },
    subscribe(message, ending) {
      requireValue(!closed && !failed, 'codex.process', 'source_unavailable');
      messages.add(message);
      endings.add(ending);
      return () => {
        messages.delete(message);
        endings.delete(ending);
      };
    },
    close,
    inspection() {
      return { pid: child.pid, closed, stderrBytes, maxFrameBytes, failed };
    },
  };
}

import { spawn as nodeSpawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

import { detachedProcessOptions, stopProcessTree as defaultStopProcessTree } from '../../processTree.js';

/**
 * Process relay for the SSH management channel. Two responsibilities, both security-relevant:
 *
 *  1. **Clean framing** — formal traffic is length-prefixed frames on a plain pipe, never a PTY
 *     and never newline-delimited text, so binary payloads survive intact.
 *  2. **Owned-only lifecycle** — the relay terminates only processes it spawned itself. A pid it
 *     does not own (a borrowed process, a process the user started) is never signalled.
 */
export const RELAY_MAX_FRAME_BYTES = 8 * 1024 * 1024;

export function encodeRelayFrame(data, options = {}) {
  const max = options.maxFrameBytes ?? RELAY_MAX_FRAME_BYTES;
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  if (payload.length > max) throw new Error(`Relay frame too large: ${payload.length} > ${max}.`);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

export function decodeRelayFrames(buffer, options = {}) {
  const max = options.maxFrameBytes ?? RELAY_MAX_FRAME_BYTES;
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 4) {
    const length = buffer.readUInt32BE(offset);
    if (length > max) throw new Error(`Relay frame too large: ${length} > ${max}.`);
    if (buffer.length - offset < 4 + length) break;
    frames.push(Buffer.from(buffer.subarray(offset + 4, offset + 4 + length)));
    offset += 4 + length;
  }
  return { frames, remaining: Buffer.from(buffer.subarray(offset)) };
}

export function createProcessRelay(options = {}) {
  const spawnProcess = options.spawn ?? nodeSpawn;
  const stopTree = options.stopProcessTree ?? defaultStopProcessTree;
  const platform = options.platform ?? process.platform;
  const maxFrameBytes = options.maxFrameBytes ?? RELAY_MAX_FRAME_BYTES;
  const owned = new Map();
  const buffers = new Map();

  function entry(id) {
    const record = owned.get(id);
    if (record === undefined) throw new Error(`Relay process is not owned: ${String(id)}.`);
    return record;
  }

  function spawnOwned(spec) {
    const child = spawnProcess(spec.command, [...(spec.args ?? [])], {
      ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
      env: spec.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      ...(platform === 'win32' ? {} : detachedProcessOptions()),
    });
    const id = randomUUID();
    const record = { id, child, owned: true, command: spec.command, error: undefined, errorHandlers: [] };
    owned.set(id, record);
    buffers.set(id, Buffer.alloc(0));
    // A failed spawn (ENOENT/EACCES) raises 'error' asynchronously; with no listener Node
    // escalates that to an uncaught exception that kills the host process, so the record
    // always owns the event and fans it out to any dial waiting on this process.
    if (typeof child.on === 'function') {
      child.on('error', (error) => {
        record.error = error;
        for (const handler of record.errorHandlers.splice(0)) handler(error);
      });
    }
    return { id, pid: child.pid, child, owned: true };
  }

  function send(id, data) {
    entry(id).child.stdin?.write(encodeRelayFrame(data, { maxFrameBytes }));
  }

  function onMessage(id, handler) {
    const record = entry(id);
    if (typeof record.child.stdout?.on !== 'function') return;
    record.child.stdout.on('data', (chunk) => {
      const previous = buffers.get(id) ?? Buffer.alloc(0);
      let decoded;
      try {
        decoded = decodeRelayFrames(Buffer.concat([previous, chunk]), { maxFrameBytes });
      } catch {
        buffers.set(id, Buffer.alloc(0));
        record.child.kill?.();
        return;
      }
      buffers.set(id, decoded.remaining);
      for (const frame of decoded.frames) handler(frame);
    });
  }

  function onExit(id, handler) {
    const record = entry(id);
    if (record.child.exitCode !== null && record.child.exitCode !== undefined) {
      handler(record.child.exitCode);
      return;
    }
    record.child.once('exit', handler);
  }

  /** Routes a spawn 'error' to a dial so it can reject instead of crashing the host. */
  function onError(id, handler) {
    const record = entry(id);
    if (record.error !== undefined) {
      handler(record.error);
      return;
    }
    record.errorHandlers.push(handler);
  }

  /** Terminates only a process this relay spawned; a foreign id is a no-op returning false. */
  async function terminate(id) {
    const record = owned.get(id);
    if (record === undefined || record.owned !== true) return false;
    owned.delete(id);
    buffers.delete(id);
    // A spawn failure (ENOENT/EACCES) leaves no pid and no process to signal; stopTree would
    // otherwise block waiting for an exit event that never arrives.
    if (record.child.pid !== undefined) await stopTree(record.child);
    return true;
  }

  async function terminateAll() {
    await Promise.all([...owned.keys()].map((id) => terminate(id)));
  }

  return Object.freeze({
    spawnOwned,
    isOwned: (id) => owned.get(id)?.owned === true,
    ownedIds: () => Object.freeze([...owned.keys()]),
    pids: () => Object.freeze([...owned.values()].map((record) => record.child.pid)),
    send,
    onMessage,
    onExit,
    onError,
    terminate,
    terminateAll,
  });
}

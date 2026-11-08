import { EventEmitter } from 'node:events';
import { stopProcessTree } from '../processTree.js';
import { randomUUID } from 'node:crypto';
import { loadNodePty } from '../ptyManager.js';
import { LIMITS } from '../../shared/runtime/protocol.js';
import { integerValue, requireValue, textValue } from '../../shared/runtime/capabilities.js';

const OUTPUT_BYTES = 2 * 1024 * 1024;
function boundary(bytes, offset) {
  while (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80) offset++;
  return offset;
}
export function createPtyService() {
  const sessions = new Map();
  let active = true;
  function remove(entry) {
    entry.removing ??= stopProcessTree(entry.child).then(() => {
      sessions.delete(entry.id);
      entry.subscribers.clear();
    }, error => { entry.removing = undefined; throw error; });
    return entry.removing;
  }
  function connect(scope) {
    function owned(id, ownerOnly = false) {
      scope.assertCurrent();
      const entry = sessions.get(id);
      requireValue(entry !== undefined, 'pty', 'conflict');
      scope.authorize(entry.workspaceKey, 'pty');
      if (ownerOnly) requireValue(entry.owner === scope.subscriberId, 'pty.owner', 'unauthorized');
      return entry;
    }
    function subscription(id) {
      const entry = owned(id);
      const subscriber = entry.subscribers.get(scope);
      requireValue(subscriber !== undefined, 'pty.subscriber', 'unauthorized');
      requireValue(subscriber.cursor >= entry.start, 'pty.output.expired', 'replay_required');
      return { entry, subscriber };
    }
    return {
      async create({ workspaceKey, command, args = [], cwd = '.' }) {
        scope.authorize(workspaceKey, 'pty');
        textValue(command, 'command');
        requireValue(Array.isArray(args) && args.every(arg => typeof arg === 'string'), 'args');
        const directory = await scope.directory(workspaceKey, cwd);
        const native = await loadNodePty();
        scope.assertCurrent();
        requireValue(active, 'pty.closed', 'source_unavailable');
        const process = native.spawn(command, args, { cwd: directory, env: globalThis.process.env, name: 'xterm-256color', cols: 80, rows: 24 });
        const child = Object.assign(new EventEmitter(), { pid: process.pid, exitCode: null, kill: signal => process.kill(signal) });
        const id = randomUUID();
        const entry = { id, process, child, workspaceKey, owner: scope.subscriberId, buffer: Buffer.alloc(0), start: 0, end: 0, subscribers: new Map(), exited: false, exitCode: null };
        sessions.set(id, entry);
        process.onData(data => {
          const bytes = Buffer.from(data, 'utf8');
          entry.buffer = Buffer.concat([entry.buffer, bytes]);
          entry.end += bytes.length;
          const trim = boundary(entry.buffer, Math.max(0, entry.buffer.length - OUTPUT_BYTES));
          entry.buffer = entry.buffer.subarray(trim);
          entry.start = entry.end - entry.buffer.length;
        });
        process.onExit(event => { entry.exited = true; entry.exitCode = event.exitCode; child.exitCode = event.exitCode; child.emit('exit', event.exitCode); });
        return { ptyId: id, pid: process.pid };
      },
      subscribe(id) {
        const entry = owned(id);
        requireValue(!entry.subscribers.has(scope), 'pty.subscriber.duplicate', 'conflict');
        entry.subscribers.set(scope, { cursor: entry.start, inflight: new Map() });
        return { offset: entry.start, credits: LIMITS.channelCredits };
      },
      read(id) {
        const { entry, subscriber } = subscription(id);
        const chunks = [];
        while (subscriber.cursor < entry.end && subscriber.inflight.size < LIMITS.channelCredits) {
          const start = subscriber.cursor - entry.start;
          let end = Math.min(entry.buffer.length, start + LIMITS.binaryBytes);
          while (end < entry.buffer.length && (entry.buffer[end] & 0xc0) === 0x80) end--;
          const data = Buffer.from(entry.buffer.subarray(start, end));
          const offset = subscriber.cursor;
          subscriber.cursor += data.length;
          subscriber.inflight.set(offset, data.length);
          chunks.push({ offset, length: data.length, data });
        }
        return { chunks, exited: entry.exited, exitCode: entry.exitCode, bufferedBytes: entry.buffer.length };
      },
      acknowledge(id, chunk) {
        const { subscriber } = subscription(id);
        requireValue(subscriber.inflight.get(chunk.offset) === chunk.length, 'pty.ack', 'conflict');
        subscriber.inflight.delete(chunk.offset);
      },
      write(id, data) {
        const { entry } = subscription(id);
        requireValue(typeof data === 'string' && Buffer.byteLength(data) <= LIMITS.binaryBytes, 'pty.input');
        requireValue(!entry.exited, 'pty.exited', 'conflict');
        entry.process.write(data);
      },
      resize(id, size) {
        const { entry } = subscription(id);
        integerValue(size.cols, 'cols', 1000); integerValue(size.rows, 'rows', 1000);
        requireValue(size.cols > 0 && size.rows > 0, 'pty.size');
        entry.process.resize(size.cols, size.rows);
      },
      detach(id) { owned(id).subscribers.delete(scope); },
      remove(id) { return remove(owned(id, true)); },
    };
  }
  return {
    connect,
    disconnect(scope) { for (const entry of sessions.values()) entry.subscribers.delete(scope); },
    async close() {
      active = false;
      const results = await Promise.allSettled([...sessions.values()].map(remove));
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
      if (errors.length) throw new AggregateError(errors, 'PTY shutdown failed');
    },
  };
}

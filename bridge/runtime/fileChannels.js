import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdtemp, open, link, rm } from 'node:fs/promises';
import path from 'node:path';
import { LIMITS, validateChunk } from '../../shared/runtime/protocol.js';
import { integerValue, requireValue, textValue } from '../../shared/runtime/capabilities.js';
import { resolveWritablePath } from '../workspaceFs.js';

export function createFileChannels() {
  const channels = new Map();
  let serial = 0;
  let closed = false;
  function discard(entry) {
    entry.cleanup ??= (async () => {
      await entry.pending;
      await entry.handle.close();
      await rm(entry.staging, { recursive: true, force: true });
      channels.delete(entry.id);
    })();
    return entry.cleanup;
  }
  function connect(scope) {
    function owned(id) {
      scope.assertCurrent();
      const entry = channels.get(id);
      requireValue(entry?.scope === scope && !entry.finishing, 'channel.owner', 'unauthorized');
      scope.authorize(entry.workspaceKey, 'write');
      return entry;
    }
    return {
      async open({ workspaceKey, path: relative, size, sha256 }) {
        const grant = scope.authorize(workspaceKey, 'write');
        textValue(relative, 'path'); integerValue(size, 'size');
        requireValue(typeof sha256 === 'string' && /^[a-f0-9]{64}$/.test(sha256), 'sha256');
        requireValue(!closed && channels.size < LIMITS.bulkChannels, 'channel.capacity', 'conflict');
        const id = ++serial;
        let ready;
        const opening = new Promise(resolve => { ready = resolve; });
        const entry = { id, scope, workspaceKey, finishing: true, opening };
        channels.set(id, entry);
        try {
          const destination = path.resolve(grant.root, relative);
          await resolveWritablePath(destination, grant.root);
          entry.staging = await mkdtemp(path.join(grant.root, '.vis-upload-'));
          entry.handle = await open(path.join(entry.staging, 'payload'), constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          scope.assertCurrent();
          requireValue(!closed, 'channel.closed', 'cancelled');
          Object.assign(entry, { root: grant.root, destination, size, sha256, next: 0, inflight: new Map(), hash: createHash('sha256'), pending: Promise.resolve(), finishing: false });
          return { channelId: id, credits: LIMITS.channelCredits, chunkBytes: LIMITS.binaryBytes };
        } catch (error) {
          if (entry.handle) await entry.handle.close();
          if (entry.staging) await rm(entry.staging, { recursive: true, force: true });
          channels.delete(id);
          throw error;
        } finally { ready(); }
      },
      append({ channelId, offset, data }) {
        const entry = owned(channelId);
        requireValue(data instanceof Uint8Array, 'chunk.data');
        const chunk = validateChunk({ channelId, offset, length: data.byteLength });
        requireValue(offset === entry.next && entry.next + chunk.length <= entry.size, 'chunk.offset', 'conflict');
        requireValue(entry.inflight.size < LIMITS.channelCredits, 'channel.credit', 'conflict');
        const bytes = Buffer.from(data);
        entry.next += bytes.length;
        entry.inflight.set(offset, { length: bytes.length, ready: false });
        const result = entry.pending.then(async () => {
          scope.assertCurrent();
          await entry.handle.writeFile(bytes);
          entry.hash.update(bytes);
          entry.inflight.get(offset).ready = true;
          return chunk;
        });
        entry.pending = result.catch(error => { entry.error = error; });
        return result;
      },
      acknowledge(chunk) {
        const entry = owned(chunk.channelId);
        const sent = entry.inflight.get(chunk.offset);
        requireValue(sent?.ready && sent.length === chunk.length, 'channel.ack', 'conflict');
        entry.inflight.delete(chunk.offset);
      },
      finish(channelId) {
        const entry = owned(channelId);
        requireValue(entry.inflight.size === 0 && entry.next === entry.size, 'channel.incomplete', 'conflict');
        entry.finishing = true;
        entry.completion = (async () => {
        try {
          await entry.pending;
          if (entry.error) throw entry.error;
          requireValue(entry.hash.digest('hex') === entry.sha256, 'attachment.hash', 'conflict');
          await entry.handle.sync();
          scope.assertCurrent();
          await resolveWritablePath(entry.destination, entry.root);
          scope.assertCurrent();
          // A hard link publishes only a new destination; existing caller bytes are never overwritten.
          await link(path.join(entry.staging, 'payload'), entry.destination);
          return { path: entry.destination, sha256: entry.sha256, size: entry.size };
        } finally { await discard(entry); }
        })();
        return entry.completion;
      },
      async cancel(channelId) { const entry = owned(channelId); entry.finishing = true; await discard(entry); },
    };
  }
  async function release(entries) {
    const results = await Promise.allSettled(entries.map(async entry => {
      await entry.opening;
      if (!channels.has(entry.id)) return;
      if (entry.completion) { await Promise.allSettled([entry.completion]); await entry.cleanup; return; }
      entry.finishing = true; await discard(entry);
    }));
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length) throw new AggregateError(errors, 'Attachment cleanup failed');
  }
  return { connect, disconnect: scope => release([...channels.values()].filter(entry => entry.scope === scope)), close() { closed = true; return release([...channels.values()]); } };
}

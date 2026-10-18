import { decodeBinary, encodeBinary, LIMITS } from '../../shared/runtime/protocol.js';
import { requireValue } from '../../shared/runtime/capabilities.js';

export function createRuntimeChannels({ canSend }) {
  const entries = new Map();
  let serial = 0;
  function owned(binding, id) {
    const entry = entries.get(id);
    requireValue(entry && entry.binding.target === binding.target, 'channel.target', 'unauthorized');
    requireValue(entry.binding.epoch === binding.epoch && entry.binding.generation === binding.generation, 'channel.binding', 'reconcile_required');
    entry.current(); return entry;
  }
  function count(target) { return [...entries.values()].filter(entry => entry.binding.target === target).length; }
  return {
    async open(context, input) {
      context.current();
      requireValue(count(context.binding.target) < LIMITS.bulkChannels && serial < 65536, 'channel.capacity', 'source_unavailable');
      const channelId = ++serial;
      const entry = { ...context, channelId, service: input.service, pending: new Map(), base: 0, local: null };
      entries.set(channelId, entry);
      try {
        switch (input.service) {
          case 'file': {
            const descriptor = await context.workspace.files.open(input);
            entry.local = descriptor.channelId; break;
          }
          case 'pty': {
            requireValue(![...entries.values()].some(other => other !== entry && other.workspace === context.workspace && other.local === input.ptyId), 'pty.channel_duplicate', 'conflict');
            const descriptor = context.workspace.ptys.subscribe(input.ptyId);
            entry.local = input.ptyId; entry.base = descriptor.offset; break;
          }
        }
        context.current();
        return { channelId, service: input.service, direction: input.service === 'file' ? 'upload' : 'download', credits: 4, chunkBytes: 65536, offset: 0 };
      } catch (error) { entries.delete(channelId); throw error; }
    },
    binary(bytes) {
      const chunk = decodeBinary(bytes), entry = entries.get(chunk.channelId);
      requireValue(entry?.service === 'file', 'channel.upload', 'unauthorized');
      entry.current();
      requireValue(entry.local !== null && entry.pending.size < 4 && !entry.pending.has(chunk.offset), 'channel.credit', 'conflict');
      const pending = { length: chunk.length, promise: entry.workspace.files.append({ ...chunk, channelId: entry.local }) };
      entry.pending.set(chunk.offset, pending);
      pending.promise.catch(error => { pending.error = error; });
    },
    async acknowledge(binding, chunk) {
      const entry = owned(binding, chunk.channelId);
      switch (entry.service) {
        case 'file': {
          const pending = entry.pending.get(chunk.offset);
          requireValue(pending && pending.length === chunk.length, 'channel.ack', 'conflict');
          requireValue(!pending.acknowledging, 'channel.duplicate_ack', 'conflict');
          pending.acknowledging = true;
          await pending.promise; entry.current();
          entry.workspace.files.acknowledge({ ...chunk, channelId: entry.local });
          entry.pending.delete(chunk.offset); break;
        }
        case 'pty':
          requireValue(entry.pending.get(chunk.offset) === chunk.length, 'channel.ack', 'conflict');
          entry.workspace.ptys.acknowledge(entry.local, { offset: entry.base + chunk.offset, length: chunk.length });
          entry.pending.delete(chunk.offset); break;
      }
      return chunk;
    },
    async finish(binding, id) {
      const entry = owned(binding, id);
      requireValue(entry.service === 'file' && entry.pending.size === 0, 'channel.incomplete', 'conflict');
      try { return await entry.workspace.files.finish(entry.local); }
      finally { entries.delete(id); }
    },
    async cancel(binding, id) {
      const entry = owned(binding, id); entries.delete(id);
      switch (entry.service) {
        case 'file': await entry.workspace.files.cancel(entry.local); break;
        case 'pty': entry.workspace.ptys.detach(entry.local); break;
      }
      return { closed: true };
    },
    readPty(context, ptyId) {
      const entry = [...entries.values()].find(item => item.workspace === context.workspace && item.service === 'pty' && item.local === ptyId);
      requireValue(entry, 'pty.channel', 'unauthorized'); owned(context.binding, entry.channelId);
      requireValue(canSend(4 * (LIMITS.binaryBytes + 64)), 'channel.backpressure', 'source_unavailable');
      const result = entry.workspace.ptys.read(ptyId);
      const binary = result.chunks.map(chunk => {
        const offset = chunk.offset - entry.base;
        entry.pending.set(offset, chunk.length);
        return encodeBinary({ channelId: entry.channelId, offset, data: chunk.data });
      });
      return { result: { ...result, chunks: result.chunks.map(chunk => ({ channelId: entry.channelId, offset: chunk.offset - entry.base, length: chunk.length })) }, binary };
    },
    detachPty(context, ptyId) {
      for (const [id, entry] of entries) if (entry.workspace === context.workspace && entry.service === 'pty' && entry.local === ptyId) { owned(context.binding, id); entries.delete(id); }
      context.workspace.ptys.detach(ptyId);
    },
    detach(target) { for (const [id, entry] of entries) if (entry.binding.target === target) entries.delete(id); },
    close() { entries.clear(); },
    get size() { return entries.size; },
  };
}


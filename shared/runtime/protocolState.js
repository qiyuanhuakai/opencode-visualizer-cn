import { METHODS, authorizeExtension, requireValue, integerValue } from './capabilities.js';
import { parseBinding, validateFrame, validateChunk, LIMITS } from './protocol.js';

/** Connection-local correlation only. Callers persist intents before accepted replies,
 * authorize ordinary methods, and bound actual socket/log buffers independently. */
export function createProtocolState(input) {
  const binding = parseBinding(input);
  const pending = new Map();
  const usedIds = new Set();
  const channels = new Map();
  const usedChannelIds = new Set();
  let seq = 0;
  let revision = 0;
  const fences = new Map();
  let closed = false;
  function active() { requireValue(!closed, 'connection.closed', 'conflict'); }
  function match(frame) {
    active();
    requireValue(frame.target === binding.target, 'target', 'unauthorized');
    requireValue(frame.epoch === binding.epoch && frame.generation === binding.generation, 'binding', 'reconcile_required');
  }
  function channelChunk(input) {
    active();
    const chunk = validateChunk(input);
    const channel = channels.get(chunk.channelId);
    requireValue(channel !== undefined, 'channel', 'conflict');
    return { channel, chunk };
  }
  return Object.freeze({
    register(input, extensionGrant) {
      const frame = validateFrame(input);
      match(frame);
      requireValue(frame.kind === 'request', 'request');
      requireValue(!usedIds.has(frame.id), 'id', 'conflict');
      requireValue(usedIds.size < 65536, 'request.capacity', 'reconcile_required');
      if (frame.method === 'native.extension') {
        requireValue(extensionGrant !== undefined, 'extension.permission', 'unauthorized');
        authorizeExtension(extensionGrant.capabilities, { owner: frame.params.owner, name: frame.params.name, permissions: extensionGrant.permissions });
      }
      pending.set(frame.id, { method: frame.method, accepted: false });
      usedIds.add(frame.id);
      return frame;
    },
    acceptSnapshot(input, now) {
      const frame = validateFrame(input);
      match(frame);
      integerValue(now, 'now');
      requireValue(frame.kind === 'snapshot', 'snapshot');
      requireValue(frame.expiresAt > now && frame.expiresAt - now <= LIMITS.snapshotTtlMs, 'snapshot.expired', 'replay_required');
      requireValue(frame.revision >= revision && frame.watermark >= seq, 'snapshot.stale', 'replay_required');
      for (const fence of fences.values()) {
        requireValue(frame.revision >= fence, 'snapshot.stale', 'replay_required');
      }
      revision = frame.revision;
      seq = frame.watermark;
      fences.clear();
      return frame;
    },
    receive(input) {
      const frame = validateFrame(input);
      match(frame);
      switch (frame.kind) {
        case 'result': {
          const request = pending.get(frame.id);
          requireValue(request !== undefined, 'response.id', 'conflict');
          if (frame.ok) {
            const mutation = METHODS[request.method] === 'mutation';
            requireValue(mutation ? frame.phase !== 'read' : frame.phase === 'read', 'response.phase', 'conflict');
            if (frame.phase === 'durable-accepted') {
              requireValue(!request.accepted, 'response.duplicate', 'conflict');
              pending.set(frame.id, { ...request, accepted: true });
              return frame;
            }
            requireValue(!mutation || request.accepted, 'response.intent', 'conflict');
          }
          pending.delete(frame.id);
          return frame;
        }
        case 'event':
          requireValue(frame.seq === seq + 1, 'event.cursor', 'replay_required');
          requireValue(frame.entityRevision > (fences.get(frame.scope) ?? revision), 'event.revision', 'replay_required');
          fences.set(frame.scope, frame.entityRevision);
          seq = frame.seq;
          return frame;
        case 'replay': {
          requireValue(frame.after === seq, 'replay.cursor', 'replay_required');
          const nextFences = new Map(fences);
          for (const event of frame.events) {
            requireValue(event.entityRevision > (nextFences.get(event.scope) ?? revision), 'event.revision', 'replay_required');
            nextFences.set(event.scope, event.entityRevision);
          }
          for (const [scope, fence] of nextFences) fences.set(scope, fence);
          seq = frame.through;
          return frame;
        }
        default:
          requireValue(false, 'receive.kind');
      }
    },
    openChannel(channelId) {
      active();
      integerValue(channelId, 'channelId', 0xffffffff);
      requireValue(channelId > 0 && !usedChannelIds.has(channelId) && channels.size < LIMITS.bulkChannels, 'channel', 'conflict');
      requireValue(usedChannelIds.size < 65536, 'channel.capacity', 'reconcile_required');
      usedChannelIds.add(channelId);
      channels.set(channelId, { nextOffset: 0, inflight: new Map() });
    },
    reserveChunk(input) {
      const { channel, chunk } = channelChunk(input);
      requireValue(channel.inflight.size < LIMITS.channelCredits && chunk.offset === channel.nextOffset, 'credit', 'conflict');
      channel.inflight.set(chunk.offset, chunk.length);
      channel.nextOffset += chunk.length;
      return chunk;
    },
    acknowledgeChunk(input) {
      const { channel, chunk } = channelChunk(input);
      requireValue(channel.inflight.get(chunk.offset) === chunk.length, 'ack', 'conflict');
      channel.inflight.delete(chunk.offset);
    },
    closeChannel(channelId) {
      active();
      const channel = channels.get(channelId);
      requireValue(channel !== undefined && channel.inflight.size === 0, 'channel.busy', 'conflict');
      channels.delete(channelId);
    },
    snapshot() {
      return Object.freeze({ ...binding, seq, revision, fences: [...fences], pending: pending.size, usedIds: usedIds.size, channels: channels.size, closed,
        inflight: [...channels].map(([channelId, channel]) => ({ channelId, nextOffset: channel.nextOffset, chunks: [...channel.inflight] })) });
    },
    close() { pending.clear(); usedIds.clear(); channels.clear(); usedChannelIds.clear(); fences.clear(); closed = true; },
  });
}

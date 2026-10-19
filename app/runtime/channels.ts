import { ProtocolError, requireValue } from '../../shared/runtime/capabilities.js';
import { decodeBinary, encodeBinary, LIMITS, validateChunk } from '../../shared/runtime/protocol.js';
import type { BinaryChunk, Chunk } from '../../shared/runtime/protocol.js';
import type { EnvironmentId } from '../../shared/runtime/identity.js';
import type { ChannelDescriptor, RuntimeParams, RuntimeResults } from '../../shared/runtime/runtimeWire.js';
import { RuntimeRequestError } from './client';
import type { RuntimeClient, RuntimeScope } from './client';
import type { RuntimeConnection } from './connection';

type Inflight = { readonly chunk: Chunk; readonly release: () => void; data?: Uint8Array; delivered: boolean; acknowledging: boolean };
type Waiting = { readonly resolve: (chunk: BinaryChunk) => void; readonly reject: (error: Error) => void; readonly timer: ReturnType<typeof setTimeout> };
type Channel = {
  readonly descriptor: ChannelDescriptor; readonly target: EnvironmentId; readonly scope: RuntimeScope;
  readonly inflight: Map<number, Inflight>; readonly waiting: Map<number, Waiting>;
  offset: number; active: boolean; reading: boolean;
};
type FileParams = Omit<Extract<RuntimeParams['runtime.channel.open'], { service: 'file' }>, 'service'>;

export function createRuntimeChannels({ client, connection }: { readonly client: RuntimeClient; readonly connection: RuntimeConnection }) {
  const channels = new Map<number, Channel>();
  const used = new Set<number>();
  const opening = new Map<EnvironmentId, number>();
  let generation = connection.status.generation;
  let disposed = false;

  function active(channel: Channel) {
    requireValue(!disposed && channel.active && channel.scope.isCurrent(), 'channel.binding', 'reconcile_required');
  }
  function release(channel: Channel) {
    channel.active = false;
    if (channels.get(channel.descriptor.channelId) === channel) channels.delete(channel.descriptor.channelId);
    for (const chunk of channel.inflight.values()) chunk.release();
    channel.inflight.clear();
    for (const wait of channel.waiting.values()) {
      clearTimeout(wait.timer);
      wait.reject(new ProtocolError('reconcile_required', 'channel.closed'));
    }
    channel.waiting.clear();
  }
  function retire(channel: Channel) {
    const current = channel.scope.isCurrent();
    release(channel);
    if (current) connection.disconnect();
  }
  // A pre-enqueue ProtocolError means the server never saw the request, so its
  // slot is untouched and the handle must stay retryable; any other rejection
  // leaves the server outcome unknown and needs explicit cleanup.
  function knownUncommitted(error: unknown) {
    return error instanceof ProtocolError && !(error instanceof RuntimeRequestError) && connection.status.state === 'ready';
  }
  const detach = client.onDetach((target) => {
    for (const channel of channels.values()) if (channel.target === target) release(channel);
  });
  const unsubscribe = connection.subscribe((event) => {
    if (disposed || event.generation !== connection.status.generation) return;
    switch (event.kind) {
      case 'hello':
        for (const channel of channels.values()) release(channel);
        if (generation !== event.generation) { used.clear(); generation = event.generation; }
        break;
      case 'disconnected':
      case 'error':
        for (const channel of channels.values()) release(channel);
        break;
      case 'binary': {
        const chunk = decodeBinary(event.bytes);
        const channel = channels.get(chunk.channelId);
        requireValue(channel !== undefined, 'channel.id', 'conflict');
        active(channel);
        requireValue(channel.descriptor.direction === 'download' && channel.reading, 'channel.direction', 'conflict');
        requireValue(chunk.offset === channel.offset && channel.inflight.size < LIMITS.channelCredits, 'channel.credit', 'conflict');
        const entry: Inflight = { chunk: { channelId: chunk.channelId, offset: chunk.offset, length: chunk.length }, release: () => {}, data: chunk.data, delivered: false, acknowledging: false };
        channel.inflight.set(chunk.offset, entry);
        channel.offset += chunk.length;
        const wait = channel.waiting.get(chunk.offset);
        if (wait) { clearTimeout(wait.timer); channel.waiting.delete(chunk.offset); wait.resolve(chunk); }
        break;
      }
      case 'frame': break;
      default: event satisfies never;
    }
  });

  async function open(target: EnvironmentId, params: RuntimeParams['runtime.channel.open']) {
    requireValue(!disposed, 'channels.closed', 'conflict');
    const scope = client.scope(target);
    const count = [...channels.values()].filter((channel) => channel.target === target).length + (opening.get(target) ?? 0);
    requireValue(count < LIMITS.bulkChannels, 'channel.capacity', 'source_unavailable');
    opening.set(target, (opening.get(target) ?? 0) + 1);
    try {
      const descriptor = await client.request(target, 'runtime.channel.open', params);
      requireValue(scope.isCurrent() && !disposed, 'channel.binding', 'reconcile_required');
      requireValue(descriptor.service === params.service && descriptor.direction === (params.service === 'file' ? 'upload' : 'download') && descriptor.offset === 0, 'channel.descriptor', 'invalid_request');
      requireValue(!used.has(descriptor.channelId), 'channel.reused', 'conflict');
      if (used.size === 65536) { connection.disconnect(); throw new ProtocolError('reconcile_required', 'channel.retired'); }
      used.add(descriptor.channelId);
      const channel: Channel = { descriptor, target, scope, inflight: new Map(), waiting: new Map(), offset: 0, active: true, reading: false };
      channels.set(descriptor.channelId, channel);
      return channel;
    } finally {
      const remaining = (opening.get(target) ?? 1) - 1;
      if (remaining === 0) opening.delete(target); else opening.set(target, remaining);
    }
  }
  async function acknowledge(channel: Channel, input: Chunk) {
    active(channel);
    const chunk = validateChunk(input);
    const entry = channel.inflight.get(chunk.offset);
    requireValue(chunk.channelId === channel.descriptor.channelId && entry !== undefined && entry.chunk.length === chunk.length && entry.delivered && !entry.acknowledging, 'channel.ack', 'conflict');
    entry.acknowledging = true;
    try {
      const result = await client.request(channel.target, 'runtime.channel.ack', chunk);
      active(channel);
      requireValue(result.channelId === chunk.channelId && result.offset === chunk.offset && result.length === chunk.length, 'channel.ack_identity', 'reconcile_required');
      channel.inflight.delete(chunk.offset);
      entry.release();
    } catch (error) {
      retire(channel);
      throw error;
    }
  }
  async function cancel(channel: Channel) {
    if (!channel.active) return;
    if (!channel.scope.isCurrent()) { release(channel); return; }
    try {
      await client.request(channel.target, 'runtime.channel.cancel', { channelId: channel.descriptor.channelId });
    } catch (error) {
      if (!knownUncommitted(error)) retire(channel);
      throw error;
    }
    release(channel);
  }
  async function openFile(target: EnvironmentId, params: FileParams) {
    const channel = await open(target, { ...params, service: 'file' });
    return {
      descriptor: channel.descriptor,
      async write(data: Uint8Array) {
        active(channel);
        requireValue(data.byteLength > 0 && data.byteLength <= LIMITS.binaryBytes, 'channel.chunk');
        requireValue(channel.inflight.size < LIMITS.channelCredits, 'channel.credit', 'source_unavailable');
        requireValue(channel.offset + data.byteLength <= params.size, 'channel.size', 'invalid_request');
        const chunk = { channelId: channel.descriptor.channelId, offset: channel.offset, length: data.byteLength };
        const releaseBytes = connection.reserveOutbound(data.byteLength + 24);
        channel.inflight.set(chunk.offset, { chunk, release: releaseBytes, delivered: true, acknowledging: false });
        channel.offset += chunk.length;
        try {
          connection.send(encodeBinary({ channelId: chunk.channelId, offset: chunk.offset, data }));
          await acknowledge(channel, chunk);
        } catch (error) { retire(channel); throw error; }
      },
      async finish() {
        active(channel);
        requireValue(channel.inflight.size === 0 && channel.offset === params.size, 'channel.incomplete', 'conflict');
        let result: RuntimeResults['runtime.channel.finish'];
        try {
          result = await client.request(target, 'runtime.channel.finish', { channelId: channel.descriptor.channelId });
        } catch (error) {
          if (!knownUncommitted(error)) retire(channel);
          throw error;
        }
        try {
          active(channel);
          requireValue(result.size === params.size && result.sha256 === params.sha256, 'channel.finished_identity', 'reconcile_required');
          return result;
        } finally { release(channel); }
      },
      cancel: () => cancel(channel),
    };
  }
  function binary(channel: Channel, chunk: Chunk): Promise<BinaryChunk> {
    const entry = channel.inflight.get(chunk.offset);
    if (entry?.data) return Promise.resolve({ ...entry.chunk, data: entry.data });
    requireValue(!channel.waiting.has(chunk.offset), 'channel.duplicate', 'conflict');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { channel.waiting.delete(chunk.offset); reject(new ProtocolError('timeout', 'channel.binary')); }, 15000);
      channel.waiting.set(chunk.offset, { resolve, reject, timer });
    });
  }
  async function attachPty(target: EnvironmentId, ptyId: string) {
    const channel = await open(target, { service: 'pty', ptyId });
    return {
      descriptor: channel.descriptor,
      async read(onChunk: (chunk: BinaryChunk) => void | Promise<void>) {
        active(channel);
        requireValue(!channel.reading, 'channel.reading', 'conflict');
        channel.reading = true;
        try {
          const status = await client.request(target, 'runtime.pty.read', { ptyId });
          active(channel);
          requireValue(status.chunks.length <= LIMITS.channelCredits, 'channel.credit', 'conflict');
          for (const metadata of status.chunks) {
            requireValue(metadata.channelId === channel.descriptor.channelId, 'channel.target', 'unauthorized');
            const chunk = await binary(channel, metadata);
            active(channel);
            requireValue(chunk.length === metadata.length, 'channel.length', 'invalid_request');
            const entry = channel.inflight.get(chunk.offset);
            requireValue(entry !== undefined && !entry.delivered, 'channel.duplicate', 'conflict');
            await onChunk(chunk);
            active(channel);
            entry.delivered = true;
            entry.data = undefined;
          }
          return status;
        } catch (error) { retire(channel); throw error; }
        finally { channel.reading = false; }
      },
      ack: (chunk: Chunk) => acknowledge(channel, chunk),
      detach: () => cancel(channel),
    };
  }
  return {
    openFile, attachPty,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const channel of channels.values()) release(channel);
      unsubscribe(); detach(); opening.clear(); used.clear();
    },
  };
}

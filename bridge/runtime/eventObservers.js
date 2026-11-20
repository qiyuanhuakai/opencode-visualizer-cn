import { encodeBinary, encodeFrame, parseBinding } from '../../shared/runtime/protocol.js';
import { createProtocolState } from '../../shared/runtime/protocolState.js';
import { StoreError } from './storage/storeProtocol.js';

export const OBSERVER_LIMITS = Object.freeze({ bytes: 8388608, normalBytes: 6291456, controlBytes: 1048576, normalFrames: 256, controlFrames: 64, observers: 64 });
export function createEventObserver({ binding: input, after, isCurrent, onClose }) {
  const binding = parseBinding(input);
  if (!Number.isSafeInteger(after) || after < 0) throw new StoreError('invalid_request', 'observer_after');
  const protocol = createProtocolState(binding);
  const normal = [];
  const control = [];
  const bulk = [];
  const inflight = new Map();
  let normalBytes = 0;
  let controlBytes = 0;
  let binaryBytes = 0;
  let through = after;
  let consumed = after;
  let recovery = null;
  let closed = false;
  let wakeRead = null;
  function check() {
    if (closed || !isCurrent()) throw new StoreError('replay_required', 'observer_generation');
  }
  function recover(reason, highWater = through) {
    through = Math.max(through, highWater);
    recovery = reason;
    normal.length = 0;
    normalBytes = 0;
    wakeRead?.();
  }
  const observer = {
    binding,
    push(frame, priority = false) {
      check();
      if (frame.seq <= through) return;
      if (frame.seq !== through + 1) recover('sequence_gap');
      const encoded = encodeFrame(frame);
      const bytes = Buffer.byteLength(encoded);
      through = frame.seq;
      if (priority) {
        if (control.length >= OBSERVER_LIMITS.controlFrames || controlBytes + bytes > OBSERVER_LIMITS.controlBytes) {
          control.length = 0;
          controlBytes = 0;
          recover('control_overflow');
        }
        control.push({ encoded, bytes });
        controlBytes += bytes;
        wakeRead?.();
        if (normalBytes + controlBytes + binaryBytes > OBSERVER_LIMITS.bytes) recover('control_backpressure');
      }
      // Retain a bounded contiguous suffix while the consumer replays.
      if (normal.length >= OBSERVER_LIMITS.normalFrames || normalBytes + bytes > OBSERVER_LIMITS.normalBytes || normalBytes + controlBytes + binaryBytes + bytes > OBSERVER_LIMITS.bytes) { recover('observer_overflow'); return; }
      if (frame.payload?.collection === 'session_summaries' && normal.some((entry) => entry.scope === frame.scope)) { recover('summary_coalesced'); return; }
      normal.push({ encoded, bytes, scope: frame.scope, seq: frame.seq });
      normalBytes += bytes;
      wakeRead?.();
    },
    recover,
    read() {
      check();
      if (control.length) {
        const entry = control.shift();
        controlBytes -= entry.bytes;
        return { kind: 'control', frame: JSON.parse(entry.encoded) };
      }
      if (recovery) return { kind: 'replay_required', after: consumed, through, reason: recovery };
      if (normal.length) {
        const entry = normal.shift();
        normalBytes -= entry.bytes;
        consumed = entry.seq;
        return { kind: 'event', frame: JSON.parse(entry.encoded) };
      }
      const chunk = bulk.shift();
      return chunk ? { kind: 'binary', ...chunk } : null;
    },
    drainEvents(limit, bytes) {
      check();
      const events = [];
      while (!recovery && control.length === 0 && events.length < limit && normal[0]?.bytes <= bytes) {
        bytes -= normal[0].bytes;
        events.push(observer.read());
      }
      return events;
    },
    async waitRead(signal, waitMs = 250) {
      if (wakeRead) throw new StoreError('conflict', 'observer_read_pending');
      if (signal?.aborted) throw new StoreError('cancelled', 'observer_read_aborted');
      const ready = observer.read();
      if (ready !== null) return ready;
      try {
        await new Promise(resolve => {
          const finish = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', finish);
            resolve();
          };
          const timer = setTimeout(finish, waitMs);
          wakeRead = finish;
          signal?.addEventListener('abort', finish, { once: true });
        });
        if (signal?.aborted) throw new StoreError('cancelled', 'observer_read_aborted');
        return observer.read();
      } finally {
        wakeRead = null;
      }
    },
    resume(afterReplay) {
      check();
      if (!Number.isSafeInteger(afterReplay) || afterReplay < consumed) throw new StoreError('replay_required', 'observer_recovery_watermark');
      consumed = afterReplay;
      const next = normal.findIndex(entry => entry.seq > afterReplay);
      const coversTail = next >= 0 && normal[next].seq === afterReplay + 1 && normal.at(-1).seq === through;
      if (coversTail) {
        for (const entry of normal.splice(0, next)) normalBytes -= entry.bytes;
      } else {
        normal.length = 0;
        normalBytes = 0;
      }
      recovery = afterReplay < through && !coversTail ? 'events_after_replay' : null;
      through = Math.max(through, afterReplay);
      control.length = 0;
      controlBytes = 0;
      wakeRead?.();
    },
    openChannel(channelId) { check(); protocol.openChannel(channelId); },
    sendBinary(input) {
      check();
      const encoded = encodeBinary(input);
      const descriptor = { channelId: input.channelId, offset: input.offset, length: input.data.byteLength };
      if (normalBytes + controlBytes + binaryBytes + encoded.byteLength > OBSERVER_LIMITS.bytes) recover('binary_backpressure');
      protocol.reserveChunk(descriptor);
      const key = JSON.stringify([input.channelId, input.offset]);
      inflight.set(key, { ...descriptor, bytes: encoded.byteLength });
      binaryBytes += encoded.byteLength;
      bulk.push({ ...descriptor, encoded });
      wakeRead?.();
      return descriptor;
    },
    acknowledgeChunk(chunk) {
      check();
      const key = JSON.stringify([chunk.channelId, chunk.offset]);
      const entry = inflight.get(key);
      if (!entry || bulk.some((queued) => queued.channelId === chunk.channelId && queued.offset === chunk.offset)) throw new StoreError('invalid_request', 'observer_unsent_ack');
      protocol.acknowledgeChunk(chunk);
      inflight.delete(key);
      binaryBytes -= entry.bytes;
    },
    closeChannel(channelId) {
      check();
      protocol.closeChannel(channelId);
      for (const [key, entry] of inflight) if (entry.channelId === channelId) { binaryBytes -= entry.bytes; inflight.delete(key); }
      for (let index = bulk.length - 1; index >= 0; index--) if (bulk[index].channelId === channelId) bulk.splice(index, 1);
    },
    close() {
      if (closed) return;
      closed = true;
      protocol.close();
      normal.length = control.length = bulk.length = 0;
      inflight.clear();
      normalBytes = controlBytes = binaryBytes = 0;
      wakeRead?.();
      onClose();
    },
    get state() { return { bytes: normalBytes + controlBytes + binaryBytes, normal: normal.length, control: control.length, bulk: bulk.length, inflight: inflight.size, through, consumed, recovery, closed }; },
  };
  return observer;
}

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
  function check() {
    if (closed || !isCurrent()) throw new StoreError('replay_required', 'observer_generation');
  }
  function recover(reason) {
    recovery = reason;
    normal.length = 0;
    normalBytes = 0;
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
        if (normalBytes + controlBytes + binaryBytes > OBSERVER_LIMITS.bytes) recover('control_backpressure');
      }
      if (recovery) return;
      if (normal.length >= OBSERVER_LIMITS.normalFrames || normalBytes + bytes > OBSERVER_LIMITS.normalBytes || normalBytes + controlBytes + binaryBytes + bytes > OBSERVER_LIMITS.bytes) { recover('observer_overflow'); return; }
      if (frame.payload?.collection === 'session_summaries' && normal.some((entry) => entry.scope === frame.scope)) { recover('summary_coalesced'); return; }
      normal.push({ encoded, bytes, scope: frame.scope, seq: frame.seq });
      normalBytes += bytes;
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
    resume(afterReplay) {
      check();
      if (!Number.isSafeInteger(afterReplay) || afterReplay < through) throw new StoreError('replay_required', 'observer_recovery_watermark');
      consumed = through = afterReplay;
      recovery = null;
      normal.length = control.length = 0;
      normalBytes = controlBytes = 0;
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
      onClose();
    },
    get state() { return { bytes: normalBytes + controlBytes + binaryBytes, normal: normal.length, control: control.length, bulk: bulk.length, inflight: inflight.size, through, consumed, recovery, closed }; },
  };
  return observer;
}

import { StoreError } from './storage/storeProtocol.js';

export const ADMISSION_LIMITS = Object.freeze({
  connection: 512,
  normal: 256,
  control: 16,
  bytes: 16777216,
  reservedBytes: 1048576,
  deadlineMs: 15000,
});

/** Admission is fail-fast. Timed-out work retains its slot until it actually settles. */
export function createAdmissionQueue({ connectionOnly = false } = {}) {
  const entries = new Set();
  let normal = 0;
  let control = 0;
  let bytes = 0;
  function run({ size = 0, reserved = false, deadlineMs = 15000 } = {}, action) {
    if (
      typeof reserved !== 'boolean' ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      !Number.isInteger(deadlineMs) ||
      deadlineMs < 1 ||
      deadlineMs > 15000 ||
      typeof action !== 'function'
    )
      return Promise.reject(new StoreError('invalid_request', 'admission'));
    if (
      connectionOnly
        ? entries.size >= 512
        : (reserved ? control >= 16 : normal >= 256) ||
          bytes + size > 16777216 - (reserved ? 0 : 1048576)
    )
      return Promise.reject(new StoreError('source_unavailable', 'queue_full'));
    const controller = new AbortController();
    const entry = { controller, size };
    entries.add(entry);
    bytes += size;
    if (reserved) control++;
    else normal++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        controller.abort();
        reject(new StoreError('timeout', 'deadline'));
      }, deadlineMs);
      Promise.resolve()
        .then(() =>
          action(controller.signal, (nextSize) => {
            if (!Number.isSafeInteger(nextSize) || nextSize < 0)
              throw new StoreError('invalid_request', 'admission');
            if (controller.signal.aborted) throw new StoreError('timeout', 'deadline');
            if (bytes - entry.size + nextSize > 16777216 - (reserved ? 0 : 1048576))
              throw new StoreError('source_unavailable', 'queue_full');
            bytes += nextSize - entry.size;
            entry.size = nextSize;
          }),
        )
        .then(resolve, reject)
        .finally(() => {
          clearTimeout(timer);
          entries.delete(entry);
          bytes -= entry.size;
          if (reserved) control--;
          else normal--;
        });
    });
  }
  return {
    run,
    get pending() {
      return { normal, control, bytes, total: entries.size };
    },
  };
}

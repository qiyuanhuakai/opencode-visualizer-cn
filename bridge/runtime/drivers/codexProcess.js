import { spawn } from 'node:child_process';
import { detachedProcessOptions, stopProcessTree } from '../../processTree.js';
import { ProtocolError, requireValue } from '../../../shared/runtime/capabilities.js';

const RAW_HIGH_WATER = 1024 * 1024;
const RAW_LOW_WATER = 128 * 1024;
const RAW_PREFIX_BYTES = 64;
const DRAIN_TAIL_BYTES = 4096;
const rawIdFirst = /^\s*\{\s*"id"\s*:\s*(-?\d+)/u;
const rawResultFirst = /^\s*\{\s*"(?:result|error)"/u;
const rawTailId = /"id"\s*:\s*(-?\d+)\s*\}/u;

function parseEnvelopeId(frame) {
  let parsed;
  try {
    parsed = JSON.parse(frame.toString('utf8'));
  } catch {
    return null;
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Number.isSafeInteger(parsed.id)
    ? parsed.id
    : null;
}

/** History-only raw routing: a registered response frame is streamed as raw bytes before the ordinary
 * line buffer and 4 MiB bound, so an oversized history frame is bounded downstream instead of assembled.
 * An explicit raw `cancel()` (or an early `return()`) abandons the sink, wakes a pending `next()`,
 * resumes the shared stdout, and discards the in-flight frame up to its newline, so a later RPC is not
 * blocked; the raw slot is freed immediately and the abandoned frame's id is retained so its late bytes
 * are dropped rather than parsed as the cancelled read's data. A frame that starts with `result`/`error`
 * (no leading id) is attributed by its ACTUAL trailing envelope id: while a live raw read owns the sink
 * its response streams immediately, and once a raw read is abandoned the frame is bound-buffered until
 * its id is known, then routed to the live sink, to the abandoned discard, or to the ordinary parser.
 * A bound-buffered frame that outgrows the ordinary bound BEFORE its id is known cannot be attributed
 * at all, so it is drained to its newline and published to no sink: guessing would route one request's
 * bytes into another's sink. The drain keeps a bounded tail window, and the trailing envelope id found
 * there retires the candidate that owned the frame, so an abandoned id never outlives its own frame
 * and force a later pending read's response into the same drain. If a later frame proves the drained
 * bytes belonged to the pending read, that read fails instead of parking forever.
 */
export function createCodexProcess({
  executable = 'codex',
  args = ['app-server'],
  cwd,
  env = process.env,
  maxFrameBytes = 4 * 1024 * 1024,
} = {}) {
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
  let mode = 'ordinary',
    prefix = Buffer.alloc(0),
    pendingRawId = null,
    rawSink = null,
    abandonedRawId = null,
    drainedUnattributed = false,
    drainTail = null;
  const exited = new Promise((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal, pid: child.pid })),
  );
  function createRawSink(id) {
    const state = { id, queue: [], waiter: null, ended: false, error: null, bytes: 0 };
    return {
      state,
      push(bytes) {
        if (state.ended || state.error) return;
        if (state.waiter) {
          const waiter = state.waiter;
          state.waiter = null;
          waiter.resolve({ value: bytes, done: false });
        } else {
          state.queue.push(bytes);
          state.bytes += bytes.byteLength;
        }
      },
      end() {
        if (state.ended || state.error) return;
        state.ended = true;
        const waiter = state.waiter;
        state.waiter = null;
        waiter?.resolve({ value: undefined, done: true });
      },
      fail(error) {
        if (state.ended || state.error) return;
        state.error = error;
        const waiter = state.waiter;
        state.waiter = null;
        waiter?.reject(error);
      },
      abandon() {
        if (state.ended || state.error) return;
        state.ended = true;
        const waiter = state.waiter;
        state.waiter = null;
        waiter?.resolve({ value: undefined, done: true });
        state.queue.length = 0;
        state.bytes = 0;
      },
      next() {
        if (state.error) return Promise.reject(state.error);
        const value = state.queue.shift();
        if (value) {
          state.bytes -= value.byteLength;
          return Promise.resolve({ value, done: false });
        }
        if (state.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve, reject) => {
          state.waiter = { resolve, reject };
        });
      },
    };
  }
  function classify(segment) {
    const head = segment.subarray(0, RAW_PREFIX_BYTES).toString('latin1');
    const idMatch = rawIdFirst.exec(head);
    if (idMatch) {
      const id = Number(idMatch[1]);
      if (id === pendingRawId) return 'raw';
      if (id === abandonedRawId) return 'abandoned';
      return 'ordinary';
    }
    if (rawResultFirst.test(head)) {
      if (abandonedRawId === null && pendingRawId !== null) return 'raw';
      if (abandonedRawId !== null) return 'defer';
    }
    return 'ordinary';
  }
  /** Direct cancellation: wake a parked `next()` with done, free the raw slot immediately, and
   * retain the id so a late frame is discarded to its newline instead of parsed as live data. */
  function cancelRaw(sink, id) {
    if (sink.state.ended || sink.state.error) return;
    sink.abandon();
    if (rawSink === sink) rawSink = null;
    if (pendingRawId === id) pendingRawId = null;
    drainedUnattributed = false;
    if (mode === 'raw' || mode === 'classify' || buffer.length > 0 || prefix.length > 0)
      mode = 'discard';
    else abandonedRawId = id;
    prefix = Buffer.alloc(0);
    buffer = Buffer.alloc(0);
    if (child.stdout.isPaused()) child.stdout.resume();
  }
  function resumeRaw() {
    if (rawSink && child.stdout.isPaused() && rawSink.state.bytes <= RAW_LOW_WATER) child.stdout.resume();
  }
  function finishRaw() {
    const sink = rawSink;
    rawSink = null;
    pendingRawId = null;
    drainedUnattributed = false;
    mode = 'ordinary';
    sink?.end();
    if (child.stdout.isPaused()) child.stdout.resume();
  }
  /** A drained frame turned out to be the pending raw read's own response, so its bytes are already
   * gone: the read is failed rather than left parked on a frame that will never arrive. */
  function failDrainedRaw() {
    const sink = rawSink;
    if (sink === null) return;
    drainedUnattributed = false;
    rawSink = null;
    pendingRawId = null;
    sink.fail(new ProtocolError('reconcile_required', 'codex.raw_frame'));
    if (child.stdout.isPaused()) child.stdout.resume();
  }
  /** A drained frame is consumed to its newline and published to no sink, so its trailing envelope
   * id — read from a bounded tail window, since the frame itself may far exceed the bound — is the
   * only way to learn which request owned it. Retiring the matching candidate is what keeps an
   * abandoned id from outliving its own frame: a stale `abandonedRawId` keeps forcing later
   * result-first frames into the deferred path, where an oversized one is drained again and the
   * pending read's only response disappears with no data and no error. An id matching no candidate
   * retires nothing, so an unattributable drain still arms the second-drain failure. */
  function retireDrainedFrame() {
    const tail = drainTail;
    drainTail = null;
    if (tail === null || tail.length === 0) return;
    const match = rawTailId.exec(tail.toString('latin1'));
    const id = match === null ? null : Number(match[1]);
    if (id === null || !Number.isSafeInteger(id)) return;
    if (id === abandonedRawId) {
      abandonedRawId = null;
      drainedUnattributed = false;
      return;
    }
    if (id === pendingRawId) failDrainedRaw();
  }
  function pushToRaw(bytes) {
    if (!rawSink) return;
    rawSink.push(bytes);
    if (rawSink.state.bytes >= RAW_HIGH_WATER) child.stdout.pause();
  }
  /** Resolve a bound-buffered result-first/error-first frame (`buffer`) by its actual envelope id.
   * `complete` means the terminating newline has been consumed; otherwise the id is unknown until the
   * frame either closes or outgrows the ordinary bound. An outgrown frame whose id is still unknown
   * is `drain`: it is not attributable, so it is consumed to its newline and published to no sink. */
  function resolveDeferredFrame(complete) {
    if (complete) {
      const id = parseEnvelopeId(buffer);
      if (id === pendingRawId) return 'raw';
      if (id === abandonedRawId) return 'abandoned';
      return 'ordinary';
    }
    if (buffer.length <= maxFrameBytes) return 'need-more';
    if (pendingRawId === null && abandonedRawId === null) return 'fail';
    return 'drain';
  }
  function applyDeferred(kind, newline, end) {
    if (kind === 'need-more') {
      mode = 'classify';
      return newline >= 0 ? end + 1 : end;
    }
    if (kind === 'fail') {
      fail();
      return -1;
    }
    const next = newline >= 0 ? end + 1 : end;
    if (kind === 'drain') {
      // Never publish an unattributable frame: a guess would put one request's bytes in another's
      // sink. Remember that a live read may have lost its response, so a later frame that proves
      // the drained bytes were that read's own can fail it instead of parking it forever. There are
      // at most two candidates (one pending, one abandoned), so a SECOND unattributable frame means
      // both have been drained and the pending read's response is certainly gone.
      buffer = Buffer.alloc(0);
      if (rawSink !== null) {
        if (drainedUnattributed) failDrainedRaw();
        else drainedUnattributed = true;
      }
      // The frame's id is only knowable at its newline, so the discard that follows keeps a bounded
      // tail window and retires whichever candidate that trailing id names.
      drainTail = Buffer.alloc(0);
      mode = newline >= 0 ? 'ordinary' : 'discard';
      return next;
    }
    if (kind === 'raw') {
      mode = 'raw';
      pushToRaw(buffer);
      buffer = Buffer.alloc(0);
      if (newline >= 0) finishRaw();
      return next;
    }
    if (kind === 'abandoned') {
      abandonedRawId = null;
      if (drainedUnattributed) failDrainedRaw();
      buffer = Buffer.alloc(0);
      mode = newline >= 0 ? 'ordinary' : 'discard';
      return next;
    }
    mode = 'ordinary';
    if (newline >= 0) emitLine();
    return next;
  }
  function emitLine() {
    const line = buffer.toString('utf8');
    buffer = Buffer.alloc(0);
    for (const callback of messages) callback(line);
  }
  function fail() {
    if (failed) return;
    failed = true;
    drainTail = null;
    const error = new Error('codex.process');
    rawSink?.fail(error);
    for (const callback of endings) callback();
    void close();
  }
  function close() {
    if (!cleanup) {
      closed = true;
      drainTail = null;
      buffer = Buffer.alloc(0);
      prefix = Buffer.alloc(0);
      rawSink?.fail(new Error('codex.process'));
      child.stdin.end();
      cleanup = stopProcessTree(child);
    }
    return cleanup;
  }
  function send(raw) {
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
      const segment = chunk.subarray(start, end);
      if (mode === 'discard') {
        if (drainTail !== null) {
          const combined = drainTail.length ? Buffer.concat([drainTail, segment]) : segment;
          drainTail = combined.length <= DRAIN_TAIL_BYTES
            ? combined
            : Buffer.from(combined.subarray(combined.length - DRAIN_TAIL_BYTES));
        }
        if (newline < 0) {
          start = end;
          continue;
        }
        if (drainTail !== null) retireDrainedFrame();
        mode = 'ordinary';
        start = end + 1;
        continue;
      }
      if (mode === 'raw') {
        if (rawSink) {
          rawSink.push(segment);
          if (rawSink.state.bytes >= RAW_HIGH_WATER) child.stdout.pause();
        }
        if (newline < 0) {
          start = end;
          continue;
        }
        finishRaw();
        start = end + 1;
        continue;
      }
      if (mode === 'classify') {
        if (segment.length) buffer = buffer.length ? Buffer.concat([buffer, segment]) : segment;
        if (newline < 0 && buffer.length <= maxFrameBytes) {
          start = end;
          continue;
        }
        const next = applyDeferred(resolveDeferredFrame(newline >= 0), newline, end);
        if (next < 0) return;
        start = next;
        continue;
      }
      const tracking = pendingRawId !== null || abandonedRawId !== null;
      if (
        buffer.length === 0 &&
        tracking &&
        newline < 0 &&
        prefix.length + segment.length < RAW_PREFIX_BYTES
      ) {
        prefix = Buffer.concat([prefix, segment]);
        start = end;
        continue;
      }
      const candidate = prefix.length ? Buffer.concat([prefix, segment]) : segment;
      prefix = Buffer.alloc(0);
      if (buffer.length === 0 && tracking) {
        const classification = classify(candidate);
        if (classification === 'raw') {
          mode = 'raw';
          pushToRaw(candidate);
          if (newline < 0) {
            start = end;
            continue;
          }
          finishRaw();
          start = end + 1;
          continue;
        }
        if (classification === 'abandoned') {
          abandonedRawId = null;
          if (drainedUnattributed) failDrainedRaw();
          mode = 'discard';
          if (newline < 0) {
            start = end;
            continue;
          }
          mode = 'ordinary';
          start = end + 1;
          continue;
        }
        if (classification === 'defer') {
          buffer = candidate;
          const next = applyDeferred(resolveDeferredFrame(newline >= 0), newline, end);
          if (next < 0) return;
          start = next;
          continue;
        }
      }
      if (buffer.length + candidate.length > maxFrameBytes) {
        fail();
        return;
      }
      buffer = Buffer.concat([buffer, candidate]);
      if (newline < 0) {
        start = end;
        continue;
      }
      emitLine();
      start = end + 1;
    }
  });
  return {
    pid: child.pid,
    exited,
    requestRaw(raw, id) {
      requireValue(!closed && !failed, 'codex.process', 'source_unavailable');
      requireValue(
        Number.isSafeInteger(id) && pendingRawId === null && rawSink === null,
        'codex.raw_request',
        'conflict',
      );
      const sink = createRawSink(id);
      pendingRawId = id;
      rawSink = sink;
      send(raw);
      const cancel = () => cancelRaw(sink, id);
      const iterator = {
        next() {
          const result = sink.next();
          resumeRaw();
          return result;
        },
        return() {
          cancel();
          return Promise.resolve({ value: undefined, done: true });
        },
      };
      return { [Symbol.asyncIterator]() { return iterator; }, cancel };
    },
    send,
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
      return {
        pid: child.pid,
        closed,
        stderrBytes,
        maxFrameBytes,
        failed,
        rawPending: pendingRawId !== null,
      };
    },
  };
}

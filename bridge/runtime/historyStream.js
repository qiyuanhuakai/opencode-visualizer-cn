import { constants } from 'node:fs';
import { open, lstat, readdir, unlink, rmdir } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { requireValue, ProtocolError } from '../../shared/runtime/capabilities.js';
import { tokenizeHistoryJson } from './historyJsonStream.js';
import { redactHistoryJson } from './historyPrivacy.js';

export const HISTORY_STREAM_LIMITS = Object.freeze({ chunkBytes: 65536, connectionDiskBytes: 268435456, globalDiskBytes: 536870912, pages: 3, records: 200, metadataBytes: 65536, workingBytes: 8388608 });
const PAGE_MEMORY = 524288;
const samePath = (left, right) => left.length === right.length && left.every((part, index) => part === right[index]);
const matchPath = (pattern, path) => pattern.length === path.length && pattern.every((part, index) => part === '*' ? typeof path[index] === 'number' : part === path[index]);
const startToken = token => token.kind === 'start' || token.kind === 'string-start' || token.kind === 'scalar';
const endToken = token => token.kind === 'end' || token.kind === 'string-end' || token.kind === 'scalar';
const sizeValue = value => Number.isSafeInteger(value) && value >= 0;

export function createHistoryDiskBudget(maxBytes = HISTORY_STREAM_LIMITS.globalDiskBytes) {
  requireValue(sizeValue(maxBytes), 'history.disk_limit');
  let used = 0;
  return Object.freeze({
    reserve(bytes) {
      requireValue(sizeValue(bytes), 'history.disk_reservation');
      if (bytes > maxBytes - used) return null;
      used += bytes; let held = bytes, active = true;
      return Object.freeze({
        resize(next) { requireValue(sizeValue(next), 'history.disk_resize'); if (!active || next - held > maxBytes - used) return false; used += next - held; held = next; return true; },
        release() { if (active) { active = false; used -= held; } },
      });
    },
    usage: () => used,
  });
}

function validateGrammar(grammar) {
  requireValue(grammar && Array.isArray(grammar.records) && grammar.records.length <= 16 && Array.isArray(grammar.fields) && grammar.fields.length <= 32 && typeof grammar.validate === 'function', 'history.grammar');
  for (const rule of grammar.records) requireValue(Array.isArray(rule.path) && rule.path.length <= 64 && rule.path.every(part => typeof part === 'string' && part.length <= 4096) && Array.isArray(rule.fields) && rule.fields.length <= 32 && typeof rule.validate === 'function', 'history.record_rule');
  for (const field of [...grammar.fields, ...grammar.records.flatMap(rule => rule.fields)]) requireValue(typeof field.name === 'string' && field.name.length <= 128 && Array.isArray(field.path) && field.path.length <= 64 && field.path.every(part => typeof part === 'string' && part.length <= 4096 || Number.isSafeInteger(part) && part >= 0), 'history.field');
}

export function createHistoryStream({ scope, createDirectory, globalDisk, secrets = [] }) {
  requireValue(typeof scope === 'string' && scope.length > 0 && scope.length <= 4096 && typeof createDirectory === 'function', 'history.owner');
  const pages = new Map(), lifetime = new AbortController(), reads = new Set(), failedSpools = new Set();
  let directory, directoryWork, pending, closing, active = true, diskBytes = 0, reservedDiskBytes = 0, working = 0, peakMemoryBytes = 0, fileHandles = 0, pendingWrites = 0, outputs = 0, outputBytes = 0, readingBytes = 0;
  function usage() {
    const memoryBytes = working + pages.size * PAGE_MEMORY + outputBytes + readingBytes + failedSpools.size * 512;
    peakMemoryBytes = Math.max(peakMemoryBytes, memoryBytes);
    return { memoryBytes, peakMemoryBytes, diskBytes, reservedDiskBytes, pages: pages.size, staging: pending ? 1 : 0, fileHandles, pendingWrites, outputs };
  }
  function check(signal) { requireValue(active && !signal?.aborted, 'history.cancelled', 'cancelled'); }
  async function closeReadHandle(handle) {
    try { await handle.close(); fileHandles--; }
    catch (error) { failedSpools.add({ handle }); throw error; }
  }
  async function ownedDirectory() {
    directoryWork ??= (async () => {
      const path = await createDirectory();
      requireValue(typeof path === 'string' && isAbsolute(path), 'history.directory');
      const info = await lstat(path);
      requireValue(info.isDirectory() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o700 && (typeof process.getuid !== 'function' || info.uid === process.getuid()) && (await readdir(path)).length === 0, 'history.directory_owner', 'unauthorized');
      directory = path; return path;
    })();
    return directoryWork;
  }
  async function release(pageId) {
    const page = pages.get(pageId);
    if (!page) return;
    if (page.releasing) return page.releasing;
    page.releasing = (async () => {
      await Promise.allSettled(page.reads);
      await unlink(page.path);
      pages.delete(pageId); diskBytes -= page.bytes; page.disk.release(); usage();
    })();
    try { await page.releasing; } catch (error) { page.releasing = undefined; throw error; }
  }
  function ingest(input) {
    try {
      check(input.signal); validateGrammar(input.grammar);
      requireValue(!pending && failedSpools.size === 0 && pages.size < HISTORY_STREAM_LIMITS.pages && typeof input.cancel === 'function', 'history.admission', 'source_unavailable');
      const maximum = input.maxBytes ?? HISTORY_STREAM_LIMITS.connectionDiskBytes - diskBytes;
      requireValue(sizeValue(maximum) && maximum > 0 && maximum <= HISTORY_STREAM_LIMITS.connectionDiskBytes - diskBytes, 'history.connection_disk', 'source_unavailable');
      const disk = globalDisk.reserve(maximum);
      requireValue(disk, 'history.global_disk', 'source_unavailable');
      const signal = AbortSignal.any([lifetime.signal, ...(input.signal ? [input.signal] : [])]);
      let cancelling;
      const cancel = () => { cancelling ??= Promise.resolve().then(() => input.cancel()).then(() => ({ ok: true }), error => ({ ok: false, error })); return cancelling; };
      const abort = () => { void cancel(); };
      signal.addEventListener('abort', abort, { once: true });
      reservedDiskBytes = maximum; working = HISTORY_STREAM_LIMITS.workingBytes; usage();
      const work = (async () => {
        let handle, path, completed, primary, ownedPath = false, published = false;
        try {
          const root = await ownedDirectory(); check(signal);
          path = join(root, `${randomUUID()}.json`);
          handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600); ownedPath = true; fileHandles++;
          const buffer = Buffer.alloc(HISTORY_STREAM_LIMITS.chunkBytes), digest = createHash('sha256');
          let buffered = 0, bytes = 0, record, capture, metadataBytes = 0;
          const descriptors = [], ids = new Set(), metadata = Object.create(null);
          const flush = async () => {
            if (!buffered) return;
            check(signal); pendingWrites++; usage();
            try {
              let offset = 0;
              while (offset < buffered) { check(signal); const result = await handle.write(buffer, offset, buffered - offset, null); requireValue(result.bytesWritten > 0, 'history.write', 'source_unavailable'); offset += result.bytesWritten; }
              check(signal); buffered = 0;
            } finally { pendingWrites--; }
          };
          const descriptor = (id, recordId, offset, length, sha256) => Object.freeze({ id, recordId, offset, totalBytes: length, sha256, format: 'native-json-utf8' });
          const captureField = (token, fields, target, relative) => {
            const field = fields.find(field => samePath(field.path, relative));
            if (!field || !startToken(token)) return;
            requireValue(token.kind === 'scalar' || token.kind === 'string-start', 'history.metadata_scalar');
            requireValue(!Object.hasOwn(target, field.name), 'history.metadata_duplicate');
            if (token.kind === 'scalar') { target[field.name] = token.value; metadataBytes += 128; }
            else if (capture && samePath(capture.path, token.path)) capture.targets.push({ target, name: field.name });
            else capture = { path: token.path, targets: [{ target, name: field.name }], value: '' };
          };
          for await (const token of redactHistoryJson(tokenizeHistoryJson(input.source, { signal }), { secrets, signal })) {
            check(signal);
            if (!record && startToken(token)) {
              const rule = input.grammar.records.find(rule => matchPath(rule.path, token.path));
              if (rule) { requireValue(descriptors.length < HISTORY_STREAM_LIMITS.records, 'history.record_limit', 'source_unavailable'); record = { rule, path: token.path, offset: bytes, hash: createHash('sha256'), metadata: Object.create(null) }; }
            }
            if (capture && samePath(capture.path, token.path)) {
              if (token.kind === 'string-data') { metadataBytes += token.text.length * 2 * capture.targets.length; requireValue(metadataBytes <= HISTORY_STREAM_LIMITS.metadataBytes && capture.value.length + token.text.length <= 4096, 'history.metadata_bytes'); capture.value += token.text; }
              if (token.kind === 'string-end') { for (const target of capture.targets) target.target[target.name] = capture.value; capture = undefined; }
            }
            if (record) captureField(token, record.rule.fields, record.metadata, token.path.slice(record.path.length));
            captureField(token, input.grammar.fields, metadata, token.path);
            requireValue(metadataBytes <= HISTORY_STREAM_LIMITS.metadataBytes && token.raw.byteLength <= HISTORY_STREAM_LIMITS.chunkBytes && bytes + token.raw.byteLength <= maximum, 'history.output_quota', 'source_unavailable');
            digest.update(token.raw); record?.hash.update(token.raw); bytes += token.raw.byteLength;
            let offset = 0;
            while (offset < token.raw.length) {
              const length = Math.min(buffer.length - buffered, token.raw.length - offset);
              buffer.set(token.raw.subarray(offset, offset + length), buffered); buffered += length; offset += length;
              if (buffered === buffer.length) await flush();
            }
            if (record && endToken(token) && samePath(record.path, token.path)) {
              const recordId = record.rule.validate(Object.freeze(record.metadata));
              requireValue(typeof recordId === 'string' && recordId.length > 0 && recordId.length <= 512 && !ids.has(recordId), 'history.record_identity');
              ids.add(recordId); descriptors.push(descriptor(randomUUID(), recordId, record.offset, bytes - record.offset, record.hash.digest('hex'))); record = undefined;
            }
          }
          requireValue(!record && !capture, 'history.incomplete');
          input.grammar.validate(Object.freeze(metadata)); await flush(); check(signal);
          const cancelled = await cancel(); if (!cancelled.ok) throw cancelled.error;
          check(signal);
          await handle.close(); handle = undefined; fileHandles--; check(signal);
          const id = randomUUID(), document = descriptor(randomUUID(), '$document', 0, bytes, digest.digest('hex'));
          const publicDescriptor = ({ offset: _offset, ...value }) => Object.freeze(value);
          const result = Object.freeze({ id, scope, document: publicDescriptor(document), records: Object.freeze(descriptors.map(publicDescriptor)) });
          disk.resize(bytes); reservedDiskBytes = 0; diskBytes += bytes;
          pages.set(id, { path, bytes, disk, descriptors: new Map([document, ...descriptors].map(value => [value.id, value])), reads: new Set() });
          published = true; completed = result;
        } catch (error) { primary = error; }
        {
          signal.removeEventListener('abort', abort);
          const failures = primary === undefined ? [] : [primary];
          const cancelled = await cancel(); if (!cancelled.ok && cancelled.error !== primary) failures.push(cancelled.error);
          if (handle) { try { await handle.close(); handle = undefined; fileHandles--; } catch (error) { failures.push(error); } }
          if (!published) {
            if (ownedPath) { try { await unlink(path); ownedPath = false; } catch (error) { if (error?.code === 'ENOENT') ownedPath = false; else failures.push(error); } }
            if (ownedPath || handle) failedSpools.add({ path: ownedPath ? path : undefined, handle, disk });
            else { disk.release(); reservedDiskBytes = 0; }
          }
          working = 0; usage();
          if (failures.length === 1) throw failures[0];
          if (failures.length > 1) throw new AggregateError(failures, 'History producer cleanup failed');
        }
        return completed;
      })();
      pending = work;
      const settled = work.finally(() => { if (pending === work) pending = undefined; usage(); });
      return settled;
    } catch (error) { return Promise.reject(error); }
  }
  function read({ pageId, descriptorId, offset }) {
    try {
      check();
      const page = pages.get(pageId), descriptor = page?.descriptors.get(descriptorId);
      requireValue(page && !page.releasing && descriptor, 'history.descriptor', 'replay_required');
      requireValue(sizeValue(offset) && offset < descriptor.totalBytes, 'history.offset');
      requireValue(outputs === 0 && reads.size === 0, 'history.output_lease', 'source_unavailable');
      const length = Math.min(HISTORY_STREAM_LIMITS.chunkBytes, descriptor.totalBytes - offset);
      readingBytes += length * 3 + 512; usage();
      const work = (async () => {
        let handle;
        try {
          handle = await open(page.path, constants.O_RDONLY | constants.O_NOFOLLOW); fileHandles++;
          const info = await handle.stat(); requireValue(info.size === page.bytes, 'history.spool_changed', 'replay_required');
          const bytes = new Uint8Array(length); let through = 0;
          while (through < length) { check(); const result = await handle.read(bytes, through, length - through, descriptor.offset + offset + through); requireValue(result.bytesRead > 0, 'history.spool_truncated', 'replay_required'); through += result.bytesRead; }
          await handle.close(); handle = undefined; fileHandles--;
          check(); outputs++; outputBytes += length + 512; let held = true; usage();
          return Object.freeze({ bytes, offset, nextOffset: offset + length === descriptor.totalBytes ? null : offset + length, release() { if (held) { held = false; outputs--; outputBytes -= length + 512; usage(); } } });
        } finally {
          try { if (handle) await closeReadHandle(handle); }
          finally { readingBytes -= length * 3 + 512; usage(); }
        }
      })();
      reads.add(work); page.reads.add(work);
      return work.finally(() => { reads.delete(work); page.reads.delete(work); });
    } catch (error) { return Promise.reject(error); }
  }
  function close() {
    if (closing) return closing;
    active = false; lifetime.abort();
    closing = (async () => {
      const results = await Promise.allSettled([...(pending ? [pending] : []), ...reads]);
      const failures = results.flatMap(result => result.status === 'rejected' && !(result.reason instanceof ProtocolError && result.reason.code === 'cancelled') ? [result.reason] : []);
      for (const id of pages.keys()) { try { await release(id); } catch (error) { failures.push(error); } }
      for (const spool of failedSpools) {
        try {
          if (spool.handle) { await spool.handle.close(); spool.handle = undefined; fileHandles--; }
          if (spool.path) await unlink(spool.path);
          spool.disk?.release(); if (spool.disk) reservedDiskBytes = 0; failedSpools.delete(spool); usage();
        } catch (error) { failures.push(error); }
      }
      if (directory) { try { await rmdir(directory); } catch (error) { failures.push(error); } }
      if (failures.length) throw new AggregateError(failures, 'History shutdown failed');
    })();
    return closing;
  }
  return Object.freeze({ ingest, read, release, usage, close });
}

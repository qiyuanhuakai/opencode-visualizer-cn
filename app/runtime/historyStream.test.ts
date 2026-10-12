// @vitest-environment node
import { chmod, mkdir, readdir, rmdir, stat } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createHistoryDiskBudget, createHistoryStream } from '../../bridge/runtime/historyStream.js';
import type { HistoryGrammar } from '../../bridge/runtime/historyStream.js';

const writes = vi.hoisted(() => {
  let before: (() => Promise<void>) | undefined;
  return { set(value: (() => Promise<void>) | undefined) { before = value; }, run: () => before?.() };
});
const deletions = vi.hoisted(() => ({ fail: false }));
// Simulates the Windows lstat result: on win32 Node/libuv synthesises st_mode from the
// file's read-only attribute (writable 0666 / read-only 0444) instead of the POSIX mode bits.
const synthesizedMode = vi.hoisted(() => {
  let mode: number | undefined;
  return { set(value: number | undefined) { mode = value; }, get() { return mode; } };
});
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, unlink: async (...args: Parameters<typeof actual.unlink>) => {
    if (deletions.fail) throw Object.assign(new Error('Injected unlink failure'), { code: 'EACCES' });
    return actual.unlink(...args);
  }, lstat: async (...args: Parameters<typeof actual.lstat>) => {
    const mode = synthesizedMode.get();
    if (mode === undefined) return actual.lstat(...args);
    return { isDirectory: () => true, isSymbolicLink: () => false, mode, uid: typeof process.getuid === 'function' ? process.getuid() : 0 } as unknown as Awaited<ReturnType<typeof actual.lstat>>;
  }, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args), original = handle.write;
    Object.defineProperty(handle, 'write', { value: async (...parameters: readonly unknown[]) => { await writes.run(); return Reflect.apply(original, handle, parameters); } });
    return handle;
  } };
});

const grammar: HistoryGrammar = {
  records: [{ path: ['items', '*'], fields: [{ name: 'id', path: ['id'] }], validate(fields) { if (typeof fields.id !== 'string') throw new TypeError('Missing native identity'); return fields.id; } }],
  fields: [{ name: 'ok', path: ['ok'] }], validate(fields) { if (fields.ok !== true) throw new TypeError('Native error envelope'); },
};
async function* source(raw: string) { const bytes = new TextEncoder().encode(raw); for (let offset = 0; offset < bytes.length; offset += 65536) yield bytes.slice(offset, offset + 65536); }
function fixture(globalDisk = createHistoryDiskBudget(), platform?: string) {
  const directory = join(tmpdir(), `vis-history-substrate-${randomUUID()}`);
  const evidence = process.env.HISTORY_EVIDENCE_DIR;
  if (evidence) appendFileSync(join(evidence, 'directories.jsonl'), JSON.stringify({ directory, phase: 'registered-before-mkdir', owner: process.pid }) + '\n');
  const stream = createHistoryStream({ scope: 'profile/session/generation', globalDisk, createDirectory: async () => { await mkdir(directory, { mode: 0o700 }); return directory; }, ...(platform ? { platform } : {}) });
  return { stream, globalDisk, directory };
}
describe('owned raw history spool', () => {
  it('retains failed-cleanup disk reservations until shutdown removes the file', async () => {
    // Given a malformed native envelope and a filesystem refusing deletion.
    const { stream, globalDisk, directory } = fixture();
    deletions.fail = true;
    try {
      // When ingest cleanup fails; then its disk reservation remains charged.
      await expect(stream.ingest({ source: source('{"ok":false}'), cancel() {}, grammar, maxBytes: 1024 })).rejects.toThrow();
      expect(globalDisk.usage()).toBe(1024);
      expect(stream.usage().reservedDiskBytes).toBe(1024);
      expect(await readdir(directory)).toHaveLength(1);
    } finally { deletions.fail = false; await stream.close(); }
    // Then shutdown retries deletion and releases the retained reservation.
    expect(globalDisk.usage()).toBe(0);
    expect(stream.usage()).toMatchObject({ reservedDiskBytes: 0, memoryBytes: 0, fileHandles: 0 });
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it('publishes exact native records and unknown envelope bytes only after late validation', async () => {
    // Given records whose identity follows unknown payload and a final success field.
    const { stream, directory, globalDisk } = fixture();
    const raw = '{"items":[{"unknown":"body","id":"one"}],"extra":{"a":2},"ok":true}';
    try {
      // When the real filesystem spool ingests then serves the document.
      const page = await stream.ingest({ source: source(raw), cancel() {}, grammar });
      const chunk = await stream.read({ pageId: page.id, descriptorId: page.document.id, offset: 0 });
      // Then hash, bytes, modes and output accounting are observable.
      expect(Buffer.from(chunk.bytes).toString()).toBe(raw);
      expect(page.document.sha256).toBe(createHash('sha256').update(raw).digest('hex'));
      expect(page.records.map(record => record.recordId)).toEqual(['one']);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      for (const file of await readdir(directory)) expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600);
      expect(stream.usage().outputs).toBe(1);
      await stream.release(page.id);
      expect(stream.usage().outputs).toBe(1);
      chunk.release();
      expect(stream.usage().outputs).toBe(0);
      expect(globalDisk.usage()).toBe(0);
    } finally { await stream.close(); }
    await expect(stat(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['{"items":[{"id":"same"},{"id":"same"}],"ok":true}', '{"items":[{"id":"one"}],"ok":false}', '{"items":[{"id":"one"}],"ok":true'])('does not publish failed native content %s', async raw => {
    // Given duplicate identity, native error or truncated syntax.
    const { stream, globalDisk } = fixture();
    try {
      // When ingest fails; then reservations, descriptors and FDs are released.
      await expect(stream.ingest({ source: source(raw), cancel() {}, grammar })).rejects.toThrow();
      expect(stream.usage()).toMatchObject({ pages: 0, staging: 0, fileHandles: 0, pendingWrites: 0 });
      expect(globalDisk.usage()).toBe(0);
    } finally { await stream.close(); }
  });
  it('rejects quota and a fourth page without pulling another source', async () => {
    // Given a quota too small for output and three admitted pages.
    const { stream } = fixture();
    const raw = '{"items":[],"ok":true}';
    try {
      await expect(stream.ingest({ source: source(raw), cancel() {}, grammar, maxBytes: 4 })).rejects.toMatchObject({ code: 'source_unavailable' });
      for (let index = 0; index < 3; index++) await stream.ingest({ source: source(raw), cancel() {}, grammar, maxBytes: 1024 });
      let pulled = false;
      const unexpected = async function* () { pulled = true; yield Uint8Array.of(0); };
      // When requesting a fourth retained page; then admission fails before consumption.
      await expect(stream.ingest({ source: unexpected(), cancel() {}, grammar })).rejects.toMatchObject({ code: 'source_unavailable' });
      expect(pulled).toBe(false);
    } finally { await stream.close(); }
  });
  it('cancels a held source and awaits cleanup when close races ingest', async () => {
    // Given a source paused after an incomplete native value.
    const { stream, globalDisk } = fixture();
    let release: () => void = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    let started: () => void = () => {};
    const ready = new Promise<void>(resolve => { started = resolve; });
    async function* pending() { yield new TextEncoder().encode('{"items":['); started(); await held; yield new TextEncoder().encode('],"ok":true}'); }
    const ingest = stream.ingest({ source: pending(), cancel: release, grammar });
    const rejected = expect(ingest).rejects.toMatchObject({ code: 'cancelled' });
    await ready;
    // When close invalidates and cancels the owner; then no late source can publish.
    await stream.close(); await rejected;
    expect(stream.usage()).toMatchObject({ pages: 0, staging: 0, fileHandles: 0, pendingWrites: 0 });
    expect(globalDisk.usage()).toBe(0);
  });
  it('awaits a held real disk write before acknowledging aborted close', async () => {
    // Given a real file write held at the filesystem boundary.
    const { stream, globalDisk } = fixture();
    const controller = new AbortController();
    let release: () => void = () => {}, started: () => void = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const ready = new Promise<void>(resolve => { started = resolve; });
    let calls = 0, closed = false;
    writes.set(async () => { calls++; started(); await held; });
    const ingest = stream.ingest({ source: source(JSON.stringify({ items: [{ body: 'x'.repeat(100000), id: 'held' }], ok: true })), cancel() {}, grammar, signal: controller.signal });
    const rejection = expect(ingest).rejects.toMatchObject({ code: 'cancelled' });
    try {
      await ready;
      // When cancellation races the accepted write; then close remains pending.
      controller.abort();
      const closing = stream.close().then(() => { closed = true; });
      await Promise.resolve();
      expect(closed).toBe(false); expect(stream.usage().pendingWrites).toBe(1); expect(globalDisk.usage()).toBeGreaterThan(0);
      release(); await closing; await rejection;
      expect(calls).toBe(1); expect(closed).toBe(true);
      expect(stream.usage()).toMatchObject({ fileHandles: 0, pendingWrites: 0, staging: 0, pages: 0 });
      expect(globalDisk.usage()).toBe(0);
    } finally { release(); writes.set(undefined); await stream.close(); }
  });
  it('removes unpublished output after an ENOSPC write failure', async () => {
    // Given a native filesystem failure injected before its real write.
    const { stream, directory, globalDisk } = fixture();
    writes.set(async () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
    try {
      // When a page flush fails; then source content is never published and the owned file is removed.
      await expect(stream.ingest({ source: source('{"items":[],"ok":true}'), cancel() {}, grammar })).rejects.toMatchObject({ code: 'ENOSPC' });
      expect(await readdir(directory)).toEqual([]);
      expect(stream.usage()).toMatchObject({ pages: 0, staging: 0, fileHandles: 0, pendingWrites: 0 });
      expect(globalDisk.usage()).toBe(0);
    } finally { writes.set(undefined); await stream.close(); }
  });
  it('reserves shared quota before either of two producers pulls and rejects the third', async () => {
    // Given two pending sources occupying the shared disk budget.
    const budget = createHistoryDiskBudget(2048), first = fixture(budget), second = fixture(budget), third = fixture(budget);
    let release: () => void = () => {};
    const held = new Promise<void>(resolve => { release = resolve; });
    const pending = async function* () { await held; yield new TextEncoder().encode('{"items":[],"ok":true}'); };
    const one = first.stream.ingest({ source: pending(), cancel: release, grammar, maxBytes: 1024 });
    const two = second.stream.ingest({ source: pending(), cancel: release, grammar, maxBytes: 1024 });
    const rejectedOne = expect(one).rejects.toMatchObject({ code: 'cancelled' });
    const rejectedTwo = expect(two).rejects.toMatchObject({ code: 'cancelled' });
    try {
      // When another producer asks for admission; then it cannot consume source data.
      expect(budget.usage()).toBe(2048);
      await expect(third.stream.ingest({ source: pending(), cancel: release, grammar, maxBytes: 1024 })).rejects.toMatchObject({ code: 'source_unavailable' });
    } finally { await Promise.all([first.stream.close(), second.stream.close(), third.stream.close()]); await rejectedOne; await rejectedTwo; }
    expect(budget.usage()).toBe(0);
  });
  it('keeps output leases charged through close and refuses stale descriptors', async () => {
    // Given an externally held output from a published native page.
    const { stream } = fixture();
    const page = await stream.ingest({ source: source('{"items":[],"ok":true}'), cancel() {}, grammar });
    const chunk = await stream.read({ pageId: page.id, descriptorId: page.document.id, offset: 0 });
    // When the producer closes; then the held bytes remain accounted until explicit release.
    await stream.close();
    expect(stream.usage().outputs).toBe(1); expect(stream.usage().memoryBytes).toBeGreaterThan(0);
    await expect(stream.read({ pageId: page.id, descriptorId: page.document.id, offset: 0 })).rejects.toMatchObject({ code: 'cancelled' });
    chunk.release(); chunk.release(); expect(stream.usage().memoryBytes).toBe(0);
  });
});
describe('platform-aware owned spool directory', () => {
  it('accepts the Windows synthesised writable mode and spools the first page', async () => {
    // Given the win32 platform where lstat synthesises mode 0666 instead of the POSIX 0700.
    const { stream, globalDisk } = fixture(undefined, 'win32');
    synthesizedMode.set(0o666);
    try {
      // When the first history page is ingested; then the owned spool is accepted.
      const page = await stream.ingest({ source: source('{"items":[],"ok":true}'), cancel() {}, grammar });
      expect(page.document.totalBytes).toBeGreaterThan(0);
      expect(globalDisk.usage()).toBeGreaterThan(0);
    } finally { synthesizedMode.set(undefined); await stream.close(); }
    expect(globalDisk.usage()).toBe(0);
  });
  it('rejects a Windows synthesised read-only directory', async () => {
    // Given the win32 platform where lstat synthesises the read-only mode 0444.
    const { stream, directory } = fixture(undefined, 'win32');
    synthesizedMode.set(0o444);
    try {
      // When a page is ingested; then the non-writable owned directory is refused.
      await expect(stream.ingest({ source: source('{"items":[],"ok":true}'), cancel() {}, grammar })).rejects.toMatchObject({ code: 'unauthorized' });
    } finally { synthesizedMode.set(undefined); await stream.close(); }
    await rmdir(directory);
  });
  it('rejects a POSIX spool root whose mode is not 0700', async () => {
    // Given a real directory widened beyond the owner-only mode.
    const directory = join(tmpdir(), `vis-history-substrate-${randomUUID()}`);
    await mkdir(directory, { mode: 0o700 }); await chmod(directory, 0o755);
    const stream = createHistoryStream({ scope: 'profile/session/generation', globalDisk: createHistoryDiskBudget(), createDirectory: async () => directory });
    try {
      // When a page is ingested; then the non-private POSIX directory is refused.
      await expect(stream.ingest({ source: source('{"items":[],"ok":true}'), cancel() {}, grammar })).rejects.toMatchObject({ code: 'unauthorized' });
    } finally { await stream.close(); }
    await rmdir(directory);
  });
});

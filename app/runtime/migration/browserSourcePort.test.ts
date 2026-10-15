// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { LegacyPiece } from '../../../shared/runtime/migration/legacyExport.js';
import { DraftDigest, DraftStorageError } from './draftChunks';
import type { DraftHeader, DraftIdentity, DraftPart, DraftStore, InlineDraft } from '../draftStore';

// Task 24 fix (PR #182 round e0f83b871 item 4):
// `createBrowserLegacySourcePort` reassembled legacy chunks but emitted
// `checksum: ''` while also rewriting the original namespace/authority/offset.
// `archiveLegacySource` verifies `legacyDigest(chunk.content) === chunk.checksum`,
// so any non-empty source was rejected as `corrupt` and no backup chunk landed.
// These tests pin the corrected behaviour: the adapter is a faithful paged
// projection of the source's own export protocol.

const HEX32 = 'a'.repeat(32);
const environmentId = '11111111-1111-4111-8111-111111111111';

// A legitimate, non-empty legacy history record split across two paged pieces.
// Both pieces share a sourceKey (same source + key), so the record reassembles
// with a byte offset of 0 for the first piece and 15 for the second.
async function* twoPieceHistory(): AsyncGenerator<LegacyPiece> {
  const key = `opencode.state.backendHistory.v1.${HEX32}.${encodeURIComponent('session-0001')}`;
  const base = { key, source: 'browser:scope/opencode.backendHistory/histories', namespace: `backend-history-v1:${HEX32}`, authority: 'indexeddb' } as const;
  yield { ...base, content: 'legacy-first-half-', end: false };
  yield { ...base, content: 'legacy-second-half', end: true };
}

type MemoryStore = {
  chunksWritten: number;
  retry(): Promise<void>;
  checkpoint(key: string, value: unknown): Promise<void>;
  readCheckpoint(key: string): Promise<unknown>;
  writeChunk(identity: DraftIdentity, part: { name: string; kind: DraftPart['kind']; index: number; bytes: Uint8Array }): Promise<void>;
  commit(header: DraftHeader): Promise<void>;
  page(options?: { after?: string; limit?: number }): Promise<{ headers: readonly DraftHeader[]; next: string | null }>;
};

// Controlled persistence double: an in-memory stand-in for `DraftStore` that
// records how many backup chunks the archive actually writes. It never touches
// a browser IndexedDB so the test is deterministic under happy-dom.
function createMemoryStore(onWriteChunk: () => void): MemoryStore {
  const checkpoints = new Map<string, unknown>();
  const headers = new Map<string, DraftHeader>();
  const chunks = new Map<string, Uint8Array>();
  const identityKey = (identity: DraftIdentity) => JSON.stringify([identity.context, identity.clientOrigin, identity.revision]);
  const partKey = (identity: DraftIdentity, name: string, index: number) => JSON.stringify([identityKey(identity), name, index]);
  const store: MemoryStore = {
    chunksWritten: 0,
    async retry() { /* no-op */ },
    async checkpoint(key, value) { checkpoints.set(key, structuredClone(value)); },
    async readCheckpoint(key) { return checkpoints.has(key) ? structuredClone(checkpoints.get(key)) : undefined; },
    async writeChunk(identity, part) {
      onWriteChunk();
      chunks.set(partKey(identity, part.name, part.index), part.bytes.slice());
      store.chunksWritten += 1;
    },
    async commit(header) { headers.set(identityKey(header), structuredClone(header)); },
    async page(options = {}) {
      const limit = options.limit ?? 100;
      const ordered = [...headers.keys()].sort();
      const filtered = options.after === undefined ? ordered : ordered.filter((key) => key > options.after!);
      const slice = filtered.slice(0, limit);
      const pageHeaders = slice.map((key) => structuredClone(headers.get(key) as DraftHeader));
      return { headers: pageHeaders, next: slice.length === limit ? slice[slice.length - 1] : null };
    },
  };
  return store;
}

describe('browser legacy source port', () => {
  it('preserves the source checksum, namespace, authority and offsets verbatim', async () => {
    // Given a real paged export of a two-piece IndexedDB history record.
    const { openLegacyExport, readLegacyExportPage } = await import('../migration/legacyExport');
    const { createBrowserLegacySourcePort } = await import('./browserSourcePort');
    const token = await openLegacyExport(twoPieceHistory);
    const expected = await readLegacyExportPage(twoPieceHistory, { token, limit: 200 });
    // When the adapter projects the same source through its port.
    const port = createBrowserLegacySourcePort(twoPieceHistory);
    await port.open();
    const actual = await port.page({ token, limit: 8 });
    // Then every chunk is the source's own chunk, not a rewritten surrogate.
    expect(actual.revision).toBe(expected.revision);
    expect(actual.chunks).toEqual(expected.chunks);
    expect(actual.chunks.every((chunk) => /^[a-f0-9]{64}$/u.test(chunk.checksum))).toBe(true);
    expect(actual.next).toBeNull();
  });

  it('completes backup for a legitimate non-empty source through coordinator and writerFreeze', async () => {
    vi.resetModules();
    const freeze = await import('./writerFreeze');
    const { createImportCoordinator } = await import('./importCoordinator');
    const { createBrowserLegacySourcePort } = await import('./browserSourcePort');

    // Given a real adapter over the legitimate two-piece legacy source.
    const port = createBrowserLegacySourcePort(twoPieceHistory);
    let phaseDuringFirstWrite: string | null = null;
    const store = createMemoryStore(() => { phaseDuringFirstWrite ??= freeze.legacyWriterPhase(); });
    const target = {
      environmentId,
      service: {
        accept: async (): Promise<never> => { throw new Error('unexpected accept'); },
        verify: async (): Promise<never> => { throw new Error('unexpected verify'); },
      },
    };
    const coordinator = createImportCoordinator({
      source: port, local: store as unknown as DraftStore, target,
      currentEnvironment: () => environmentId, mappings: [], clientOrigin: 'client-test',
    });

    // When the coordinator freezes writers and runs the staged backup.
    let result: Awaited<ReturnType<typeof coordinator.run>> | null = null;
    let failure: unknown = null;
    try { result = await coordinator.run(); } catch (error) { failure = error; }
    const code = failure instanceof Error ? ((failure as { code?: string }).code ?? failure.name) : null;

    // Then the source completes with real backup chunk writes at a frozen phase.
    expect(store.chunksWritten, `coordinator run failure=${code}`).toBeGreaterThan(0);
    expect(failure).toBeNull();
    expect(result?.records).toBe(1);
    expect(result?.chunks).toBe(2);
    expect(phaseDuringFirstWrite).toBe('frozen');
    expect(freeze.legacyEditingPaused()).toBe(true);
  });
});

// ── Task 24 binding defect (FIX.task24-describeBinding) ───────────────────────────────────────
//
// The registered QA case seeds ONE legacy corpus into the page's REAL storage:
//   * a composer draft under `opencode.drafts.composer.v1`,
//   * one local credential key the export must exclude as local-only,
//   * the SAME native session id stored twice — once in localStorage and once in
//     IndexedDB, both under `backend-history-v1:<scope>`.
// Every reader of that corpus is real landed code, so the binding hint the port
// emits is the ONE thing standing between the archive and the target: the REAL
// `bindLegacySource` matches a proven mapping on `scopeFingerprint` AND
// `nativeSessionId`, and the REAL `importLegacyDrafts` only imports a record
// whose hint kind is `composer` or `question`.
//
// A hint that drops `nativeSessionId` (or that calls a composer key `local`)
// therefore produces drafts 0 / boundRecords 0 / boundChunks 0 / accept 0 while
// still reporting a successful cutover — the loss is silent. These tests pin the
// REAL contract instead of the QA case's expected numbers.

const FIXTURE_SCOPE_HEX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const FIXTURE_SESSION_ID = 'session-0001';
const FIXTURE_COMPOSER_KEY = 'opencode.drafts.composer.v1';
const FIXTURE_COMPOSER_VALUE = '{"draft-1":{"messageInput":"legacy composer draft carried into the single entry","attachments":[]}}';
const FIXTURE_CREDENTIAL_KEY = 'opencode.credentials.v1';
const FIXTURE_CREDENTIAL_VALUE = '{"token":"legacy-local-credential-never-exported"}';
const FIXTURE_HISTORY_KEY = `opencode.state.backendHistory.v1.${FIXTURE_SCOPE_HEX}.${encodeURIComponent(FIXTURE_SESSION_ID)}`;
const FIXTURE_HISTORY_VALUE = 'legacy backend history record for the shared native session id';
const FIXTURE_INDEXED_VALUE = 'legacy backend history record persisted in IndexedDB';

// The case-owned legacy corpus, in the order the REAL browser source yields it:
// sorted localStorage keys first, then the IndexedDB store rows.
async function* fixtureLegacySource(): AsyncGenerator<LegacyPiece> {
  const origin = 'browser:fixture-origin';
  const localStorageSource = `${origin}/localStorage`;
  const indexedSource = `${origin}/opencode.backendHistory/histories`;
  const namespace = `backend-history-v1:${FIXTURE_SCOPE_HEX}`;
  yield { key: FIXTURE_COMPOSER_KEY, source: localStorageSource, namespace: 'unattached-legacy-local', authority: 'unattached', content: FIXTURE_COMPOSER_VALUE, end: true };
  yield { key: FIXTURE_CREDENTIAL_KEY, source: localStorageSource, namespace: 'unattached-legacy-local', authority: 'unattached', content: FIXTURE_CREDENTIAL_VALUE, end: true };
  yield { key: FIXTURE_HISTORY_KEY, source: localStorageSource, namespace, authority: 'unattached', content: FIXTURE_HISTORY_VALUE, end: true };
  yield { key: FIXTURE_HISTORY_KEY, source: indexedSource, namespace, authority: 'indexeddb', content: FIXTURE_INDEXED_VALUE, end: true };
}

// A fuller DraftStore double: the coordinator's target loop reads the archived
// parts back, and `importLegacyDrafts` writes inline drafts. It still never
// touches a real IndexedDB, so the test stays deterministic under happy-dom.
function createArchiveMemoryStore(): DraftStore {
  const checkpoints = new Map<string, unknown>();
  const headers = new Map<string, DraftHeader>();
  const chunks = new Map<string, Uint8Array>();
  const identityKey = (identity: DraftIdentity) => JSON.stringify([identity.context, identity.clientOrigin, identity.revision]);
  const partKey = (identity: DraftIdentity, name: string, index: number) => JSON.stringify([identityKey(identity), name, index]);
  const store = {
    paused: false,
    pendingCount: 0,
    async retry() { /* no-op */ },
    async commitInline(identity: DraftIdentity, input: readonly Readonly<{ name: string; kind: DraftPart['kind']; bytes: Uint8Array }>[]): Promise<DraftHeader> {
      const parts: DraftPart[] = [];
      for (const part of input) {
        const digest = new DraftDigest(); digest.update(part.bytes);
        chunks.set(partKey(identity, part.name, 0), part.bytes.slice());
        parts.push({ name: part.name, kind: part.kind, bytes: part.bytes.length, chunks: 1, sha256: digest.finish() });
      }
      const header = parseMemoryHeader({ ...identity, parts });
      headers.set(identityKey(header), structuredClone(header));
      return header;
    },
    async commitInlineBatch(entries: readonly InlineDraft[]): Promise<readonly DraftHeader[]> {
      const committed: DraftHeader[] = [];
      for (const entry of entries) {
        if (entry.checkpoint) checkpoints.set(entry.checkpoint.key, structuredClone(entry.checkpoint.value));
        committed.push(await this.commitInline(entry.identity, entry.parts));
      }
      return committed;
    },
    async checkpoint(key: string, value: unknown): Promise<void> { checkpoints.set(key, structuredClone(value)); },
    async readCheckpoint(key: string): Promise<unknown> { return checkpoints.has(key) ? structuredClone(checkpoints.get(key)) : undefined; },
    async readCheckpoints(keys: readonly string[]): Promise<readonly unknown[]> { return keys.map(key => (checkpoints.has(key) ? structuredClone(checkpoints.get(key)) : undefined)); },
    async writeChunk(identity: DraftIdentity, part: Readonly<{ name: string; kind: DraftPart['kind']; index: number; bytes: Uint8Array }>): Promise<void> { chunks.set(partKey(identity, part.name, part.index), part.bytes.slice()); },
    async writePart(identity: DraftIdentity, part: Readonly<{ name: string; kind: DraftPart['kind']; input: AsyncIterable<Uint8Array> }>): Promise<DraftPart> {
      const digest = new DraftDigest(); let bytes = 0; let count = 0;
      for await (const input of part.input) { chunks.set(partKey(identity, part.name, count), input.slice()); digest.update(input); bytes += input.length; count += 1; }
      return { name: part.name, kind: part.kind, bytes, chunks: count, sha256: digest.finish() };
    },
    async commit(header: DraftHeader): Promise<void> { headers.set(identityKey(header), structuredClone(header)); },
    async header(identity: DraftIdentity): Promise<DraftHeader | undefined> {
      const found = headers.get(identityKey(identity));
      return found === undefined ? undefined : structuredClone(found);
    },
    async page(options: Readonly<{ after?: string; limit?: number }> = {}) {
      const limit = options.limit ?? 100;
      const ordered = [...headers.keys()].sort();
      const filtered = options.after === undefined ? ordered : ordered.filter((key) => key > options.after!);
      const slice = filtered.slice(0, limit);
      const pageHeaders = slice.map((key) => structuredClone(headers.get(key) as DraftHeader));
      return { headers: pageHeaders, next: slice.length === limit ? slice[slice.length - 1] : null };
    },
    async *readPart(identity: DraftIdentity, part: DraftPart): AsyncGenerator<Uint8Array> {
      for (let index = 0; index < part.chunks; index++) {
        const bytes = chunks.get(partKey(identity, part.name, index));
        if (!bytes) throw new DraftStorageError('corrupt');
        yield bytes;
      }
    },
    close(): void { /* no-op */ },
  };
  return store as unknown as DraftStore;
}
function parseMemoryHeader(value: unknown): DraftHeader {
  const header = value as DraftHeader;
  if (!header.parts.every(part => /^[a-f0-9]{64}$/u.test(part.sha256))) throw new DraftStorageError('corrupt');
  return header;
}

describe('browser legacy source port binding hints', () => {
  it('describes every legacy key by what it actually is, carrying the native session id', async () => {
    // Given the REAL adapter over the case-owned legacy corpus.
    const { createBrowserLegacySourcePort } = await import('./browserSourcePort');
    const port = createBrowserLegacySourcePort(fixtureLegacySource);
    const token = await port.open();
    const sourceKeys: string[] = [];
    let request: { token: typeof token } | null = { token };
    while (request) {
      const page = await port.page({ token: request.token, limit: 200 });
      for (const chunk of page.chunks) if (!sourceKeys.includes(chunk.sourceKey)) sourceKeys.push(chunk.sourceKey);
      request = page.next === null ? null : { token: page.next };
    }
    expect(sourceKeys).toHaveLength(3);

    // When the REAL port resolves the binding hint for each exported source key.
    const hints = await Promise.all(sourceKeys.map(async (sourceKey) => ({ sourceKey, hint: await port.binding(sourceKey) })));

    // Then the hint identifies the composer draft as a composer draft ...
    const composer = hints.find((entry) => entry.hint.kind === 'composer');
    expect(composer, `no composer hint in ${JSON.stringify(hints)}`).toBeDefined();
    // ... and every backend-history source is described as history WITH its native session id,
    // so the REAL binder can match it against a proven mapping.
    const history = hints.filter((entry) => entry.hint.kind === 'history');
    expect(history).toHaveLength(2);
    for (const entry of history) {
      expect(entry.hint.nativeSessionId, `history hint ${entry.sourceKey} dropped its native session id`).toBe(FIXTURE_SESSION_ID);
      expect(entry.hint.scopeFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    }
  });

  it('routes the composer draft and the bound history records to the target through the REAL coordinator', async () => {
    vi.resetModules();
    const { createImportCoordinator } = await import('./importCoordinator');
    const { createBrowserLegacySourcePort } = await import('./browserSourcePort');
    const { legacyDigest } = await import('./legacyExport');

    // Given one proven mapping for the shared native session id (the wizard row bind).
    const mappings = [{
      profileId: 'profile-1', environmentId, harnessInstanceId: 'harness-1',
      nativeSessionId: FIXTURE_SESSION_ID,
      scopeFingerprint: await legacyDigest(`backend-history-v1:${FIXTURE_SCOPE_HEX}`),
      evidence: 'user-confirmed' as const,
    }];
    const store = createArchiveMemoryStore();
    const accepted: Readonly<{ total: number; chunks: readonly Readonly<{ authority: string; end: boolean; binding: unknown }>[] }>[] = [];
    const verified: Readonly<{ expectedRecords: number; expectedChunks: number }>[] = [];
    const target = {
      environmentId,
      service: {
        accept: async (batch: never) => { accepted.push(JSON.parse(JSON.stringify(batch))); return { phase: 'durable-accepted' as const, intentId: 'migration', revision: 0, watermark: 0 }; },
        verify: async (request: never) => { verified.push(JSON.parse(JSON.stringify(request))); return { phase: 'durable-accepted' as const, intentId: 'migration', revision: 0, watermark: 0 }; },
      },
    };
    const coordinator = createImportCoordinator({
      source: createBrowserLegacySourcePort(fixtureLegacySource), local: store, target,
      currentEnvironment: () => environmentId, mappings, clientOrigin: 'client-test',
    });

    // When the REAL coordinator runs the staged migration.
    const result = await coordinator.run();

    // Then the composer draft is imported (its hint kind is `composer`).
    expect(result.drafts).toBe(1);
    // Then both backend-history records are bound and routed. They are the SAME
    // native session id carried by two different authorities, and the REAL
    // `bindLegacySource` matches a proven mapping on `scopeFingerprint` AND
    // `nativeSessionId` — never on the source key — so one proven target
    // receives both, and the archive counts them as bound.
    expect(result.records).toBe(3);
    expect(result.chunks).toBe(3);
    expect(result.boundRecords).toBe(2);
    expect(result.localOnlyRecords).toBe(1);
    expect(accepted).toHaveLength(1);
    expect(verified).toHaveLength(1);
    expect(verified[0]).toEqual({ importId: result.importId, sourceRevision: result.sourceRevision, expectedRecords: 2, expectedChunks: 2 });
    const batch = accepted[0];
    expect(batch.total).toBe(2);
    expect(batch.chunks.map((chunk) => chunk.end)).toEqual([true, true]);
    expect(batch.chunks.map((chunk) => chunk.authority).sort()).toEqual(['indexeddb', 'unattached']);
    for (const chunk of batch.chunks) {
      expect(chunk.binding).toEqual({ environmentId, harnessInstanceId: 'harness-1', nativeSessionId: FIXTURE_SESSION_ID, profileId: 'profile-1' });
    }
  });
});

import { DraftStore } from '../../app/runtime/draftStore.ts';
import { PinStore } from '../../app/runtime/pinStore.ts';
import { DraftDigest } from '../../app/runtime/migration/draftChunks.ts';
import { encodeSessionKey } from '../../shared/runtime/identity.js';
import { createQualifiedComposerDrafts } from '../../app/runtime/qualifiedComposerDrafts.ts';

const sources = ['opencode', 'codex', 'acp', 'kimi-web', 'dsh'];
const encoder = new TextEncoder();
export async function inspectSettingsCutover() {
  const store = await DraftStore.open();
  try {
    let after; let pendingHeaders = 0; let headers = 0;
    do {
      const page = await store.page({ after, limit: 100 });
      headers += page.headers.length;
      pendingHeaders += page.headers.filter(header => header.context.startsWith('pending:')).length;
      after = page.next ?? undefined;
    } while (after);
    return { migration: await store.readCheckpoint('migration-active'), headers, pendingHeaders };
  } finally { store.close(); }
}
const character = (ordinal) => 65 + ordinal % 26;
function selection(args, ordinal) {
  return { profileId: args.profileId, session: { environmentId: args.environmentId, harnessInstanceId: args.harnesses[sources[ordinal % 5]], nativeSessionId: `native-${Math.floor(ordinal / 5)}` } };
}
function identity(args, ordinal) {
  const selected = selection(args, ordinal);
  return { context: `${selected.profileId}:${encodeSessionKey(selected.session)}`, clientOrigin: location.origin, revision: 1 };
}
async function verify(store, header) {
  const parts = [];
  for (const part of header.parts) {
    const digest = new DraftDigest();
    let bytes = 0, largest = 0;
    for await (const chunk of store.readPart(header, part)) { digest.update(chunk); bytes += chunk.length; largest = Math.max(largest, chunk.length); }
    parts.push({ ...part, readHash: digest.finish(), readBytes: bytes, largest });
  }
  return { context: header.context, parts };
}
async function generatedPart(store, address, name, kind, size, ordinal) {
  async function* chunks() {
    for (let offset = 0; offset < size; offset += 65536) yield new Uint8Array(Math.min(65536, size - offset)).fill(character(ordinal));
  }
  return store.writePart(address, { name, kind, input: chunks() });
}
export async function seedBatch(args) {
  const store = await DraftStore.open();
  const pins = await PinStore.open();
  const ledger = [];
  try {
    for (let ordinal = args.start; ordinal < args.start + args.count; ordinal++) {
      const address = identity(args, ordinal);
      const body = new Uint8Array(2048).fill(character(ordinal));
      const draft = { messageInput: String.fromCharCode(character(ordinal)).repeat(2048), attachments: [], agent: '', model: '', updatedAt: 1791158400000, rev: 1, writerTabId: 'seed090' };
      let header;
      if (ordinal % 100 === 0) {
        const parts = [
          await store.writePart(address, { name: 'body', kind: 'body', input: (async function* () { yield body; })() }),
          await generatedPart(store, address, 'attachment', 'attachment', 1048576, ordinal),
          await store.writePart(address, { name: 'raw', kind: 'raw', input: (async function* () { yield encoder.encode(JSON.stringify(draft)); })() }),
        ];
        header = { ...address, parts };
        await store.commit(header);
        await store.checkpoint(`composer-active:${address.context}`, address);
      } else {
        [header] = await store.commitInlineBatch([{ identity: address, parts: [{ name: 'body', kind: 'body', bytes: body }, { name: 'raw', kind: 'raw', bytes: encoder.encode(JSON.stringify(draft)) }], checkpoint: { key: `composer-active:${address.context}`, value: address } }]);
      }
      await pins.set({ selection: selection(args, ordinal), clientOrigin: location.origin, revision: 1, pinned: true });
      ledger.push({ ordinal, ...await verify(store, header) });
    }
    return { ledger, draftStorageState: { pendingCount: store.pendingCount, paused: store.paused }, pinUsage: pins.usage() };
  } finally { store.close(); pins.close(); }
}
export async function seedThreadComposer(args) {
  const store = await DraftStore.open();
  try {
    if (await store.readCheckpoint('migration-active')) throw new Error('Use a fresh owned QA browser for this target-store fixture.');
    const selections = sources.map(kind => ({ kind, nativeSessionId: 'native-1002' }));
    selections.push({ kind: 'codex', nativeSessionId: 'native-1003' });
    const entries = [];
    for (const item of selections) {
      const session = { environmentId: args.environmentId, harnessInstanceId: args.harnesses[item.kind], nativeSessionId: item.nativeSessionId };
      const context = `${args.profileId}:${encodeSessionKey(session)}`;
      if (await store.readCheckpoint(`composer-active:${context}`)) throw new Error('Refusing to replace an existing QA draft.');
      const messageInput = `QA-QUALIFIED-PRIVATE-${item.kind}-${item.nativeSessionId}`;
      const draft = { messageInput, attachments: [], agent: item.kind === 'codex' ? 'default' : item.kind === 'opencode' ? 'build' : '', model: item.kind === 'codex' ? 'codex/seed-codex-model' : '', variant: item.kind === 'codex' ? item.nativeSessionId === 'native-1003' ? 'high' : 'low' : '', updatedAt: Date.now(), rev: 1, writerTabId: 'controlled-qualified-qa' };
      const address = { context, clientOrigin: location.origin, revision: 1 };
      entries.push({ identity: address, parts: [{ name: 'body', kind: 'body', bytes: encoder.encode(messageInput) }, { name: 'raw', kind: 'raw', bytes: encoder.encode(JSON.stringify(draft)) }], checkpoint: { key: `composer-active:${context}`, value: address } });
    }
    const headers = await store.commitInlineBatch(entries);
    await store.checkpoint('migration-active', { phase: 'cutover', environmentId: args.environmentId, importId: 'controlled-qualified-thread-fixture', sourceRevision: 'target-store-fixture-not-legacy-migration' });
    return { fixture: 'controlled target store; not a legacy migration acceptance', headers, storageState: { paused: store.paused, pendingCount: store.pendingCount } };
  } finally { store.close(); }
}
export async function seedLarge(args) {
  const store = await DraftStore.open();
  try {
    const owner = args.ownerContext
      ? { context: args.ownerContext, clientOrigin: location.origin, revision: 1 }
      : identity(args, args.ownerOrdinal ?? 5);
    const address = { context: `unattached:seed090:large:${args.count}`, clientOrigin: location.origin, revision: 1 };
    const parts = [
      await generatedPart(store, address, 'body', 'body', 16777216, args.count),
      await generatedPart(store, address, 'attachment', 'attachment', 67108864, args.count),
    ];
    const header = { ...address, parts };
    await store.commit(header);
    await store.checkpoint(`composer-active:${owner.context}`, { ...address, ownerContext: owner.context });
    await store.checkpoint('migration-active', { phase: 'cutover', environmentId: args.environmentId, importId: 'seed090-qualified-performance', sourceRevision: '090' });
    return { owner, header, ...await verify(store, header), storageState: { pendingCount: store.pendingCount, paused: store.paused } };
  } finally { store.close(); }
}
export async function seedSegmented(args) {
  const store = await DraftStore.open();
  try {
    const owner = identity(args, args.ordinal ?? 5065);
    const address = { context: `unattached:qa-segmented:${crypto.randomUUID()}`, clientOrigin: location.origin, revision: 1 };
    const parts = [await generatedPart(store, address, 'body', 'body', 131072, 10000), await generatedPart(store, address, 'attachment', 'attachment', 4096, 10001)];
    const header = { ...address, parts };
    await store.commit(header);
    await store.checkpoint(`composer-active:${owner.context}`, { ...address, ownerContext: owner.context });
    return { owner, header };
  } finally { store.close(); }
}
export async function verifyPage(args = {}) {
  const store = await DraftStore.open();
  try {
    const page = await store.page({ limit: 100, ...(args.after ? { after: args.after } : {}) });
    const ledger = [];
    for (const header of page.headers) ledger.push(await verify(store, header));
    return { ledger, next: page.next, storageState: { pendingCount: store.pendingCount, paused: store.paused } };
  } finally { store.close(); }
}
export async function verifyOwner(context) {
  const store = await DraftStore.open();
  try {
    const pointer = await store.readCheckpoint(`composer-active:${context}`);
    const header = await store.header(pointer);
    if (!header) throw new Error('Owned draft header missing');
    return { pointer, ...await verify(store, header), storageState: { pendingCount: store.pendingCount, paused: store.paused } };
  } finally { store.close(); }
}
export async function inspectPins(args) {
  const store = await PinStore.open();
  try {
    const page = await store.page({ profileId: args.profileId, limit: 100, ...(args.after ? { after: args.after } : {}) });
    const result = { records: page.records.map((entry) => ({ session: entry.selection.session, pinned: entry.pinned, revision: entry.revision })), next: page.next, usage: store.usage() };
    page.release();
    return result;
  } finally { store.close(); }
}
export function installExportProbe() {
  const original = window.showSaveFilePicker;
  window.__visDraftExports = [];
  window.showSaveFilePicker = async ({ suggestedName }) => ({ async createWritable() {
    const digest = new DraftDigest();
    const result = { name: suggestedName, state: 'writing', bytes: 0, largest: 0 };
    window.__visDraftExports.push(result);
    return {
      async write(bytes) { digest.update(bytes); result.bytes += bytes.length; result.largest = Math.max(result.largest, bytes.length); },
      async close() { result.sha256 = digest.finish(); result.state = 'complete'; },
      async abort() { result.state = 'aborted'; },
    };
  } });
  window.__visRestoreDraftPicker = () => { window.showSaveFilePicker = original; };
  return { boundary: 'Controlled file-picker sink; actual production export handler and chunked IndexedDB data', nativePickerAvailable: typeof original === 'function' };
}
export async function raceComposerPointers() {
  const firstStore = await DraftStore.open(), secondStore = await DraftStore.open();
  const first = createQualifiedComposerDrafts(firstStore, location.origin), second = createQualifiedComposerDrafts(secondStore, location.origin);
  const context = `unattached:qa-pointer-race:${crypto.randomUUID()}`;
  try {
    await first.write(context, 1, { messageInput: 'original' });
    await first.open(context); await second.open(context);
    await second.write(context, 3, { messageInput: 'newer durable winner' });
    let refused = false;
    try { await first.write(context, 2, { messageInput: 'stale window overwrite' }); }
    catch (error) { refused = error?.code === 'conflict'; if (!refused) throw error; }
    const pointer = await firstStore.readCheckpoint(`composer-active:${context}`);
    const winner = await second.read(context);
    await first.open(context);
    await first.write(context, 4, { messageInput: 'explicitly reloaded and merged draft' });
    const rebased = await firstStore.readCheckpoint(`composer-active:${context}`);
    return { context, refused, actualRevision: pointer?.revision, expectedRevision: 3, winnerPreserved: pointer?.revision === 3 && winner.messageInput === 'newer durable winner', explicitReloadRevision: rebased?.revision };
  } finally { firstStore.close(); secondStore.close(); }
}
export async function retryComposerAfterQuota() {
  const store = await DraftStore.open(), storage = createQualifiedComposerDrafts(store, location.origin);
  const context = `unattached:qa-pointer-quota:${crypto.randomUUID()}`;
  const transaction = IDBDatabase.prototype.transaction;
  let failed = false;
  try {
    await storage.write(context, 1, { messageInput: 'before quota' });
    IDBDatabase.prototype.transaction = function (names, mode, options) {
      if (!failed && this.name === 'vis-runtime-client' && mode === 'readwrite' && Array.from(typeof names === 'string' ? [names] : names).includes('migration')) {
        failed = true; throw new DOMException('Controlled publish quota fault', 'QuotaExceededError');
      }
      return Reflect.apply(transaction, this, [names, mode, options]);
    };
    let rejected = false;
    try { await storage.write(context, 2, { messageInput: 'saved after retry' }); }
    catch (error) { rejected = error.name === 'QuotaExceededError'; if (!rejected) throw error; }
    IDBDatabase.prototype.transaction = transaction;
    const paused = store.paused, pendingBeforeRetry = store.pendingCount;
    await storage.retry();
    await storage.write(context, 3, { messageInput: 'latest input after physical publish drained' });
    const value = await storage.read(context), pointer = await store.readCheckpoint(`composer-active:${context}`);
    return { rejected, paused, pendingBeforeRetry, pendingAfterRetry: store.pendingCount, finalRevision: pointer?.revision, text: value.messageInput };
  } finally { IDBDatabase.prototype.transaction = transaction; store.close(); }
}

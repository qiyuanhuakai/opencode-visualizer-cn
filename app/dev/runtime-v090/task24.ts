// Task 24 registered QA browser entry — the real workspace-access surfaces, mounted for real.
//
// Loaded by scripts/qa/runtime-v090-cases/task-24.mjs from a runner-served page and driven by a
// real headless Chromium. The REAL landed code executes here:
//   * app/components/runtime/ConnectionEntry.vue — the ONE single Bridge entry point: it binds a
//     connection profile to its target and names the source of every capability, so a capability
//     the target lacks (a remote external editor) is displayed as unsupported instead of offered;
//   * app/components/runtime/MigrationWizard.vue — legacy data is browsed, bound and migrated
//     with an explicit retry path, and the original is retained while a cutover is unverified;
//   * app/runtime/migration/{legacyBrowserSource,browserSourcePort,importCoordinator,sourceArchive,
//     draftImport,writerFreeze,legacyBinding,legacyExport} and app/runtime/draftStore.ts — the REAL
//     legacy export/import pipeline, run over the page's REAL localStorage and REAL IndexedDB;
//   * app/composables/useWorkspaceCapability.ts — the REAL locality decision that refuses a
//     local-only workspace action on a remote bridge endpoint;
//   * app/composables/useRuntimeCapabilities.ts — the REAL workspace-control routing (every
//     workspace action resolves through the workspace channel and the task-4 service mapping);
//   * app/composables/useDesktopBridgeVersion.ts — the REAL bridge-version report path, where a
//     managed remote host is remote even when its endpoint is a loopback URL;
//   * app/utils/legacyDigest.ts — the REAL synchronous renderer digest, compared byte-for-byte
//     against Node's createHash('sha256') oracle supplied by the case.
//
// The controlled boundaries (injected fakes), and ONLY these:
//   * the legacy fixture data written into the page's real localStorage / real IndexedDB (the
//     case's own data — every module that reads it is real landed code);
//   * the import target service (`accept` / `verify`) — the durable target endpoint, recorded;
//   * the durable-write boundary for the disk-full class — a store double that rejects writes,
//     used only to inject that one failure;
//   * the one-shot PTY launch recorder for the open-in-editor path (the browser has no OS PTY;
//     the REAL pty service is exercised in the Node worker);
//   * the desktop API object and the bridge health `fetch` (the Electron bridge and the network
//     edge) — the real composables run against them;
//   * @iconify/vue is aliased to a case-owned inert stub (icons are decorative; every assertion
//     reads data-testid / data-* attributes or rendered text).
//
// This entry authors no PASS verdict and performs no live SSH or live Slurm verification —
// task 46 owns that end-to-end check.
import { computed, createApp, h, nextTick, effectScope, ref } from 'vue';
import { createI18n } from 'vue-i18n';

import en from '../../locales/en';
import ConnectionEntry from '../../components/runtime/ConnectionEntry.vue';
import MigrationWizard from '../../components/runtime/MigrationWizard.vue';
import type { MigrationInventory, MigrationSourceEntry } from '../../components/runtime/MigrationWizard.vue';
import type { ConnectionCapabilityEntry, ConnectionProfileEntry } from '../../components/runtime/ConnectionEntry.vue';
import { bridgeEndpointLocality, decideWorkspaceCapability } from '../../composables/useWorkspaceCapability';
import { WORKSPACE_CONTROLS, resolveControlSupport } from '../../composables/useRuntimeCapabilities';
import { BACKEND_OPERATION_OWNERS, WORKSPACE_OPERATIONS } from '../../../shared/runtime/nativeExtensions.js';
import { createBrowserLegacySource } from '../../runtime/migration/legacyBrowserSource';
import { createBrowserLegacySourcePort } from '../../runtime/migration/browserSourcePort';
import { openLegacyExport, resolveLegacyLocalBinding } from '../../runtime/migration/legacyExport';
import type { LegacyPageRequest } from '../../runtime/migration/legacyExport';
import { describeLocalBinding, bindLegacySource } from '../../runtime/migration/legacyBinding';
import type { ProvenMapping } from '../../runtime/migration/legacyBinding';
import { createImportCoordinator } from '../../runtime/migration/importCoordinator';
import { DraftStore } from '../../runtime/draftStore';
import { DraftStorageError } from '../../runtime/migration/draftChunks';
import { legacyEditingPaused, legacyWriterPhase, retryFrozenLegacyWrites } from '../../runtime/migration/writerFreeze';
import { legacyDigestSync } from '../../utils/legacyDigest';
import { useDesktopBridgeVersion } from '../../composables/useDesktopBridgeVersion';
import { OPEN_IN_EDITOR_SHELL_COMMAND } from '../../utils/openInEditorCommand';

type AnyRecord = Record<string, any>;

// ── observation channels ────────────────────────────────────────────────────────────────────
const errors: string[] = [];
window.addEventListener('error', (event) => { errors.push(`error: ${String(event.message)}`); });
window.addEventListener('unhandledrejection', (event) => {
  errors.push(`unhandledrejection: ${String((event.reason && (event.reason as AnyRecord).message) || event.reason)}`);
});

const consoleEntries: Array<{ level: string; text: string }> = [];
function safeString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try { return JSON.stringify(value); } catch { return String(value); }
}
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    try { consoleEntries.push({ level, text: args.map(safeString).join(' ') }); } catch { /* capture never throws */ }
    original(...args);
  };
}

const domHost = document.createElement('pre');
domHost.id = 'qa24-out';
domHost.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 monospace;padding:8px;';
document.body.append(domHost);

const occurrences = (haystack: string, needle: string): number => (needle.length === 0 ? 0 : String(haystack).split(needle).length - 1);
const domOccurrences = (needle: string): number => occurrences(document.body.innerText, needle);

// ── the injected import target service (the durable target endpoint) ────────────────────────
const targetCalls = { accept: 0, verify: 0 };
const acceptedBatches: AnyRecord[] = [];
const verifyRequests: AnyRecord[] = [];
let acceptFailure: (() => Error) | null = null;
const importService = {
  async accept(batch: AnyRecord) {
    targetCalls.accept += 1;
    if (acceptFailure) throw acceptFailure();
    acceptedBatches.push(JSON.parse(JSON.stringify(batch)));
    return { phase: 'durable-accepted', intentId: 'migration', revision: 0, watermark: 0 };
  },
  async verify(request: AnyRecord) {
    targetCalls.verify += 1;
    if (acceptFailure) throw acceptFailure();
    verifyRequests.push(JSON.parse(JSON.stringify(request)));
    return { phase: 'durable-accepted', intentId: 'migration', revision: 0, watermark: 0 };
  },
};

// ── the injected one-shot PTY launch recorder (the browser has no OS PTY) ──────────────────
// Mirrors the product's open-in-editor path (App.vue `handleFloatingWindowOpen`): the REAL
// locality decision is consulted first (twice, exactly as `createPtySession({localOnly:true})`
// does), and only an authorized launch hands argv to the shell boundary. The recorder captures
// the target that WOULD be handed to `/bin/sh -c … vis-open-editor <path>`.
const launches: AnyRecord[] = [];
function openInEditorViaGuard(bridgeUrl: string, absolutePath: string) {
  const handlerDecision = decideWorkspaceCapability('localShell', bridgeUrl);
  if (!handlerDecision.authorized) {
    launches.push({ launched: false, locality: handlerDecision.locality, reason: handlerDecision.reason, refusedAt: 'handler', target: absolutePath, command: null, args: null });
    return { launched: false, decision: handlerDecision };
  }
  const createDecision = decideWorkspaceCapability('localShell', bridgeUrl);
  if (!createDecision.authorized) {
    launches.push({ launched: false, locality: createDecision.locality, reason: createDecision.reason, refusedAt: 'createPtySession', target: absolutePath, command: null, args: null });
    return { launched: false, decision: createDecision };
  }
  const command = '/bin/sh';
  const args = ['-c', OPEN_IN_EDITOR_SHELL_COMMAND, 'vis-open-editor', absolutePath];
  launches.push({ launched: true, locality: createDecision.locality, reason: null, refusedAt: null, target: absolutePath, command, args });
  return { launched: true, decision: createDecision };
}

// ── the injected desktop API + network edge for the REAL bridge-version path ────────────────
const bridgeReports: AnyRecord[] = [];
const desktopApi = {
  async getState() { return {} as never; },
  async configure() { return {} as never; },
  async reportBridgeVersion(report: AnyRecord) { bridgeReports.push(JSON.parse(JSON.stringify(report))); return {} as never; },
  async check() { return {} as never; },
  async download() { return {} as never; },
  async install() { return {} as never; },
  async notify() {},
  onState() { return () => {}; },
  onNotificationClick() { return () => {}; },
};
let networkMode: 'up' | 'down' = 'up';
let healthVersion = '0.9.0';
const originalFetch = window.fetch.bind(window);
window.fetch = async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  if (url.includes('/healthz')) {
    if (networkMode === 'down') throw new TypeError('network unreachable');
    return { ok: true, json: async () => ({ version: healthVersion }) } as never;
  }
  return originalFetch(input, init);
};

// ── the real composable under an owned effect scope ─────────────────────────────────────────
const healthUrl = ref('');
const hostIdentity = ref<{ transportKind: 'local' | 'direct' | 'ssh' | 'slurm' } | undefined>({ transportKind: 'local' });
const scope = effectScope();
const bridgeVersion = scope.run(() => useDesktopBridgeVersion(healthUrl, desktopApi as never, { hostIdentity }))!;
// `bridgeVersion.state.value` is a Vue `readonly` proxy; a proxy does not survive the Playwright
// page boundary (it serializes to `{}`), so return a plain snapshot the boundary can carry.
function bridgeVersionState() {
  const state = bridgeVersion.state.value;
  return { state: state !== null && typeof state === 'object' ? { ...state } : state ?? null, upgradePath: bridgeVersion.upgradePath.value };
}

// ── reactive host state fed to the real surfaces ────────────────────────────────────────────
const client = ref<'browser' | 'electron'>('browser');
const connectionOpen = ref(false);
const migrationOpen = ref(false);
const profiles = ref<readonly ConnectionProfileEntry[]>([]);
const capabilities = ref<readonly ConnectionCapabilityEntry[]>([]);
const connectionStatus = ref<'idle' | 'connecting' | 'ready' | 'error'>('idle');
const connectionError = ref('');
const migrationStatus = ref<'idle' | 'backing-up' | 'migrating' | 'done' | 'failed'>('idle');
const migrationError = ref('');
const migrationInventory = ref<MigrationInventory>({ revision: '', sources: [] });
const migrationResult = ref<null | AnyRecord>(null);
// Mirrors App.vue's `migrationWizardBackup` (App.vue:10154): MigrationWizard renders its backup
// section only under `v-if="backup"` and has no default, so the entry must supply the real shape.
const migrationBackup = computed(() =>
  migrationStatus.value === 'idle' ? undefined : {
    records: migrationResult.value?.records ?? 0,
    chunks: migrationResult.value?.chunks ?? 0,
    boundRecords: migrationResult.value?.boundRecords ?? 0,
    boundChunks: migrationResult.value?.chunks ?? 0,
    done: migrationStatus.value === 'done',
  },
);

const bindPayloads: AnyRecord[] = [];
let migrationMappings: ProvenMapping[] = [];
let activeEnvironment = '11111111-1111-4111-8111-111111111111';
let migrationRun: Promise<AnyRecord> | null = null;
let pendingMigrationOptions: AnyRecord = {};
// The qualified identities a confirmed binding maps a source against (the app's active profile /
// environment / harness instance), and each browsed source's REAL scope fingerprint.
const bindingContext = { profileId: '55555555-5555-4555-8555-555555555555', environmentId: '11111111-1111-4111-8111-111111111111', harnessInstanceId: '33333333-3333-4333-8333-333333333333' };
const scopeFingerprints = new Map<string, string>();

const app = createApp({
  setup() {
    return () => h('div', { 'data-client': client.value, 'data-qa-surface': 'task24' }, [
      h(ConnectionEntry as never, {
        open: connectionOpen.value,
        profiles: profiles.value,
        capabilities: capabilities.value,
        status: connectionStatus.value,
        error: connectionError.value,
        onClose: () => { connectionOpen.value = false; },
        onBind: (value: AnyRecord) => { bindPayloads.push({ surface: 'connection', ...value }); },
        onRetry: () => { connectionStatus.value = 'connecting'; },
      }),
      h(MigrationWizard as never, {
        open: migrationOpen.value,
        inventory: migrationInventory.value,
        status: migrationStatus.value,
        backup: migrationBackup.value,
        result: migrationResult.value ?? undefined,
        error: migrationError.value,
        retained: migrationStatus.value === 'failed',
        onClose: () => { migrationOpen.value = false; },
        onBind: (value: AnyRecord) => {
          bindPayloads.push({ surface: 'migration', ...value });
          migrationMappings = [...migrationMappings, {
            profileId: bindingContext.profileId,
            environmentId: bindingContext.environmentId,
            harnessInstanceId: bindingContext.harnessInstanceId,
            nativeSessionId: value.nativeSessionId ?? '',
            scopeFingerprint: scopeFingerprints.get(value.sourceKey) ?? '',
            evidence: 'user-confirmed',
          }];
        },
        onStart: () => { migrationRun = runMigration(pendingMigrationOptions); },
        onRetry: () => { migrationRun = retryMigration(pendingMigrationOptions); },
      }),
    ]);
  },
});
const i18n = createI18n({ legacy: false, locale: 'en', messages: { en }, missingWarn: false, fallbackWarn: false });
app.use(i18n);
app.mount('#app');

// ── the REAL migration pipeline, driven exactly as App.vue drives it ───────────────────────
function createLegacySource() {
  return createBrowserLegacySource({ storage: window.localStorage, indexedDB: window.indexedDB, origin: window.location.origin });
}
function describeFailure(error: unknown): AnyRecord {
  if (error instanceof Error) {
    const record = error as Error & { code?: string };
    return { name: error.name, code: record.code ?? null, message: error.message };
  }
  return { name: 'Unknown', code: null, message: String(error) };
}
// A durable-write boundary that rejects writes (disk-full) or lets the active target switch
// mid-backup (wrong target). Every other call delegates to the REAL DraftStore.
function createFailingStore(real: DraftStore, options: Readonly<{ failAfter?: number; switchAfter?: number; switchTo?: string }>): DraftStore {
  let writes = 0;
  return new Proxy(real, {
    get(target, prop) {
      if (prop === 'writeChunk') {
        return async (identity: never, part: never) => {
          if (writes === options.switchAfter && options.switchTo !== undefined) activeEnvironment = options.switchTo;
          if (options.failAfter !== undefined && writes >= options.failAfter) throw new DraftStorageError('unavailable');
          writes += 1;
          return (target as AnyRecord).writeChunk(identity, part);
        };
      }
      const value = typeof prop === 'string' ? (target as AnyRecord)[prop] : undefined;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as unknown as DraftStore;
}
async function runMigration(options: Readonly<{ failStoreAfter?: number; failAccept?: boolean; switchEnvironmentAfterWrites?: number; switchEnvironmentTo?: string }> = {}): Promise<AnyRecord> {
  migrationStatus.value = 'backing-up';
  migrationError.value = '';
  migrationResult.value = null;
  acceptFailure = options.failAccept ? () => new TypeError('network unreachable') : null;
  const source = createLegacySource();
  const store = (options.failStoreAfter === undefined && options.switchEnvironmentAfterWrites === undefined)
    ? await DraftStore.open()
    : createFailingStore(await DraftStore.open(), {
      ...(options.failStoreAfter === undefined ? {} : { failAfter: options.failStoreAfter }),
      ...(options.switchEnvironmentAfterWrites === undefined ? {} : { switchAfter: options.switchEnvironmentAfterWrites, switchTo: options.switchEnvironmentTo }),
    });
  const coordinator = createImportCoordinator({
    source: createBrowserLegacySourcePort(source),
    local: store,
    target: { environmentId: activeEnvironment, service: importService as never },
    currentEnvironment: () => activeEnvironment,
    mappings: migrationMappings,
    clientOrigin: window.location.origin,
  });
  const acceptedBefore = targetCalls.accept;
  try {
    const result = await coordinator.run();
    migrationStatus.value = 'done';
    migrationResult.value = { ...result };
    return { ok: true, result, failure: null, acceptedBatches: targetCalls.accept - acceptedBefore, phase: legacyWriterPhase() };
  } catch (error) {
    migrationStatus.value = 'failed';
    migrationError.value = describeFailure(error).code ?? describeFailure(error).message;
    return { ok: false, result: null, failure: describeFailure(error), acceptedBatches: targetCalls.accept - acceptedBefore, phase: legacyWriterPhase() };
  }
}
async function retryMigration(options: Readonly<{ failStoreAfter?: number; failAccept?: boolean }> = {}): Promise<AnyRecord> {
  await retryFrozenLegacyWrites();
  return runMigration(options);
}

// ── UI-driver helpers (all reads happen against the REAL rendered DOM) ────────────────────────
function element(testId: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testId}"]`);
}
async function click(testId: string): Promise<boolean> {
  const target = element(testId) as HTMLButtonElement | null;
  if (target === null) return false;
  target.click();
  await nextTick(); await nextTick();
  return true;
}
const text = (testId: string): string | null => element(testId)?.textContent ?? null;
const disabled = (testId: string): boolean | null => {
  const node = element(testId) as HTMLButtonElement | null;
  return node === null ? null : node.disabled;
};

const api: AnyRecord = {
  ready: true,
  constants: {
    TARGET_ENVIRONMENT: '11111111-1111-4111-8111-111111111111',
    FOREIGN_ENVIRONMENT: '22222222-2222-4222-8222-222222222222',
    LOCAL_BRIDGE_URL: 'ws://127.0.0.1:23004',
    REMOTE_BRIDGE_URL: 'ws://lab.example.com:23004',
  },
  errors: () => errors,
  consoleEntries: () => consoleEntries.map((entry) => ({ ...entry })),
  domText: () => `${document.body.innerText}\n${domHost.textContent ?? ''}`,
  domOccurrences: (needle: string) => domOccurrences(needle),
  storageSnapshot: () => {
    const parts: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index) ?? '';
      parts.push(`${key}=${window.localStorage.getItem(key) ?? ''}`);
    }
    return { local: parts.join('\n'), databaseNames: [] as string[] };
  },

  configure(input: AnyRecord) {
    if (input.client !== undefined) client.value = input.client;
    return { client: client.value };
  },

  // ── ConnectionEntry ──
  setProfiles(list: AnyRecord[]) { profiles.value = Object.freeze(list.map((entry) => Object.freeze({ ...entry }))) as never; return profiles.value.length; },
  setCapabilities(list: AnyRecord[]) { capabilities.value = Object.freeze(list.map((entry) => Object.freeze({ ...entry }))) as never; return capabilities.value.length; },
  setConnectionStatus(input: AnyRecord) {
    if (input.status !== undefined) connectionStatus.value = input.status;
    if (input.error !== undefined) connectionError.value = input.error;
    return { status: connectionStatus.value, error: connectionError.value };
  },
  async openConnection() { connectionOpen.value = true; await nextTick(); await nextTick(); return connectionOpen.value; },
  selectProfileViaUi(profileId: string) {
    const rows = [...document.querySelectorAll('[data-testid="connection-profile-row"]')] as HTMLElement[];
    const row = rows.find((node) => node.getAttribute('data-profile-id') === profileId) ?? null;
    if (row !== null) row.click();
    return { clicked: row !== null, requested: profileId };
  },
  async connectViaUi() {
    const clicked = await click('connection-connect');
    await nextTick();
    return { clicked, payload: bindPayloads.filter((entry) => entry.surface === 'connection').at(-1) ?? null };
  },
  async retryConnectionViaUi() { const clicked = await click('connection-retry'); await nextTick(); return { clicked }; },

  // ── MigrationWizard + the REAL pipeline ──
  async openMigration() { migrationOpen.value = true; await nextTick(); await nextTick(); return migrationOpen.value; },
  setActiveEnvironment(environmentId: string) { activeEnvironment = environmentId; return activeEnvironment; },
  setBindingContext(input: AnyRecord) {
    if (input.profileId !== undefined) bindingContext.profileId = input.profileId;
    if (input.environmentId !== undefined) bindingContext.environmentId = input.environmentId;
    if (input.harnessInstanceId !== undefined) bindingContext.harnessInstanceId = input.harnessInstanceId;
    return { ...bindingContext };
  },
  bindingContext: () => ({ ...bindingContext }),
  scopeFingerprintOf: (sourceKey: string) => scopeFingerprints.get(sourceKey) ?? null,
  setMappings(mappings: AnyRecord[]) { migrationMappings = mappings.map((entry) => Object.freeze({ ...entry })) as never; return migrationMappings.length; },

  async seedLegacy(fixture: AnyRecord) {
    for (const entry of fixture.storage) window.localStorage.setItem(entry.key, entry.value);
    const handle: IDBDatabase = await new Promise((resolve, reject) => {
      const request = window.indexedDB.open(fixture.indexedDB.database, 1);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(fixture.indexedDB.store)) request.result.createObjectStore(fixture.indexedDB.store); };
      request.onerror = () => reject(request.error ?? new Error('indexeddb open failed'));
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = handle.transaction(fixture.indexedDB.store, 'readwrite');
      for (const row of fixture.indexedDB.rows) transaction.objectStore(fixture.indexedDB.store).put(row.value, row.key);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('indexeddb write failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('indexeddb write aborted'));
    });
    handle.close();
    return { storageKeys: fixture.storage.map((entry: AnyRecord) => entry.key), indexedDB: { database: fixture.indexedDB.database, store: fixture.indexedDB.store, rows: fixture.indexedDB.rows.length } };
  },
  async clearLegacy() {
    for (const key of Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index) ?? '')) {
      if (key.startsWith('opencode.') || key === 'vis.codex.pins.v1' || key === 'vis:kimi-web:last-permission-mode') window.localStorage.removeItem(key);
    }
    await new Promise<void>((resolve) => {
      const request = window.indexedDB.deleteDatabase('vis-runtime-client');
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
    return { cleared: true };
  },

  // The REAL export over the REAL source: the token, every chunk and every binding hint.
  async legacyInventory() {
    const source = createLegacySource();
    const token = await openLegacyExport(source);
    const port = createBrowserLegacySourcePort(source);
    const chunks: AnyRecord[] = [];
    let request: LegacyPageRequest | null = { token };
    while (request) {
      const page = await port.page(request);
      for (const chunk of page.chunks) chunks.push({ ...chunk });
      request = page.next === null ? null : { token: page.next };
    }
    const hints: AnyRecord[] = [];
    for (const chunk of chunks) {
      const resolved = await resolveLegacyLocalBinding(source, chunk.sourceKey);
      hints.push({ sourceKey: chunk.sourceKey, portHint: await port.binding(chunk.sourceKey), described: await describeLocalBinding(resolved, chunk.sourceKey) });
    }
    return { token, chunks, hints };
  },

  // Build the wizard inventory from the REAL export (bytes are the source's own bytes).
  inventoryFromExport(exported: AnyRecord) {
    const bySource = new Map<string, AnyRecord>();
    for (const chunk of exported.chunks) {
      const current = bySource.get(chunk.sourceKey) ?? { sourceKey: chunk.sourceKey, source: chunk.source, namespace: chunk.namespace, authority: chunk.authority, bytes: 0, pieces: 0 };
      current.bytes += new TextEncoder().encode(chunk.content).length;
      current.pieces += 1;
      bySource.set(chunk.sourceKey, current);
    }
    const described = new Map<string, AnyRecord>(exported.hints.map((hint: AnyRecord) => [hint.sourceKey as string, hint.described as AnyRecord]));
    for (const [sourceKey, hint] of described) {
      if (typeof hint.scopeFingerprint === 'string') scopeFingerprints.set(sourceKey, hint.scopeFingerprint);
    }
    const sources: MigrationSourceEntry[] = [...bySource.values()].map((entry) => {
      const hint = described.get(entry.sourceKey) ?? {};
      return {
        sourceKey: entry.sourceKey,
        source: entry.source,
        kind: (hint.kind ?? 'local') as MigrationSourceEntry['kind'],
        bytes: entry.bytes,
        ...(hint.nativeSessionId === undefined ? {} : { nativeSessionId: hint.nativeSessionId as string }),
      };
    });
    migrationInventory.value = { revision: exported.token.revision, sources };
    return { revision: exported.token.revision, sources: sources.map((entry) => ({ ...entry })) };
  },

  bindSourceViaUi(sourceKey: string) {
    const rows = [...document.querySelectorAll('[data-testid="migration-source-row"]')] as HTMLElement[];
    const row = rows.find((node) => node.getAttribute('data-source-key') === sourceKey) ?? null;
    if (row !== null) row.click();
    return { clicked: row !== null, requested: sourceKey };
  },

  async startMigrationViaUi(options: AnyRecord = {}) {
    pendingMigrationOptions = { ...options };
    const clicked = await click('migration-start');
    const run = migrationRun;
    const outcome = run === null ? { ok: null, result: null, failure: { name: 'no-run', code: 'no-run', message: 'the wizard emitted no start' }, acceptedBatches: 0, phase: legacyWriterPhase() } : await run;
    return { clicked, outcome };
  },
  async retryMigrationViaUi(options: AnyRecord = {}) {
    pendingMigrationOptions = { ...options };
    const clicked = await click('migration-retry');
    const run = migrationRun;
    const outcome = run === null ? { ok: null, result: null, failure: { name: 'no-run', code: 'no-run', message: 'the wizard emitted no retry' }, acceptedBatches: 0, phase: legacyWriterPhase() } : await run;
    return { clicked, outcome };
  },

  bindPayloads: () => bindPayloads.map((entry) => ({ ...entry })),
  mappingIdentities: () => {
    const unique = new Map(migrationMappings.map((mapping) => [JSON.stringify([mapping.profileId, mapping.environmentId, mapping.harnessInstanceId, mapping.nativeSessionId]), mapping]));
    return { count: migrationMappings.length, uniqueCount: unique.size, identities: [...unique.keys()] };
  },
  // The REAL binder: the same native id bound to two different targets is refused as unattached,
  // and exactly one matching mapping binds.
  bindingDecision(hint: AnyRecord, mappings: AnyRecord[]) {
    return bindLegacySource(hint as never, mappings.map((entry) => Object.freeze({ ...entry })) as never);
  },
  targetCalls: () => ({ ...targetCalls, acceptedBatches: acceptedBatches.map((batch) => ({ ...batch })), verifyRequests: verifyRequests.map((request) => ({ ...request })) }),
  writerPhase: () => ({ phase: legacyWriterPhase(), paused: legacyEditingPaused() }),

  // ── the workspace capability decision + the observed launch target ──
  workspaceDecision(action: string, url: string) { return decideWorkspaceCapability(action, url); },
  endpointLocality(url: string) { return bridgeEndpointLocality(url); },
  openInEditor(bridgeUrl: string, absolutePath: string) { return openInEditorViaGuard(bridgeUrl, absolutePath); },
  launchLedger: () => launches.map((entry) => ({ ...entry })),

  // ── the workspace control routing ──
  workspaceRouting() {
    const scope = { kind: 'workspace' as const, environmentId: '11111111-1111-4111-8111-111111111111' as never, canonicalPath: '/workspace' };
    const controls = Object.keys(WORKSPACE_CONTROLS).map((control) => {
      const support = resolveControlSupport({ control, scope, manifests: [] }) as AnyRecord;
      return { control, state: support.state, channel: support.channel, operation: support.operation, service: support.service ?? null, capability: support.capability, group: support.group ?? null, reason: support.reason ?? null };
    });
    const services = [...new Set(controls.map((entry) => entry.service).filter((service): service is string => typeof service === 'string'))].sort();
    const harnessOnWorkspaceScope = resolveControlSupport({ control: 'listProviders', scope, manifests: [] }) as AnyRecord;
    const unknownControl = resolveControlSupport({ control: 'not-a-control', scope, manifests: [] }) as AnyRecord;
    const owners = Object.keys(WORKSPACE_OPERATIONS).map((operation) => {
      const key = operation as keyof typeof BACKEND_OPERATION_OWNERS;
      const mappedKey = operation as keyof typeof WORKSPACE_OPERATIONS;
      const declared = BACKEND_OPERATION_OWNERS[key] as AnyRecord;
      return { operation, owner: declared.owner, service: declared.service ?? null, mappedService: WORKSPACE_OPERATIONS[mappedKey] };
    });
    return { controls, services, unsupported: controls.filter((entry) => entry.state !== 'supported'), harnessOnWorkspaceScope: { state: harnessOnWorkspaceScope.state, channel: harnessOnWorkspaceScope.channel, reason: harnessOnWorkspaceScope.reason }, unknownControl: { state: unknownControl.state, channel: unknownControl.channel, reason: unknownControl.reason }, owners };
  },

  // ── the real bridge-version report path ──
  setBridgeHealth(input: AnyRecord) {
    if (input.url !== undefined) healthUrl.value = input.url;
    if (input.version !== undefined) healthVersion = input.version;
    if (input.networkMode !== undefined) networkMode = input.networkMode;
    if (input.hostKind !== undefined) hostIdentity.value = input.hostKind === null ? undefined : { transportKind: input.hostKind };
    return { url: healthUrl.value, version: healthVersion, networkMode, hostKind: hostIdentity.value?.transportKind ?? null };
  },
  async refreshBridgeVersion() { await bridgeVersion.refresh(); return bridgeVersionState(); },
  bridgeVersionReports: () => bridgeReports.map((entry) => ({ ...entry })),
  bridgeVersionState: () => bridgeVersionState(),
  // A second REAL composable instance with a minimum version, so the observed upgrade path and the
  // observed locality are read from the same real code path the product uses.
  async bridgeVersionWithMinimum(input: { minimumVersion: string; hostKind: string; version?: string }) {
    const health = ref('');
    const reports: AnyRecord[] = [];
    const api2 = {
      async getState() { return {} as never; },
      async configure() { return {} as never; },
      async reportBridgeVersion(report: AnyRecord) { reports.push(JSON.parse(JSON.stringify(report))); return {} as never; },
      async check() { return {} as never; },
      async download() { return {} as never; },
      async install() { return {} as never; },
      async notify() {},
      onState() { return () => {}; },
      onNotificationClick() { return () => {}; },
    };
    const identity = ref<{ transportKind: 'local' | 'direct' | 'ssh' | 'slurm' } | undefined>({ transportKind: input.hostKind as never });
    const instance = scope.run(() => useDesktopBridgeVersion(health, api2 as never, { hostIdentity: identity, minimumVersion: input.minimumVersion }))!;
    if (input.version !== undefined) healthVersion = input.version;
    networkMode = 'up';
    health.value = 'http://127.0.0.1:23004/healthz';
    await instance.refresh();
    return {
      minimumVersion: input.minimumVersion,
      hostKind: identity.value?.transportKind ?? null,
      version: healthVersion,
      state: instance.state.value,
      upgradePath: instance.upgradePath.value,
      reports: reports.map((entry) => ({ ...entry })),
    };
  },

  // ── the renderer digest against the Node oracle ──
  digestSync(seeds: string[]) { return seeds.map((seed) => legacyDigestSync(seed)); },

  probe() {
    const entrySurface = element('connection-entry');
    const migrationSurface = element('migration-wizard');
    return {
      client: document.querySelector('[data-qa-surface]')?.getAttribute('data-client') ?? null,
      entrySurfaces: document.querySelectorAll('[data-testid="connection-entry"]').length,
      perBackendChooserButtons: document.querySelectorAll('[data-backend-kind],[data-testid="connection-backend-chooser"]').length,
      profileRows: document.querySelectorAll('[data-testid="connection-profile-row"]').length,
      selectedProfileId: [...document.querySelectorAll('[data-testid="connection-profile-row"]')].find((node) => node.getAttribute('aria-pressed') === 'true')?.getAttribute('data-profile-id') ?? null,
      capabilitySupported: document.querySelectorAll('[data-testid="connection-capability-supported"]').length,
      capabilityUnsupported: document.querySelectorAll('[data-testid="connection-capability-unsupported"]').length,
      unsupportedAffordances: element('connection-capability-unsupported')?.querySelectorAll('button').length ?? null,
      statusChip: text('connection-status'),
      statusState: (element('connection-status') as HTMLElement | null)?.dataset.state ?? null,
      connectDisabled: disabled('connection-connect'),
      connectionRetryDisabled: disabled('connection-retry'),
      connectionError: text('connection-error'),
      migrationSurfaces: document.querySelectorAll('[data-testid="migration-wizard"]').length,
      migrationRows: document.querySelectorAll('[data-testid="migration-source-row"]').length,
      migrationRowTexts: [...document.querySelectorAll('[data-testid="migration-source-row"]')].map((node) => node.textContent ?? ''),
      boundNote: text('migration-bound'),
      boundRowCount: document.querySelectorAll('[data-testid="migration-source-row"].bound').length,
      backupProgress: text('migration-backup-progress'),
      backupComplete: (element('migration-backup-progress') as HTMLElement | null)?.dataset.complete ?? null,
      migrationResult: text('migration-result'),
      migrationError: text('migration-error'),
      retainedNote: text('migration-retained'),
      migrationRetryDisabled: disabled('migration-retry'),
      startDisabled: disabled('migration-start'),
      entryPresent: entrySurface !== null,
      migrationPresent: migrationSurface !== null,
    };
  },
};

(window as unknown as AnyRecord).task24 = api;

// @vitest-environment node
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createClientLegacySourcePort, type DesktopLegacyApi } from './clientLegacySourcePort';
import { createBrowserLegacySourcePort } from './browserSourcePort';
import type { LegacyExportPage, LegacyExportToken, LegacyPageRequest } from './legacyExport';
import type { LocalBindingHint } from './legacyBinding';
import { LegacyExportError } from '../../../shared/runtime/migration/streamingJson.js';

const requireNative = createRequire(path.resolve(process.cwd(), 'package.json'));
const { createLegacyExportStorage } = requireNative(path.resolve(process.cwd(), 'electron/sessionStorage.js')) as typeof import('../../../electron/sessionStorage.js');
const { registerSessionDatabaseIpc } = requireNative(path.resolve(process.cwd(), 'electron/sessionDatabaseIpc.js')) as typeof import('../../../electron/sessionDatabaseIpc.js');
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'vis-client-migration-')); roots.push(root);
  const file = path.join(root, 'renderer-storage.json');
  await writeFile(file, JSON.stringify({ 'opencode.drafts.question.v1': 'desktop-answer' }));
  const database = path.join(root, 'sessions.sqlite');
  const history = '桌面历史🦉'.repeat(8000);
  const key = `opencode.state.backendHistory.v1.${'a'.repeat(32)}.desktop-session`;
  const db = new DatabaseSync(database);
  db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE threads(namespace TEXT,thread_id TEXT); CREATE TABLE messages(namespace TEXT,thread_id TEXT); CREATE TABLE parts(namespace TEXT,thread_id TEXT);');
  db.prepare('INSERT INTO kv VALUES(?,?)').run(key, history); db.close();
  let browserValue = 'browser-composer', liveWorkers = 0, calls = 0;
  const browser = createBrowserLegacySourcePort(async function* () {
    yield { source: 'browser:owned/localStorage', key: 'opencode.drafts.composer.v1', namespace: 'unattached-legacy-local', content: browserValue, end: true };
    yield { source: 'browser:owned/localStorage', key: 'opencode.auth.credentials.v1', namespace: 'unattached-legacy-local', content: 'local-only-credential', end: true };
  });
  const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
  registerSessionDatabaseIpc({
    ipcMain: { handle(channel, handler) { handlers.set(channel, (event, payload) => handler(event as Parameters<typeof handler>[0], payload)); } },
    assertTrustedRenderer: event => { expect((event as { trusted?: boolean }).trusted).toBe(true); },
    getStorage: () => { throw new Error('Normal storage must not initialize during export'); },
    getLegacyExportStorage: () => {
      calls++; liveWorkers++;
      const worker = createLegacyExportStorage(file);
      return { ...worker, async close() { await worker.close(); liveWorkers--; } };
    },
    broadcastHistoryChange: () => { throw new Error('Read-only export must not mutate history'); },
  });
  const invoke = (name: string, payload?: unknown) => handlers.get(`session-database-${name}`)!({ trusted: true }, payload);
  const desktop: DesktopLegacyApi = {
    exportOpen: () => invoke('exportOpen') as Promise<LegacyExportToken>,
    exportPage: (request: LegacyPageRequest) => invoke('exportPage', request) as Promise<LegacyExportPage>,
    exportBinding: (request: { sourceKey: string }) => invoke('exportBinding', request) as Promise<LocalBindingHint>,
  };
  return { browser, desktop, history, database, file, key, calls: () => calls, liveWorkers: () => liveWorkers, changeBrowser: () => { browserValue = 'changed'; }, port: () => createClientLegacySourcePort(browser, desktop) };
}

describe('client legacy source with real desktop SQLite worker and IPC', () => {
  it('includes both sources and preserves history, byte offsets, bindings and local-only counts across restart', async () => {
    const f = await fixture();
    const before = createHash('sha256').update(await readFile(f.database)).digest('hex');
    let port = f.port();
    const token = await port.open();
    expect(token).toMatchObject({ records: 4, exportableRecords: 3, localOnlyRecords: 1 });
    let next: LegacyExportToken | null = token;
    const histories: string[] = [];
    const bodies: string[] = [];
    let bytes = 0;
    do {
      const page: LegacyExportPage = await port.page({ token: next, limit: 2 });
      for (const chunk of page.chunks) {
        const hint = await port.binding(chunk.sourceKey);
        if (hint.kind === 'history') {
          expect(hint.nativeSessionId).toBe('desktop-session');
          expect(chunk.offset).toBe(bytes);
          expect(chunk.namespace).toBe(`backend-history-v1:${'a'.repeat(32)}`);
          bytes += Buffer.byteLength(chunk.content); histories.push(chunk.content);
        } else bodies.push(chunk.content);
        expect(chunk.checksum).toBe(createHash('sha256').update(chunk.content).digest('hex'));
      }
      next = page.next && JSON.parse(JSON.stringify(page.next));
      port = f.port();
    } while (next);
    expect(histories.join('')).toBe(f.history);
    expect(bodies.sort()).toEqual(['browser-composer', 'desktop-answer']);
    expect(f.liveWorkers()).toBe(0);
    expect(createHash('sha256').update(await readFile(f.database)).digest('hex')).toBe(before);
  });
  it('rejects a stale resume when the desktop source changes', async () => {
    const f = await fixture(), token = await f.port().open();
    const db = new DatabaseSync(f.database); db.prepare('UPDATE kv SET value=?').run('changed'); db.close();
    await expect(f.port().page({ token, limit: 1 })).rejects.toMatchObject({ code: 'source_changed' });
    expect(f.liveWorkers()).toBe(0);
  });
  it('rejects a stale resume when the browser source changes', async () => {
    const f = await fixture(), token = await f.port().open(); f.changeBrowser();
    await expect(f.port().page({ token, limit: 1 })).rejects.toMatchObject({ code: 'source_changed' });
  });
  it('reports unavailable desktop export rather than silently exporting the browser alone', async () => {
    const f = await fixture();
    for (const api of [null, { ...f.desktop, exportPage: undefined }, { ...f.desktop, exportBinding: undefined }]) {
      await expect((async () => { await createClientLegacySourcePort(f.browser, api).open(); })()).rejects.toMatchObject({ code: 'source_unavailable' });
    }
  });
  it('leaves browser-only clients on their existing port', async () => {
    const f = await fixture();
    expect(createClientLegacySourcePort(f.browser)).toBe(f.browser);
    expect(f.calls()).toBe(0);
  });
  it('detects a sibling source changed while the other source page is being read', async () => {
    const f = await fixture();
    const browser = { ...f.browser, async page(request: LegacyPageRequest) {
      const page = await f.browser.page(request);
      const db = new DatabaseSync(f.database); db.prepare('UPDATE kv SET value=?').run('raced'); db.close();
      return page;
    } };
    const port = createClientLegacySourcePort(browser, f.desktop), token = await port.open();
    await expect(port.page({ token, limit: 1 })).rejects.toMatchObject({ code: 'source_changed' });
    expect(f.liveWorkers()).toBe(0);
  });
  it('rejects invalid cursors before opening desktop workers', async () => {
    const f = await fixture(), port = f.port(), token = await port.open(), before = f.calls();
    for (const request of [{ token, limit: 0 }, { token: { ...token, offset: token.count + 1 } }, { token: { ...token, offset: NaN } }]) {
      await expect(port.page(request)).rejects.toMatchObject({ code: 'invalid_cursor' });
    }
    expect(f.calls()).toBe(before);
  });
  it('resolves a desktop binding after reopening without keeping an unbounded routing map', async () => {
    const f = await fixture(), port = f.port();
    const page = await port.page({ token: await port.open(), limit: 200 });
    const history = page.chunks.find(chunk => chunk.namespace.startsWith('backend-history-v1:'))!;
    expect(await f.port().binding(history.sourceKey)).toMatchObject({ kind: 'history', nativeSessionId: 'desktop-session' });
    expect(f.liveWorkers()).toBe(0);
  });
  it('drains the real desktop worker before reporting a sibling inventory failure', async () => {
    const f = await fixture();
    const browser = { ...f.browser, open: async () => { throw new LegacyExportError('corrupt_source'); } };
    await expect(createClientLegacySourcePort(browser, f.desktop).open()).rejects.toMatchObject({ code: 'corrupt_source' });
    expect(f.liveWorkers()).toBe(0);
  });
  it('keeps same-name browser and desktop drafts as distinct source records', async () => {
    const f = await fixture();
    await writeFile(f.file, JSON.stringify({ 'opencode.drafts.composer.v1': 'desktop-composer' }));
    const port = f.port(), token = await port.open();
    const page = await port.page({ token, limit: 200 });
    const drafts = [];
    for (const chunk of page.chunks) if ((await port.binding(chunk.sourceKey)).kind === 'composer') drafts.push(chunk);
    expect(drafts.map(chunk => chunk.content).sort()).toEqual(['browser-composer', 'desktop-composer']);
    expect(new Set(drafts.map(chunk => chunk.sourceKey)).size).toBe(2);
    expect(f.liveWorkers()).toBe(0);
  });
});

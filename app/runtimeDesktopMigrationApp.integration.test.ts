import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { nextTick } from 'vue';
import { expect, it, vi } from 'vitest';
import { mountRuntimeApp } from './test/runtimeAppHarness';
import type { LegacyPageRequest } from './runtime/migration/legacyExport';

it('lists and binds real desktop SQLite history from the Settings migration entry in App', async () => {
  const fixture = await mountRuntimeApp([]);
  const root = await mkdtemp(path.join(tmpdir(), 'vis-desktop-migration-app-'));
  const file = path.join(root, 'renderer-storage.json');
  const previousApi = Object.getOwnPropertyDescriptor(window, 'electronAPI');
  const previousIdb = Object.getOwnPropertyDescriptor(window, 'indexedDB');
  const native = createRequire(path.resolve(process.cwd(), 'package.json'))('./electron/sessionStorage.js') as typeof import('../electron/sessionStorage.js');
  let activeWorkers = 0;
  async function withWorker<T>(read: (worker: ReturnType<typeof native.createLegacyExportStorage>) => Promise<T>): Promise<T> {
    activeWorkers++;
    const worker = native.createLegacyExportStorage(file);
    try { return await read(worker); } finally { await worker.close(); activeWorkers--; }
  }
  try {
    await writeFile(file, '{}');
    const db = new DatabaseSync(path.join(root, 'sessions.sqlite'));
    db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE threads(namespace TEXT,thread_id TEXT); CREATE TABLE messages(namespace TEXT,thread_id TEXT); CREATE TABLE parts(namespace TEXT,thread_id TEXT);');
    const key = `opencode.state.backendHistory.v1.${'a'.repeat(32)}.session-a`;
    db.prepare('INSERT INTO kv VALUES(?,?)').run(key, 'desktop-history-unique-body'); db.close();
    await fixture.connect(); await fixture.select('Session A');
    // The DOM lane supplies the desktop API boundary; the separate port test
    // uses the production trusted IPC handler. Both use the real SQLite worker.
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: { sessionDatabase: {
      exportOpen: () => withWorker(worker => worker.exportOpen()),
      exportPage: (request: LegacyPageRequest) => withWorker(worker => worker.exportPage(request)),
      exportBinding: (request: { sourceKey: string }) => withWorker(worker => worker.exportBinding(request)),
    } } });
    Object.defineProperty(window, 'indexedDB', { configurable: true, value: { databases: async () => [] } });
    fixture.element.querySelector<HTMLButtonElement>('button[title="Settings"]')!.click(); await nextTick();
    const menu = [...fixture.element.querySelectorAll<HTMLElement>('dialog[open][aria-labelledby="settings-modal-title"] .setting-link-row')].find(entry => entry.textContent?.includes('Migrate workspace data'));
    expect(menu).toBeDefined(); menu!.click();
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    const sourceKey = hash(JSON.stringify([`electron:${hash(path.resolve(file))}/sqlite/kv`, key]));
    await vi.waitFor(() => expect(fixture.element.querySelector(`[data-source-key="${sourceKey}"]`)).not.toBeNull(), { timeout: 15000 });
    const row = fixture.element.querySelector<HTMLButtonElement>(`[data-source-key="${sourceKey}"]`)!;
    expect(row.querySelector('.source-kind')?.textContent).toContain('History');
    expect(fixture.element.textContent).not.toContain('desktop-history-unique-body');
    row.click();
    await vi.waitFor(() => expect(fixture.element.querySelector('[data-testid="migration-bound"]')).not.toBeNull());
    expect(fixture.element.querySelector('[data-testid="migration-error"]')).toBeNull();
    expect(activeWorkers).toBe(0);
  } finally {
    await fixture.unmount();
    if (previousApi) Object.defineProperty(window, 'electronAPI', previousApi); else Reflect.deleteProperty(window, 'electronAPI');
    if (previousIdb) Object.defineProperty(window, 'indexedDB', previousIdb); else Reflect.deleteProperty(window, 'indexedDB');
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

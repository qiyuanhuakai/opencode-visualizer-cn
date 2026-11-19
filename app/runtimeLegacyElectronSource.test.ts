// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createElectronLegacySource } from '../electron/legacyExportSource.mjs';

const roots: string[] = [];
async function fixture(key: string) {
  const root = await mkdtemp(path.join(tmpdir(), 'vis-legacy-kv-')); roots.push(root);
  const file = path.join(root, 'renderer-storage.json');
  await writeFile(file, '{}');
  const database = path.join(root, 'sessions.sqlite');
  const db = new DatabaseSync(database);
  db.exec('CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE kv(key TEXT PRIMARY KEY,value TEXT); CREATE TABLE threads(namespace TEXT,thread_id TEXT); CREATE TABLE messages(namespace TEXT,thread_id TEXT); CREATE TABLE parts(namespace TEXT,thread_id TEXT);');
  db.prepare('INSERT INTO kv VALUES(?,?)').run(key, 'untouched-history-正文');
  db.close();
  const digest = async () => createHash('sha256').update(await readFile(database)).digest('hex');
  return { file, digest };
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('Electron legacy SQLite KV namespaces', () => {
  for (const prefix of ['opencode.', '']) {
    it(`preserves backend-history scope from ${prefix || 'raw'} KV keys`, async () => {
      const scope = 'a'.repeat(32);
      const { file, digest } = await fixture(`${prefix}state.backendHistory.v1.${scope}.ses_1`);
      const before = await digest();
      const chunks = [];
      for await (const piece of createElectronLegacySource(file)()) chunks.push(piece);
      expect(chunks.filter(piece => piece.source.endsWith('/sqlite/kv'))).toMatchObject([{ namespace: `backend-history-v1:${scope}`, content: 'untouched-history-正文' }]);
      expect(await digest()).toBe(before);
    });
  }
  it('rejects malformed KV scope without modifying the legacy database', async () => {
    const { file, digest } = await fixture('opencode.state.backendHistory.v1.not-a-scope.ses_1');
    const before = await digest();
    await expect((async () => { for await (const _piece of createElectronLegacySource(file)()) { /* consume */ } })()).rejects.toMatchObject({ code: 'unknown_namespace' });
    expect(await digest()).toBe(before);
  });
});

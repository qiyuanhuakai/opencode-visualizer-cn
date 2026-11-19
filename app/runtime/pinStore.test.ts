// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { parseConnectionProfileId, parseEnvironmentId, parseHarnessInstanceId } from '../../shared/runtime/identity.js';
import type { BrowserContext, Page } from 'playwright';
declare global { interface Window { pinModule: typeof import('./pinStore') } }
const evidence = path.resolve(import.meta.dirname, '../../.omo/evidence/vis-v090/task-20/draft-pin');
const profile = path.join(evidence, `pin-test-profile-${process.pid}`);
let context: BrowserContext; let page: Page;
const server = createServer();
const profileId = parseConnectionProfileId('33333333-3333-4333-8333-333333333333');
const environmentId = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const harnessInstanceId = parseHarnessInstanceId('22222222-2222-4222-8222-222222222222');
const ids = { letterProfile: parseConnectionProfileId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), betweenProfile: parseConnectionProfileId('99999999-9999-4999-8999-999999999999'), profileId, environmentId, harnessInstanceId, otherProfile: parseConnectionProfileId(environmentId), otherEnvironment: parseEnvironmentId(profileId), otherHarness: parseHarnessInstanceId(profileId) };
beforeAll(async () => {
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, 'pin-test-resources.json'), JSON.stringify({ owner: 'pinStore.test.ts', pid: process.pid, profile, server: 'owned127.0.0.1:port0', cleanup: 'context.close/server.close/exact profile rm' }));
  const bundle = await build({ entryPoints: [path.join(import.meta.dirname, 'pinStore.ts')], bundle: true, write: false, format: 'iife', globalName: 'pinModule' });
  const script = bundle.outputFiles[0]?.text; if (!script) throw new Error('bundle absent');
  server.on('request', (request, response) => { response.setHeader('Content-Type', request.url === '/module.js' ? 'text/javascript' : 'text/html'); response.end(request.url === '/module.js' ? script : '<!doctype html><title>Pin tests</title><script src="/module.js"></script>'); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw new Error('address absent');
  context = await chromium.launchPersistentContext(profile, { headless: true }); page = await context.newPage(); await page.goto(`http://127.0.0.1:${address.port}`);
}, 30000);
afterAll(async () => {
  await context?.close(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(profile, { recursive: true, force: true }); await writeFile(path.join(evidence, 'pin-test-cleanup.json'), JSON.stringify({ contextClosed: true, serverClosed: true, profileRemoved: profile }));
});
describe('offline pin identities in real IndexedDB', () => {
  it('persists CAS, idempotent replay and unpin tombstones across reopen', async () => {
    const result = await page.evaluate(async ids => {
      const { PinStore } = window.pinModule; let store = await PinStore.open();
      const selection = { profileId: ids.profileId, session: { environmentId: ids.environmentId, harnessInstanceId: ids.harnessInstanceId, nativeSessionId: 'CAS' } };
      // Browser boundary parsers validate these serialized UUIDs before use.
      const input = { selection, clientOrigin: 'a', revision: 2, pinned: true };
      await store.set(input); await store.set(input); const errors = [];
      for (const entry of [{ ...input, revision: 1 }, { ...input, pinned: false }]) { try { await store.set(entry); } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); } }
      await store.set({ ...input, revision: 3, pinned: false }); store.close(); store = await PinStore.open(); const held = await store.get(input);
      const record = held?.record; held?.release(); const usage = store.usage(); store.close(); return { record, errors, usage };
    }, ids);
    expect(result.errors).toEqual(['conflict', 'conflict']); expect(result.record).toMatchObject({ revision: 3, pinned: false }); expect(result.usage.residentBytes).toBe(0);
  });
  it('preserves every qualified identity field and client origin', async () => {
    const result = await page.evaluate(async ids => {
      const store = await window.pinModule.PinStore.open();
      const base = { profileId: ids.profileId, session: { environmentId: ids.environmentId, harnessInstanceId: ids.harnessInstanceId, nativeSessionId: 'same-native' } };
      const variants = [base, { ...base, profileId: ids.otherProfile }, { ...base, session: { ...base.session, environmentId: ids.otherEnvironment } }, { ...base, session: { ...base.session, harnessInstanceId: ids.otherHarness } }];
      for (const [index, selection] of variants.entries()) await store.set({ selection, clientOrigin: 'a', revision: index + 1, pinned: true });
      await store.set({ selection: base, clientOrigin: 'b', revision: 7, pinned: false });
      const revisions = [];
      for (const selection of variants) { const held = await store.get({ selection, clientOrigin: 'a' }); revisions.push(held?.record.revision); held?.release(); }
      const other = await store.get({ selection: base, clientOrigin: 'b' }); revisions.push(other?.record.revision); other?.release(); store.close(); return revisions;
    }, ids);
    expect(result).toEqual([1, 2, 3, 4, 7]);
  });
  it('pages bounded leased identities and rejects foreign cursors or retained-output overadmission', async () => {
    const result = await page.evaluate(async ids => {
      const store = await window.pinModule.PinStore.open();
      for (let i = 0; i < 205; i++) await store.set({ selection: { profileId: ids.profileId, session: { environmentId: ids.environmentId, harnessInstanceId: ids.harnessInstanceId, nativeSessionId: `page-${String(i).padStart(3, '0')}` } }, clientOrigin: 'a', revision: 1, pinned: true });
      const first = await store.page({ profileId: ids.profileId }); const count = first.records.length; const usage = store.usage(); let heldError = ''; let foreignError = '';
      try { await store.page({ profileId: ids.profileId }); } catch (error) { heldError = String(error); }
      const cursor = first.next; first.release();
      if (cursor) { try { await store.page({ profileId: ids.otherProfile, after: cursor }); } catch (error) { foreignError = String(error); } }
      const next = await store.page({ profileId: ids.profileId, ...(cursor ? { after: cursor } : {}), limit: 200 }); const nextCount = next.records.length; next.release(); store.close(); return { count, nextCount, usage, heldError, foreignError };
    }, ids);
    expect(result.count).toBe(100); expect(result.nextCount).toBeGreaterThan(100); expect(result.nextCount).toBeLessThanOrEqual(200);
    expect(result.usage.residentBytes).toBeLessThanOrEqual(512 * 1024); expect(result.heldError).toContain('budget'); expect(result.foreignError).toContain('invalid');
  });
  it('acknowledges set only after the actual strict transaction completion event', async () => {
    const order = await page.evaluate(async ids => {
      const events: string[] = []; const original = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (names, mode, options) {
        const tx = original.call(this, names, mode, options);
        if (mode === 'readwrite') tx.addEventListener('complete', () => events.push('oncomplete'));
        return tx;
      };
      const store = await window.pinModule.PinStore.open();
      try {
        await store.set({ selection: { profileId: ids.profileId, session: { environmentId: ids.environmentId, harnessInstanceId: ids.harnessInstanceId, nativeSessionId: 'ack-order' } }, clientOrigin: 'a', revision: 1, pinned: true });
        events.push('ack'); return events;
      } finally { store.close(); IDBDatabase.prototype.transaction = original; }
    }, ids);
    expect(order).toEqual(['oncomplete', 'ack']);
  });
  it('serializes conflicting same-revision updates across two independent database connections', async () => {
    const result = await page.evaluate(async ids => {
      const first = await window.pinModule.PinStore.open(); const second = await window.pinModule.PinStore.open();
      const record = { selection: { profileId: ids.profileId, session: { environmentId: ids.environmentId, harnessInstanceId: ids.harnessInstanceId, nativeSessionId: 'two-clients' } }, clientOrigin: 'a', revision: 8, pinned: true };
      try {
        const result = await Promise.allSettled([first.set(record), second.set({ ...record, pinned: false })]);
        return result.map(value => value.status === 'fulfilled' ? 'ack' : String(value.reason));
      } finally { first.close(); second.close(); }
    }, ids);
    expect(result.filter(item => item === 'ack')).toHaveLength(1); expect(result.filter(item => item.includes('conflict'))).toHaveLength(1);
  });

  it('normalizes cursor UUIDs before creating its profile-scoped key range', async () => {
    const records = await page.evaluate(async ids => {
      const store = await window.pinModule.PinStore.open();
      try {
        for (const profileId of [ids.letterProfile, ids.betweenProfile]) for (const nativeSessionId of ['a', 'b']) {
          await store.set({ selection: { profileId, session: { environmentId: ids.environmentId, harnessInstanceId: ids.harnessInstanceId, nativeSessionId } }, clientOrigin: 'a', revision: 1, pinned: true });
        }
        const page = await store.page({ profileId: ids.letterProfile, after: [ids.letterProfile.toUpperCase(), ids.environmentId, ids.harnessInstanceId, 'a', 'a'] });
        const rows = page.records.map(row => [row.selection.profileId, row.selection.session.nativeSessionId]); page.release(); return rows;
      } finally { store.close(); }
    }, ids);
    expect(records).toEqual([[ids.letterProfile, 'b']]);
  });

});

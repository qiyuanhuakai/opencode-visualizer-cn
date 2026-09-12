#!/usr/bin/env node
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const baseUrl = process.env.VIS_QA_URL || 'http://127.0.0.1:5173';
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  await context.route('**/__codex-storage-qa', route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  const page = await context.newPage();
  await page.goto(`${baseUrl}/__codex-storage-qa`);
  const migrated = await page.evaluate(async () => {
    const { storageSet } = await import('/utils/storageKeys.ts');
    const storage = await import('/backends/codex/auxiliaryStorage.ts');
    const effort = await import('/backends/codex/messageEffort.ts');
    const { normalizeCodexTurnsToHistory } = await import('/backends/codex/normalize.ts');
    const key = 'opencode.state.codexAuxiliaryHistory.v1.quota';
    let low = 0, high = 6 * 1024 * 1024;
    while (low < high) {
      const length = Math.ceil((low + high) / 2);
      try { localStorage.setItem(key, JSON.stringify({ text: 'x'.repeat(length) })); low = length; }
      catch (error) { if (error.name !== 'QuotaExceededError') throw error; high = length - 1; }
    }
    const original = localStorage.getItem(key);
    const rejected = !storageSet('quota-probe', '1');
    const entries = normalizeCodexTurnsToHistory({ sessionId: 'thread', turns: [{ id: 'turn', status: 'completed', items: [
      { type: 'userMessage', content: [{ type: 'text', text: 'Question' }] },
      { type: 'agentMessage', id: 'answer', text: 'Done' },
    ] }] });
    effort.saveCodexTurnEffort('thread', 'turn', 'medium');
    const lostBeforeMigration = effort.restoreCodexMessageEfforts('thread', entries).every(entry => !entry.info.variant);
    await storage.initializeCodexAuxiliaryStorage();
    const preserved = JSON.stringify(storage.readCodexAuxiliarySnapshot('quota')) === original;
    const removed = localStorage.getItem(key) === null;
    effort.saveCodexTurnEffort('thread', 'turn', 'medium');
    sessionStorage.setItem('quota-size', String(original.length));
    return { rejected, lostBeforeMigration, preserved, removed, variants: effort.restoreCodexMessageEfforts('thread', entries).map(entry => entry.info.variant) };
  });
  assert.deepEqual(migrated, { rejected: true, lostBeforeMigration: true, preserved: true, removed: true, variants: ['medium', 'medium'] });
  await page.reload();
  const restored = await page.evaluate(async () => {
    const storage = await import('/backends/codex/auxiliaryStorage.ts');
    await storage.initializeCodexAuxiliaryStorage();
    const preserved = JSON.stringify(storage.readCodexAuxiliarySnapshot('quota')).length === Number(sessionStorage.getItem('quota-size'));
    const savedEffort = JSON.parse(localStorage.getItem('opencode.state.codexTurnEfforts.v1.thread'))['turn:user:0'];
    storage.writeCodexAuxiliarySnapshot('new', { text: 'new cached history' });
    await storage.flushCodexAuxiliaryStorage();
    return { preserved, savedEffort };
  });
  assert.deepEqual(restored, { preserved: true, savedEffort: 'medium' });
  await page.reload();
  const aborted = await page.evaluate(async () => {
    const key = 'opencode.state.codexAuxiliaryHistory.v1.abort';
    localStorage.setItem(key, '{"text":"keep on failure"}');
    const storage = await import('/backends/codex/auxiliaryStorage.ts');
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function () { throw new DOMException('Test quota failure', 'QuotaExceededError'); };
    let rejected = false;
    try { await storage.initializeCodexAuxiliaryStorage(); }
    catch (error) { rejected = error.name === 'QuotaExceededError'; }
    finally { IDBObjectStore.prototype.put = put; }
    const retained = localStorage.getItem(key) === '{"text":"keep on failure"}';
    await storage.initializeCodexAuxiliaryStorage();
    const newHistory = storage.readCodexAuxiliarySnapshot('new');
    const recovered = storage.readCodexAuxiliarySnapshot('abort');
    storage.removeCodexAuxiliarySnapshot('new');
    await storage.flushCodexAuxiliaryStorage();
    return { rejected, retained, newHistory, recovered };
  });
  assert.deepEqual(aborted, { rejected: true, retained: true, newHistory: { text: 'new cached history' }, recovered: { text: 'keep on failure' } });
  await page.reload();
  assert.equal(await page.evaluate(async () => {
    const storage = await import('/backends/codex/auxiliaryStorage.ts');
    await storage.initializeCodexAuxiliaryStorage();
    return storage.readCodexAuxiliarySnapshot('new');
  }), null);
  const second = await context.newPage();
  await second.goto(`${baseUrl}/__codex-storage-qa`);
  await second.evaluate(async () => {
    const storage = await import('/backends/codex/auxiliaryStorage.ts');
    await storage.initializeCodexAuxiliaryStorage();
  });
  await page.evaluate(async () => {
    const storage = await import('/backends/codex/auxiliaryStorage.ts');
    storage.writeCodexAuxiliarySnapshot('shared', { text: 'updated in another tab' });
    await storage.flushCodexAuxiliaryStorage();
  });
  await second.waitForFunction(async () => {
    const storage = await import('/backends/codex/auxiliaryStorage.ts');
    return storage.readCodexAuxiliarySnapshot('shared')?.text === 'updated in another tab';
  });
  await page.evaluate(async () => {
    const storage = await import('/backends/codex/auxiliaryStorage.ts');
    storage.removeCodexAuxiliarySnapshot('shared');
    await storage.flushCodexAuxiliaryStorage();
  });
  await second.waitForFunction(async () => {
    const storage = await import('/backends/codex/auxiliaryStorage.ts');
    return storage.readCodexAuxiliarySnapshot('shared') === null;
  });
  console.log('PASS: full quota reproduces completed-message effort loss; migration preserves history and restores durable metadata; aborted migration retains legacy data; writes and deletion survive reload and synchronize across tabs.');
} finally {
  await browser.close();
}

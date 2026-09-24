import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron } from 'playwright';
import { closeApp } from './electron-smoke-utils.mjs';

const executablePath = process.env.VIS_ELECTRON_EXECUTABLE;
assert.ok(executablePath, 'VIS_ELECTRON_EXECUTABLE must point to the packaged test application');
const historyPrefix = 'opencode.state.codexAuxiliaryHistory.v1.';
const profile = mkdtempSync(path.join(tmpdir(), 'vis-latency-profile-'));
const output = process.env.VIS_LATENCY_OUT_DIR ?? path.join(tmpdir(), 'vis-electron-latency-results');
mkdirSync(output, { recursive: true });
const legacy = process.env.VIS_LEGACY_STORAGE
  ? JSON.parse(readFileSync(process.env.VIS_LEGACY_STORAGE, 'utf8'))
  : { [`${historyPrefix}large-fixture`]: JSON.stringify({ content: 'x'.repeat(32 * 1024 * 1024) }) };
const histories = Object.fromEntries(Object.entries(legacy).filter(([key]) => key.startsWith(historyPrefix)));
writeFileSync(path.join(profile, 'renderer-storage.json'), JSON.stringify(histories));
const bridgeUrl = 'ws://127.0.0.1:51998/codex';
const failureMarker = 'QA_RENDER_FAILURE_<script>window.qaInjected=true</script>';
const threads = ['one', 'two', 'failure'].map((name, index) => ({
  id: `latency-${name}`, name: `Latency ${name}`, cwd: '/qa/latency',
  modelProvider: 'qa-local', model: 'qa-model', status: { type: 'idle' },
  createdAt: index + 1, updatedAt: index + 1,
  turns: [{ id: `turn-${name}`, status: 'completed', items: [
    { id: `user-${name}`, type: 'userMessage', content: [{ type: 'text', text: `Question ${name}` }] },
    { id: `answer-${name}`, type: 'agentMessage', text: name === 'failure' ? failureMarker : `Answer ${name}` },
  ] }],
}));

function resultFor(message) {
  const thread = threads.find((entry) => entry.id === message.params?.threadId) ?? threads[0];
  switch (message.method) {
    case 'initialize': return { userAgent: 'codex-app-server/qa', platformFamily: 'windows', platformOs: 'windows' };
    case 'thread/list': return { data: threads, nextCursor: null };
    case 'thread/read':
    case 'thread/resume': return { thread };
    case 'thread/turns/list': return { data: thread.turns, nextCursor: null };
    case 'fs/readDirectory': return { entries: [] };
    case 'config/read': return { config: { model: 'qa-model', model_provider: 'qa-local' }, layers: [] };
    case 'model/list': return { data: [{ id: 'qa-model', model: 'qa-model', displayName: 'QA Model', modelProvider: 'qa-local', supportedReasoningEfforts: [] }], nextCursor: null };
    case 'account/read': return { account: null, requiresOpenaiAuth: false };
    case 'account/rateLimits/read': return { rateLimits: null };
    case 'configRequirements/read': return { requirements: null };
    case 'modelProvider/capabilities/read': return { namespaceTools: false, imageGeneration: false, webSearch: false };
    case 'thread/goal/get': return { goal: null };
    case 'vcs/getInfo': return { root: '/qa/latency', worktreeRoot: '/qa/latency', branch: 'qa' };
    default: return { data: [], nextCursor: null };
  }
}

let app;
const receipt = { platform: process.platform, migratedKeys: 0, checks: [], errors: [] };
try {
  const start = performance.now();
  app = await _electron.launch({
    executablePath,
    args: [`--user-data-dir=${profile}`],
    chromiumSandbox: true,
    timeout: 90000,
  });
  const page = await app.firstWindow();
  receipt.startupMs = performance.now() - start;
  page.on('pageerror', error => receipt.errors.push(error.message));
  await page.routeWebSocket(`${bridgeUrl}**`, socket => {
    socket.onMessage(raw => {
      const message = JSON.parse(String(raw));
      if (message.id !== undefined) socket.send(JSON.stringify({ id: message.id, result: resultFor(message) }));
    });
  });
  await page.route('http://127.0.0.1:51998/**', route => route.fulfill({
    status: 200, contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(route.request().url().endsWith('/homedir') ? { home: '/qa' } : {}),
  }));
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      postMessage(message, ...args) {
        if (message?.code?.includes('QA_RENDER_FAILURE_')) throw new Error('QA forced render failure');
        return super.postMessage(message, ...args);
      }
    };
  });
  await page.reload();
  await page.getByRole('button', { name: /Codex/i }).click();
  await page.locator('input[name="codexBridgeUrl"]').fill(bridgeUrl);
  await page.locator('.app-loading-connect').click();
  await page.locator('.app-header').waitFor({ state: 'visible', timeout: 30000 });
  receipt.checks.push('packaged app login through fixture bridge');

  const select = async name => {
    await page.locator('.tree-dropdown-root .ui-dropdown-button').click();
    await page.locator('.session-title').filter({ hasText: `Latency ${name}` }).click();
    await page.getByText(`Question ${name}`, { exact: true }).waitFor();
    await page.locator('.output-panel-scroll .app-loading-spinner').waitFor({ state: 'hidden', timeout: 5000 });
  };
  await select('one');
  const input = page.locator('textarea.input-textarea');
  await input.fill('');
  const typed = 'Electron typing remains responsive after migration. 1234567890';
  await input.pressSequentially(typed, { delay: 30 });
  await page.waitForFunction(expected => document.querySelector('textarea.input-textarea')?.value === expected, typed);
  const timings = await page.evaluate(() => {
    const values = [];
    for (let index = 0; index < 5; index++) {
      const started = performance.now();
      if (!window.electronAPI.persistentStorage.setItem('opencode.qa.latency', String(index))) throw new Error('write failed');
      values.push(performance.now() - started);
    }
    return values;
  });
  receipt.smallWriteMs = timings;
  assert.ok(Math.max(...timings) < 250, `small writes still block: ${timings}`);
  receipt.checks.push('actual keyboard typing retained and small IPC writes below 250ms');

  const protectedText = await page.evaluate(() => {
    const input = document.querySelector('textarea.input-textarea');
    if (!(input instanceof HTMLTextAreaElement)) throw new Error('missing input');
    const key = 'opencode.drafts.composer.v1';
    const oldValue = window.electronAPI.persistentStorage.getItem(key);
    input.value = 'new local input must survive';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const store = JSON.parse(oldValue ?? '{}');
    store['latency-two'] = { messageInput: 'remote other context', attachments: [], rev: Date.now(), updatedAt: Date.now(), writerTabId: 'qa-other' };
    window.dispatchEvent(new StorageEvent('storage', { key, oldValue, newValue: JSON.stringify(store) }));
    return input.value;
  });
  assert.equal(protectedText, 'new local input must survive');
  await page.waitForFunction(() => document.querySelector('textarea.input-textarea')?.value === 'new local input must survive');
  receipt.checks.push('remote draft event preserves pending local input');

  await select('two');
  await select('one');
  assert.equal(await input.inputValue(), 'new local input must survive');
  receipt.checks.push('session switching restores the correct saved draft');
  await page.locator('.tree-dropdown-root .ui-dropdown-button').click();
  const frameStart = performance.now();
  await page.evaluate(() => {
    window.qaOriginalFrame = window.requestAnimationFrame;
    window.qaOriginalCancel = window.cancelAnimationFrame;
    window.requestAnimationFrame = () => 0;
    window.cancelAnimationFrame = () => {};
    const option = [...document.querySelectorAll('.session-title')].find(node => node.textContent === 'Latency two');
    if (!(option instanceof HTMLElement)) throw new Error('session option missing');
    option.click();
  });
  try {
    await page.waitForFunction(() =>
      document.querySelector('.output-panel-messages')?.textContent.includes('Question two') &&
      !document.querySelector('.output-panel-scroll .app-loading-spinner'),
    undefined, { polling: 50, timeout: 3000 });
    receipt.suspendedFrameAnchorMs = performance.now() - frameStart;
  } finally {
    await page.evaluate(() => {
      window.requestAnimationFrame = window.qaOriginalFrame;
      window.cancelAnimationFrame = window.qaOriginalCancel;
      delete window.qaOriginalFrame;
      delete window.qaOriginalCancel;
    });
  }
  receipt.checks.push('output anchoring settles even with suspended animation frames');
  await select('failure');
  await page.getByText(failureMarker, { exact: true }).first().waitFor({ timeout: 5000 });
  assert.equal(await page.evaluate(() => window.qaInjected), undefined);
  receipt.checks.push('worker failure displays escaped readable answer');
  await page.screenshot({ path: path.join(output, 'windows-electron.png') });

  const root = JSON.parse(readFileSync(path.join(profile, 'renderer-storage.json'), 'utf8'));
  assert.ok(Object.keys(root).every(key => !key.startsWith(historyPrefix)));
  for (const [key, value] of Object.entries(histories)) {
    const name = `${createHash('sha256').update(key).digest('hex')}.json`;
    const shard = JSON.parse(readFileSync(path.join(profile, 'renderer-storage.json.history', name), 'utf8'));
    assert.equal(shard[key], value, 'migrated history differs');
    receipt.migratedKeys++;
  }
  receipt.rootBytes = Buffer.byteLength(JSON.stringify(root));
  receipt.checks.push('all legacy auxiliary history values preserved exactly');
  assert.deepEqual(receipt.errors, []);
  receipt.pass = true;
} finally {
  await closeApp(app);
  rmSync(profile, { recursive: true, force: true });
  writeFileSync(path.join(output, 'receipt.json'), JSON.stringify(receipt, null, 2));
  console.log(JSON.stringify(receipt, null, 2));
}

#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runBrowserQa } from './test-contracts-support.mjs';

const bridge = 'http://127.0.0.1:51999';
const ws = 'ws://127.0.0.1:51999/codex';
const evidence = '.omo/evidence/codex-slash';
const rpc = [];
const observables = [];
const parent = { id: 'slash-parent', name: 'Slash QA Parent', cwd: '/qa/workspace', modelProvider: 'openai', model: 'gpt-5.4', historyMode: 'paginated', status: { type: 'idle' }, createdAt: 2, updatedAt: 2, turns: [{ id: 'history', status: 'completed', items: [{ id: 'history-user', type: 'userMessage', content: [{ type: 'text', text: 'Slash browser history' }] }, { id: 'history-answer', type: 'agentMessage', text: 'Main thread answer' }] }] };
const threads = new Map([[parent.id, parent]]);
let socket;
let sequence = 0;
const requests = (method) => rpc.filter(entry => entry.method === method);
function result(message) {
  const p = message.params ?? {};
  switch (message.method) {
    case 'initialize': return { userAgent: 'codex-app-server/qa-fixture', platformFamily: 'linux', platformOs: 'linux' };
    case 'thread/list': return { data: [...threads.values()].filter(thread => !thread.ephemeral && !thread.archived), nextCursor: null };
    case 'thread/start': { const thread = { ...parent, id: 'new-' + ++sequence, name: 'New QA', turns: [] }; threads.set(thread.id, thread); return { thread }; }
    case 'thread/name/set': { threads.get(p.threadId).name = p.name; return {}; }
    case 'thread/archive': { threads.get(p.threadId).archived = true; return {}; }
    case 'thread/revert': {
      const thread = threads.get(p.threadId);
      const index = thread.turns.findIndex(turn => turn.id === p.beforeTurnId);
      assert.ok(index >= 0, 'Revert must select a real turn');
      thread.turns = thread.turns.slice(0, index);
      return { thread };
    }
    case 'thread/goal/set': return { goal: { objective: p.objective ?? 'QA goal', status: p.status ?? 'active', tokenBudget: null, tokensUsed: 0, elapsedSeconds: 0 } };
    case 'thread/read': case 'thread/resume': return { thread: threads.get(p.threadId) ?? parent };
    case 'thread/turns/list': return { data: threads.get(p.threadId)?.turns ?? [], nextCursor: null };
    case 'thread/fork': {
      const thread = { ...parent, id: `fork-${++sequence}`, name: p.ephemeral ? 'Side conversation' : 'Fork QA', ephemeral: p.ephemeral ?? false };
      threads.set(thread.id, thread);
      return { thread };
    }
    case 'turn/start': return { turn: { id: `turn-${++sequence}`, status: p.threadId.startsWith('fork-') ? 'inProgress' : 'completed', items: [] } };
    case 'review/start': {
      const turn = { id: 'review-turn', status: 'inProgress', items: [{ id: 'review-user', type: 'userMessage', content: [{ type: 'text', text: 'Review current changes' }] }] };
      threads.get(p.threadId).turns.push(turn);
      return { reviewThreadId: p.threadId, turn };
    }
    case 'command/exec': return { exitCode: 0, stdout: p.command.join(' ').includes('##BEFORE') ? '##TITLE\tQA diff\n##FILE\tM\tqa.txt\n##BEFORE\nb2xk\n##AFTER\nbmV3\n' : '', stderr: '' };
    case 'config/read': return { config: { model: 'gpt-5.4', model_provider: 'openai', approval_policy: 'on-request', sandbox_mode: 'workspace-write' }, layers: [] };
    case 'model/list': return { data: [{ id: 'gpt-5.4', model: 'gpt-5.4', displayName: 'GPT-5.4', modelProvider: 'openai', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'medium', description: 'Medium' }], defaultReasoningEffort: 'medium', serviceTiers: [{ id: 'fast', name: 'Fast', description: 'Priority speed' }], defaultServiceTier: null }], nextCursor: null };
    case 'account/read': return { account: { type: 'chatgpt', email: 'qa@example.invalid', planType: 'pro' }, requiresOpenaiAuth: true };
    case 'account/rateLimits/read': return { rateLimits: { limitId: 'codex', limitName: 'Codex', primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 34, windowDurationMins: 10080, resetsAt: 1800000000 } } };
    case 'account/usage/read': return { summary: { lifetimeTokens: 987654, peakDailyTokens: 1234, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null }, dailyUsageBuckets: [{ startDate: new Date().toISOString().slice(0, 10), tokens: 1234 }] };
    case 'permissionProfile/list': return { data: [{ id: 'read-only', description: 'Read-only workspace' }, { id: 'workspace-write', description: 'Workspace writes' }], nextCursor: null };
    case 'configRequirements/read': return { requirements: null };
    case 'collaborationMode/list': return { data: [{ name: 'Plan', mode: 'plan', model: 'gpt-5.4', reasoning_effort: 'medium' }, { name: 'Default', mode: 'default', model: 'gpt-5.4', reasoning_effort: 'medium' }] };
    case 'thread/goal/get': return { goal: null };
    case 'fs/readDirectory': return { entries: [] };
    case 'fs/readFile': return { content: '', encoding: 'utf8', type: 'text' };
    case 'modelProvider/capabilities/read': return { namespaceTools: false, imageGeneration: false, webSearch: false };
    case 'vcs/getInfo': return { root: '/qa/workspace', worktreeRoot: '/qa/workspace', branch: 'qa' };
    case 'skills/list': case 'plugin/list': case 'mcpServer/list': case 'app/list': case 'experimentalFeature/list': case 'thread/loaded/list': return { data: [], nextCursor: null };
    default: return {};
  }
}
function installSocket(route) {
  socket = route;
  route.onMessage(raw => {
    const message = JSON.parse(typeof raw === 'string' ? raw : raw.toString());
    rpc.push(message);
    if (message.id !== undefined) route.send(JSON.stringify({ id: message.id, result: result(message) }));
  });
}
async function http(route) {
  const pathname = new URL(route.request().url()).pathname;
  await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(pathname.endsWith('/homedir') ? { home: '/qa' } : pathname.endsWith('/fs/capabilities') ? { writable: false } : {}) });
}
async function icon(route) {
  const url = new URL(route.request().url());
  const icons = Object.fromEntries((url.searchParams.get('icons') ?? '').split(',').filter(Boolean).map(name => [name, { body: '<path d="M4 12h16M12 4v16" stroke="currentColor"/>' }]));
  await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ prefix: path.basename(url.pathname, '.json'), width: 24, height: 24, icons }) });
}
async function waitUntil(predicate, label) {
  const deadline = Date.now() + 10000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timed out: ${label}`); await new Promise(resolve => setTimeout(resolve, 50)); }
}
await runBrowserQa({ name: 'Codex slash commands through real App', evidenceDir: evidence, httpRoutes: [{ url: `${bridge}/**`, handler: http }, { url: 'https://api.iconify.design/**', handler: icon }], webSocketRoutes: [{ url: `${ws}**`, handler: installSocket }] }, async ({ page, baseUrl, evidenceDir, pageErrors, consoleEntries, context }) => {
  const screenshot = async name => { await page.waitForTimeout(250); return page.screenshot({ path: path.join(evidenceDir, `${name}.png`), fullPage: true }); };
  const send = async text => { await page.locator('.input-textarea').fill(text); await page.locator('.input-button.primary.send-button').click(); };
  const closeStatus = async () => page.locator('.status-monitor-close-button').click();
  const selectThread = async name => {
    await page.locator('.tree-dropdown-root .ui-dropdown-button').click();
    await page.getByRole('option').filter({ hasText: name }).click();
    await page.getByText(name, { exact: true }).first().waitFor();
  };
  const pass = name => observables.push({ name, passed: true });
  try {
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /Codex/i }).click();
    await page.locator('input[name="codexBridgeUrl"]').fill(ws);
    await page.locator('.app-loading-connect').click();
    await page.locator('.app-header').waitFor({ timeout: 30000 });
    await page.locator('.tree-dropdown-root .ui-dropdown-button').click();
    await page.getByRole('option').filter({ hasText: parent.name }).click();
    await page.getByText('Slash browser history', { exact: true }).waitFor();
    await page.locator('.side-toggle-inline').click();
    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.locator('.input-textarea').fill('/');
      await page.locator('.mention-popup .dropdown-list').waitFor();
      const menu = await page.locator('.mention-popup').innerText();
      for (const excluded of ['/theme', '/mention', '/statusline', '/keymap', '/agent', '/subagent']) assert.ok(!menu.includes(excluded));
      const box = await page.locator('.mention-popup').boundingBox();
      assert.ok(box && box.x >= -2 && box.x + box.width <= width + 2, JSON.stringify(box));
      await screenshot(`menu-${width}`);
    }
    await page.locator('.input-textarea').fill('');
    pass('responsive command menu excludes appearance and mention');
    for (const command of ['status', 'usage', 'skills', 'mcp', 'plugins']) {
      const count = requests('turn/start').length;
      await send(`/${command}`);
      await page.locator('.status-monitor-close-button').waitFor();
      if (command === 'usage') {
        await page.locator('.account-token-usage').waitFor();
        await page.getByText('987,654', { exact: true }).waitFor();
        for (const width of [375, 768, 1280]) { await page.setViewportSize({ width, height: 900 }); await screenshot('token-' + width); }
        await page.locator('.status-monitor-tab').filter({ hasText: /^Codex$/ }).click();
        assert.equal(await page.locator('.account-token-usage').count(), 0);
        for (const width of [375, 768, 1280]) { await page.setViewportSize({ width, height: 900 }); await screenshot('quota-codex-' + width); }
      }
      assert.equal(requests('turn/start').length, count);
      await closeStatus();
      pass(`/${command} is local; usage and quota tab routing`);
    }
    let count = requests('turn/start').length;
    await send('/model');
    await page.locator('.model-picker').waitFor();
    assert.equal(requests('turn/start').length, count);
    await page.locator('.model-dropdown-name').filter({ hasText: 'GPT-5.4' }).click();
    pass('/model opens real model picker without a turn');
    await send('/permissions');
    const permissions = page.locator('[data-floating-key="codex-command-permissions"]');
    await permissions.waitFor();
    assert.equal(requests('turn/start').length, count);
    await permissions.locator('.command-option').filter({ hasText: 'Read only' }).click();
    await permissions.locator('.command-option[aria-pressed="true"]').waitFor();
    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(250);
      const box = await permissions.boundingBox();
      assert.ok(box && box.x >= -2 && box.x + box.width <= width + 2, 'Permission panel outside viewport: ' + JSON.stringify(box));
      await screenshot('permissions-' + width);
    }
    await permissions.locator('.close-btn').click();
    pass('/permissions picker selects read-only without a turn');
    assert.match(await page.locator('.codex-composer-fast').innerText(), /Off/);
    await send('/fast');
    await waitUntil(() => requests('config/value/write').some(request => request.params.keyPath === 'service_tier' && request.params.value === 'fast'), 'fast config persistence');
    assert.equal(requests('turn/start').length, count);
    await page.locator('.codex-composer-fast.is-active').waitFor();
    assert.match(await page.locator('.codex-composer-fast').innerText(), /On/);
    await page.locator('.input-textarea').fill('Preserve this draft');
    await page.locator('.codex-composer-fast').click();
    await page.locator('.codex-composer-fast[aria-pressed="false"]').waitFor();
    assert.equal(await page.locator('.input-textarea').inputValue(), 'Preserve this draft');
    await page.locator('.codex-composer-fast').press('Enter');
    await page.locator('.codex-composer-fast[aria-pressed="true"]').waitFor();
    assert.equal(await page.locator('.input-textarea').inputValue(), 'Preserve this draft');
    await page.locator('.input-textarea').fill('');
    pass('Fast click and keyboard toggle preserve the message draft');
    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await screenshot('fast-on-' + width);
      const order = await page.locator('.codex-composer-fast').evaluate(element => ({ before: element.previousElementSibling?.className, after: element.nextElementSibling?.className }));
      assert.match(order.before, /input-field compact/);
      assert.equal(order.after, 'codex-composer-goal');
    }
    await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'opencode.settings.locale.v1', newValue: 'zh-CN' })));
    assert.match(await page.locator('.codex-composer-fast').innerText(), /开启/);
    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await screenshot('fast-on-zh-' + width);
    }
    await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'opencode.settings.locale.v1', newValue: 'en' })));
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await send('/copy');
    await waitUntil(() => requests('turn/start').length === count, 'copy remains local');
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Main thread answer');
    for (const command of ['resume']) {
      await send('/' + command);
      await page.getByRole('option').filter({ hasText: parent.name }).waitFor();
      await page.keyboard.press('Escape');
    }
    await send('/goal Browser goal');
    await waitUntil(() => requests('thread/goal/set').length > 0, 'goal set');
    await page.locator('[data-floating-key="codex-thread-goal"] .close-btn').click();
    await send('/compact');
    await waitUntil(() => requests('thread/compact/start').length > 0, 'context compaction');
    await send('/ps');
    await page.locator('[data-floating-key="codex-command-terminals"]').waitFor();
    await page.locator('[data-floating-key="codex-command-terminals"] .close-btn').click();
    await send('/stop');
    await waitUntil(() => requests('thread/backgroundTerminals/clean').length > 0, 'background cleanup');
    await send('/diff');
    await page.locator('[data-floating-key="git-diff:all"]').getByText('qa.txt', { exact: true }).first().waitFor();
    await screenshot('diff-1280');
    await page.locator('[data-floating-key="git-diff:all"] .close-btn').click();
    pass('/diff opens real diff viewer from command/exec snapshot');
    await send('/review');
    await waitUntil(() => requests('review/start').length > 0, 'review');
    assert.deepEqual(requests('review/start').at(-1).params.target, { type: 'uncommittedChanges' });
    assert.equal(requests('turn/start').length, count);
    const reviewCard = page.locator('.thread-block').filter({ hasText: 'Review current changes' });
    await reviewCard.waitFor();
    await page.locator('.input-button.stop.send-button').waitFor();
    socket.send(JSON.stringify({ method: 'item/started', params: { threadId: parent.id, turnId: 'review-turn', item: { id: 'review-command', type: 'commandExecution', command: 'git diff', cwd: parent.cwd, status: 'inProgress' } } }));
    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await screenshot('review-running-' + width);
    }
    const reviewTurn = threads.get(parent.id).turns.find(turn => turn.id === 'review-turn');
    const reviewAnswer = { id: 'review-answer', type: 'agentMessage', text: 'Review completed: no issues found.' };
    reviewTurn.status = 'completed';
    reviewTurn.items.push(reviewAnswer);
    socket.send(JSON.stringify({ method: 'item/completed', params: { threadId: parent.id, turnId: 'review-turn', item: { id: 'review-command', type: 'commandExecution', command: 'git diff', status: 'completed', exitCode: 0, aggregatedOutput: 'No changes' } } }));
    socket.send(JSON.stringify({ method: 'item/completed', params: { threadId: parent.id, turnId: 'review-turn', item: reviewAnswer } }));
    socket.send(JSON.stringify({ method: 'item/completed', params: { threadId: parent.id, turnId: 'review-turn', item: { id: 'review-exit', type: 'exitedReviewMode', review: reviewAnswer.text } } }));
    socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId: parent.id, turn: reviewTurn } }));
    await reviewCard.getByText(reviewAnswer.text, { exact: true }).waitFor();
    await page.locator('.input-button.primary.send-button').waitFor();
    assert.equal(await page.locator('.thread-block').filter({ hasText: 'Slash browser history' }).getByText(reviewAnswer.text, { exact: true }).count(), 0);
    for (const close of await page.locator('[data-floating-key] .close-btn').all()) await close.click();
    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await screenshot('review-completed-' + width);
    }
    await reviewCard.locator('.ib-action-danger').click();
    await page.locator('.confirm-dialog-btn-confirm').click();
    await waitUntil(() => requests('thread/revert').length === 1, 'paginated review revert');
    assert.deepEqual(requests('thread/revert')[0].params, { threadId: parent.id, beforeTurnId: 'review-turn' });
    assert.equal(requests('thread/rollback').length, 0);
    await reviewCard.waitFor({ state: 'detached' });
    await page.getByText('Main thread answer', { exact: true }).waitFor();
    await page.locator('.codex-composer-goal .goal-summary').filter({ hasText: 'Set thread goal' }).waitFor();
    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await screenshot('review-reverted-' + width);
    }
    pass('Review Undo uses thread/revert for paginated history and retains the earlier turn');
    pass('/copy /resume /goal /compact /ps /stop /review dispatch locally or to dedicated RPC');
    await send('/init');
    await waitUntil(() => requests('turn/start').length > 0, 'official init turn');
    const official = await readFile('app/assets/codex/prompt_for_init_command.md', 'utf8');
    assert.equal(requests('turn/start').at(-1).params.input[0].text, official.trim());
    assert.equal(requests('turn/start').at(-1).params.serviceTier, 'fast');
    assert.equal(requests('turn/start').at(-1).params.approvalPolicy, 'on-request');
    assert.equal(requests('turn/start').at(-1).params.sandboxPolicy.type, 'readOnly');
    pass('/init sends exact official prompt asset with Fast and selected permissions');
    await send('/fast');
    await waitUntil(() => requests('config/value/write').some(request => request.params.keyPath === 'service_tier' && request.params.value === 'default'), 'fast toggle off');
    await page.locator('.codex-composer-fast:not(.is-active)').waitFor();
    assert.match(await page.locator('.codex-composer-fast').innerText(), /Off/);
    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await screenshot('fast-off-' + width);
    }
    pass('Fast indicator reflects on/off between reasoning effort and Goal');
    const planTurnCount = requests('turn/start').length;
    const modePicker = page.locator('.input-selects > .input-field:first-child .ui-dropdown-button');
    await send('/plan');
    await page.waitForFunction(() => document.querySelector('.input-selects > .input-field:first-child .ui-dropdown-button')?.textContent?.includes('Plan'));
    assert.equal(requests('turn/start').length, planTurnCount);
    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await screenshot('plan-on-' + width);
    }
    await send('/plan');
    await page.waitForFunction(() => document.querySelector('.input-selects > .input-field:first-child .ui-dropdown-button')?.textContent?.includes('Default'));
    assert.equal(requests('turn/start').length, planTurnCount);
    assert.match(await modePicker.innerText(), /Default/);
    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await screenshot('plan-off-' + width);
    }
    await send('/plan Inspect repository');
    await waitUntil(() => requests('turn/start').length > 1, 'plan turn');
    assert.equal(requests('turn/start').at(-1).params.collaborationMode.mode, 'plan');
    assert.equal(requests('turn/start').at(-1).params.serviceTier, 'default');
    pass('/plan toggles without a turn; inline task selects actual Plan collaboration mode');
    socket.send(JSON.stringify({ method: 'turn/started', params: { threadId: parent.id, turn: { id: 'main-running', status: 'inProgress', items: [] } } }));
    await send('/btw Side question');
    await waitUntil(() => requests('thread/fork').some(request => request.params.ephemeral), 'ephemeral side fork');
    await waitUntil(() => requests('turn/start').some(request => request.params.threadId.startsWith('fork-')), 'side turn');
    assert.match(await page.locator('.selected-title').first().innerText(), /Slash QA Parent/);
    const sideThread = requests('thread/fork').at(-1);
    assert.equal(sideThread.params.threadId, parent.id);
    const sideId = requests('turn/start').at(-1).params.threadId;
    socket.send(JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: sideId, turnId: 'side-turn', itemId: 'side-answer', delta: 'Side answer only' } }));
    await page.getByText('Side answer only', { exact: true }).waitFor();
    for (const width of [375, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(250);
      const box = await page.locator('[data-floating-key="codex-command-side"]').boundingBox();
      assert.ok(box && box.x >= -2 && box.x + box.width <= width + 2, 'Side panel outside viewport: ' + JSON.stringify(box));
      await screenshot('side-' + width);
    }
    await page.locator('[data-floating-key="codex-command-side"] .close-btn').click();
    await waitUntil(() => requests('thread/unsubscribe').some(request => request.params.threadId === sideId), 'side unsubscribe');
    assert.ok(requests('turn/interrupt').some(request => request.params.threadId === sideId));
    assert.ok(!requests('turn/interrupt').some(request => request.params.threadId === parent.id));
    socket.send(JSON.stringify({ method: 'turn/completed', params: { threadId: parent.id, turn: { id: 'main-running', status: 'completed', items: [] } } }));
    await send('/fork');
    await waitUntil(() => requests('thread/fork').some(request => !request.params.ephemeral), 'persistent fork');
    await page.getByText('Fork QA', { exact: true }).first().waitFor();
    await selectThread(parent.name);
    assert.equal(await page.locator('.input-textarea').inputValue(), '');
    await selectThread('Fork QA');
    pass('/fork selects persistent conversation; closing side unsubscribes only side');
    pass('/btw preserves main thread and displays side response');
    await send('/rename Renamed QA');
    await waitUntil(() => requests('thread/name/set').some(request => request.params.name === 'Renamed QA'), 'rename');
    await send('/new');
    await waitUntil(() => requests('thread/start').length > 0, 'new thread');
    await page.getByText('New QA', { exact: true }).first().waitFor();
    await selectThread('Renamed QA');
    assert.equal(await page.locator('.input-textarea').inputValue(), '');
    await selectThread('New QA');
    pass('/fork and /new clear the original session command draft before navigation');
    await send('/archive');
    await waitUntil(() => requests('thread/archive').length > 0, 'archive');
    pass('/rename /new /archive use conversation lifecycle RPC');
    count = requests('turn/start').length;
    await send('/not-a-command');
    await page.waitForTimeout(150);
    assert.equal(requests('turn/start').length, count);
    pass('unsupported slash command never leaks to model');
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(consoleEntries.filter(entry => entry.type === 'error'), []);
  } finally {
    await screenshot('final');
    await Promise.all([writeFile(path.join(evidenceDir, 'rpc-wire.json'), JSON.stringify(rpc, null, 2)), writeFile(path.join(evidenceDir, 'observables.json'), JSON.stringify(observables, null, 2)), writeFile(path.join(evidenceDir, 'final-dom.txt'), await page.locator('body').innerText())]);
  }
});
console.log(`PASS ${observables.length} Codex slash browser observations`);

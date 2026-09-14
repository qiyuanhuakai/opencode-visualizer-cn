#!/usr/bin/env node
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runBrowserQa } from './test-contracts-support.mjs';

const BRIDGE_HTTP = 'http://127.0.0.1:51999';
const BRIDGE_WS = 'ws://127.0.0.1:51999/codex';
const PARENT_THREAD = 'qa-parent';
const OTHER_PARENT = 'qa-other-parent';
const CHILD_ONE = 'qa-child-one';
const CHILD_TWO = 'qa-child-two';
const HISTORY_CHILD = 'qa-history-child';
const CATCHUP_CHILD = 'qa-catchup-child';
const EVIDENCE_DIR = '.omo/evidence/test-suite-organization/task-23/browser';

const rpcLog = [];
const httpLog = [];
let socket;
let waiterSequence = 0;
const requestWaiters = new Map();
const childResumeCounts = new Map();

const threads = {
  [OTHER_PARENT]: {
    id: OTHER_PARENT,
    name: 'QA Other Parent',
    cwd: '/qa/other',
    modelProvider: 'qa-local',
    model: 'fixture-model',
    status: { type: 'idle' },
    createdAt: 1,
    updatedAt: 1,
    turns: [{ id: 'other-history', status: 'completed', items: [
      { id: 'other-user', type: 'userMessage', content: [{ type: 'text', text: 'Other parent history' }] },
      { id: 'other-answer', type: 'agentMessage', text: 'Other parent answer' },
    ] }],
  },
  [PARENT_THREAD]: {
    id: PARENT_THREAD,
    name: 'QA Parent Session',
    cwd: '/qa/workspace',
    modelProvider: 'qa-local',
    model: 'fixture-model',
    status: { type: 'idle' },
    createdAt: 2,
    updatedAt: 2,
    turns: [{ id: 'parent-history', status: 'completed', items: [
      { id: 'parent-user', type: 'userMessage', content: [{ type: 'text', text: 'Parent browser history' }] },
      { id: 'parent-answer', type: 'agentMessage', text: 'Parent history answer' },
      {
        id: 'historical-spawn',
        type: 'subAgentActivity',
        kind: 'completed',
        agentThreadId: HISTORY_CHILD,
        agentPath: '/root/history_agent',
      },
    ] }],
  },
  [CHILD_ONE]: childThread(CHILD_ONE, 'review_agent'),
  [CHILD_TWO]: childThread(CHILD_TWO, 'shell_agent'),
  [HISTORY_CHILD]: childThread(HISTORY_CHILD, 'history_agent', {
    status: { type: 'idle' },
    turns: [{ id: 'historical-child-turn', status: 'completed', items: [
      { id: 'historical-child-answer', type: 'agentMessage', text: 'HISTORY_MUST_STAY_QUIET' },
    ] }],
  }),
  [CATCHUP_CHILD]: childThread(CATCHUP_CHILD, 'catchup_agent'),
};

function childThread(id, agent, overrides = {}) {
  return {
    id,
    name: `QA ${agent}`,
    cwd: '/qa/workspace',
    modelProvider: 'qa-local',
    model: 'fixture-model',
    source: { subAgent: { thread_spawn: { parent_thread_id: PARENT_THREAD, agent_nickname: agent } } },
    parentThreadId: PARENT_THREAD,
    status: { type: 'active' },
    turns: [],
    ...overrides,
  };
}

function notify(method, params) {
  assert.ok(socket, `Cannot send ${method} before the Codex WebSocket is connected.`);
  const message = { method, params };
  rpcLog.push({ direction: 'server-to-client', message, time: new Date().toISOString() });
  socket.send(JSON.stringify(message));
}

function signalRequest(message) {
  for (const [key, waiter] of requestWaiters) {
    if (waiter.method !== message.method || !waiter.predicate(message)) continue;
    requestWaiters.delete(key);
    waiter.resolve(message);
  }
}

function waitForRequest(method, predicate = () => true, timeoutMs = 10_000) {
  const previous = rpcLog.find((entry) =>
    entry.direction === 'client-to-server' && entry.message.method === method && predicate(entry.message));
  if (previous) return Promise.resolve(previous.message);
  const key = ++waiterSequence;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      requestWaiters.delete(key);
      reject(new Error(`Timed out waiting for RPC request ${method}.`));
    }, timeoutMs);
    requestWaiters.set(key, {
      method,
      predicate,
      resolve(message) {
        clearTimeout(timeout);
        resolve(message);
      },
    });
  });
}

function listResult() {
  return { data: [], nextCursor: null };
}

function threadSummary(value) {
  const summary = { ...value };
  delete summary.turns;
  return summary;
}

function rpcResult(message) {
  const params = message.params ?? {};
  switch (message.method) {
    case 'initialize':
      return { userAgent: 'codex-app-server/qa-fixture', platformFamily: 'linux', platformOs: 'linux' };
    case 'thread/list':
      return { data: [threads[OTHER_PARENT], threads[PARENT_THREAD]].map(threadSummary), nextCursor: null };
    case 'thread/read': {
      const threadId = params.threadId;
      if (threadId === CATCHUP_CHILD && (childResumeCounts.get(threadId) ?? 0) === 0) {
        return { thread: { ...threads[threadId], turns: [] } };
      }
      return { thread: threads[threadId] ?? { id: threadId, turns: [] } };
    }
    case 'thread/resume': {
      const threadId = params.threadId;
      childResumeCounts.set(threadId, (childResumeCounts.get(threadId) ?? 0) + 1);
      if (threadId === CATCHUP_CHILD) {
        return { thread: { ...threads[threadId], turns: [{
          id: 'catchup-turn',
          status: 'inProgress',
          items: [{ id: 'catchup-answer', type: 'agentMessage', text: 'CATCHUP_VISIBLE_FROM_RESUME' }],
        }] } };
      }
      return { thread: threads[threadId] ?? { id: threadId, turns: [] } };
    }
    case 'thread/turns/list':
      return { data: threads[params.threadId]?.turns ?? [], nextCursor: null };
    case 'fs/readDirectory':
      return { entries: [] };
    case 'fs/readFile':
      return { content: '', encoding: 'utf8', type: 'text' };
    case 'config/read':
      return { config: { model: 'fixture-model', model_provider: 'qa-local' }, layers: [] };
    case 'model/list':
      return { data: [{ id: 'fixture-model', model: 'fixture-model', displayName: 'QA Fixture Model', modelProvider: 'qa-local', supportedReasoningEfforts: [] }], nextCursor: null };
    case 'account/read':
      return { account: null, requiresOpenaiAuth: false };
    case 'account/rateLimits/read':
      return { rateLimits: null };
    case 'collaborationMode/list':
    case 'skills/list':
    case 'plugin/list':
    case 'mcpServer/list':
    case 'app/list':
    case 'experimentalFeature/list':
    case 'thread/loaded/list':
    case 'permissionProfile/list':
      return listResult();
    case 'configRequirements/read':
      return { requirements: null };
    case 'modelProvider/capabilities/read':
      return { namespaceTools: false, imageGeneration: false, webSearch: false };
    case 'thread/goal/get':
      return { goal: null };
    case 'thread/unsubscribe':
      return {};
    case 'vcs/getInfo':
      return { root: '/qa/workspace', worktreeRoot: '/qa/workspace', branch: 'qa' };
    default:
      return {};
  }
}

function installWebSocket(route) {
  socket = route;
  route.onMessage((raw) => {
    const text = typeof raw === 'string' ? raw : raw.toString();
    const message = JSON.parse(text);
    rpcLog.push({ direction: 'client-to-server', message, time: new Date().toISOString() });
    signalRequest(message);
    if (message.id === undefined) return;
    route.send(JSON.stringify({ id: message.id, result: rpcResult(message) }));
  });
}

async function installHttp(route) {
  const request = route.request();
  const url = new URL(request.url());
  httpLog.push({ method: request.method(), path: url.pathname, search: url.search });
  const body = url.pathname.endsWith('/homedir')
    ? { home: '/qa' }
    : url.pathname.endsWith('/fs/capabilities')
      ? { writable: false }
      : {};
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  });
}

async function installIconify(route) {
  const url = new URL(route.request().url());
  const prefix = path.basename(url.pathname, '.json');
  const names = (url.searchParams.get('icons') ?? '').split(',').filter(Boolean);
  const icons = Object.fromEntries(names.map((name) => [name, { body: '<path d="" />' }]));
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify({ prefix, width: 24, height: 24, icons }),
  });
}

function discoverChild(childId, itemId, agentPath) {
  notify('item/started', {
    threadId: PARENT_THREAD,
    turnId: 'parent-live-turn',
    item: {
      id: itemId,
      type: 'subAgentActivity',
      kind: 'started',
      agentThreadId: childId,
      agentPath,
    },
  });
}

function childDelta(childId, itemId, delta) {
  notify('item/agentMessage/delta', {
    threadId: childId,
    turnId: `${childId}-turn`,
    itemId,
    delta,
  });
}

async function setSuppressAutoWindows(page, value) {
  await page.evaluate((suppressed) => {
    const key = 'opencode.settings.suppressAutoWindows.v1';
    localStorage.setItem(key, String(suppressed));
    window.dispatchEvent(new StorageEvent('storage', { key, newValue: String(suppressed) }));
  }, value);
}

const observables = [];
function passed(name, details) {
  observables.push({ name, passed: true, details });
}

await runBrowserQa({
  name: 'Task 23 Codex popup chain',
  evidenceDir: EVIDENCE_DIR,
  httpRoutes: [
    { url: `${BRIDGE_HTTP}/**`, handler: installHttp },
    { url: 'https://api.iconify.design/**', handler: installIconify },
  ],
  webSocketRoutes: [{ url: `${BRIDGE_WS}**`, handler: installWebSocket }],
}, async ({ baseUrl, page, evidenceDir, consoleEntries, pageErrors }) => {
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: /Codex/i }).click();
  await page.locator('input[name="codexBridgeUrl"]').fill(BRIDGE_WS);
  await page.locator('.app-loading-connect').click();
  await page.locator('.app-header').waitFor({ state: 'visible', timeout: 30_000 });
  passed('real App login', `Connected through ${BRIDGE_WS} and rendered the ready application shell.`);

  await page.locator('.tree-dropdown-root .ui-dropdown-button').click();
  await page.getByText('QA Parent Session', { exact: true }).click();
  await page.getByText('Parent browser history', { exact: true }).waitFor();
  assert.match(await page.locator('.selected-title').first().innerText(), /QA Parent Session/);
  passed('real session selection', 'Selected QA Parent Session through the rendered TopPanel dropdown.');

  assert.equal(await page.getByText('HISTORY_MUST_STAY_QUIET', { exact: true }).count(), 0);
  assert.equal(await page.locator(`[data-floating-key="subagent:${HISTORY_CHILD}"]`).count(), 0);
  passed('history quiet', 'A historical child was discovered and read without replaying its old answer into a popup.');

  discoverChild(CHILD_ONE, 'spawn-one', '/root/review_agent');
  await waitForRequest('thread/resume', (message) => message.params?.threadId === CHILD_ONE);
  childDelta(CHILD_ONE, 'answer-one', 'CHILD_ONE_FIRST');
  const childOneWindow = page.locator(`[data-floating-key="subagent:${CHILD_ONE}"]`);
  await childOneWindow.getByText('CHILD_ONE_FIRST', { exact: true }).waitFor();
  assert.equal(await childOneWindow.count(), 1);
  passed('first child message visible', 'The first child delta opened one visible child-one window.');

  childDelta(CHILD_ONE, 'answer-one', ' + CHILD_ONE_APPEND');
  await childOneWindow.getByText('CHILD_ONE_FIRST + CHILD_ONE_APPEND', { exact: true }).waitFor();
  assert.equal(await childOneWindow.count(), 1);
  passed('append keeps window identity', 'The second delta appended inside the same child-one window.');

  discoverChild(CHILD_TWO, 'spawn-two', '/root/shell_agent');
  await waitForRequest('thread/resume', (message) => message.params?.threadId === CHILD_TWO);
  childDelta(CHILD_TWO, 'answer-two', 'CHILD_TWO_VISIBLE');
  const childTwoWindow = page.locator(`[data-floating-key="subagent:${CHILD_TWO}"]`);
  await childTwoWindow.getByText('CHILD_TWO_VISIBLE', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-floating-key^="subagent:qa-child-"]').count(), 2);
  passed('two child windows', 'Child one and child two have distinct visible data-floating-key identities.');

  notify('item/reasoning/summaryTextDelta', {
    threadId: CHILD_ONE,
    turnId: `${CHILD_ONE}-turn`,
    itemId: 'reasoning-one',
    summaryIndex: 0,
    delta: 'REASONING_VISIBLE_CONTENT',
  });
  const reasoningWindow = page.locator(`[data-floating-key="reasoning:${CHILD_ONE}"]`);
  await reasoningWindow.getByText('REASONING_VISIBLE_CONTENT', { exact: true }).waitFor();
  passed('reasoning content', 'Child reasoning text rendered in the child-specific reasoning window.');

  notify('item/started', {
    threadId: CHILD_TWO,
    turnId: `${CHILD_TWO}-turn`,
    item: { id: 'shell-two', type: 'commandExecution', command: 'printf qa', cwd: '/qa/workspace' },
  });
  notify('item/commandExecution/outputDelta', {
    threadId: CHILD_TWO,
    turnId: `${CHILD_TWO}-turn`,
    itemId: 'shell-two',
    delta: 'SHELL_VISIBLE_OUTPUT',
  });
  const shellWindow = page.locator(`[data-floating-key="${CHILD_TWO}:shell-two"]`);
  await shellWindow.getByText('SHELL_VISIBLE_OUTPUT', { exact: true }).waitFor();
  passed('shell content', 'Child command output rendered in the child-specific shell window.');

  discoverChild(CATCHUP_CHILD, 'spawn-catchup', '/root/catchup_agent');
  await waitForRequest('thread/resume', (message) => message.params?.threadId === CATCHUP_CHILD);
  const catchupWindow = page.locator(`[data-floating-key="subagent:${CATCHUP_CHILD}"]`);
  await catchupWindow.getByText('CATCHUP_VISIBLE_FROM_RESUME', { exact: true }).waitFor();
  passed('empty-read resume catchup', 'An empty child read followed by a populated resume surfaced the latest child message.');

  const focusedScreenshots = [
    ['02-child-one.png', childOneWindow],
    ['03-child-two.png', childTwoWindow],
    ['04-reasoning.png', reasoningWindow],
    ['05-shell.png', shellWindow],
    ['06-resume-catchup.png', catchupWindow],
  ];
  for (const [fileName, window] of focusedScreenshots) {
    const previousZIndex = await window.evaluate((element) => element.style.zIndex);
    await window.evaluate((element) => {
      element.style.zIndex = '2147483647';
    });
    await window.screenshot({ path: path.join(evidenceDir, fileName) });
    await window.evaluate((element, zIndex) => {
      element.style.zIndex = zIndex;
    }, previousZIndex);
  }
  await page.screenshot({ path: path.join(evidenceDir, '01-live-popups.png'), fullPage: true });

  notify('turn/completed', {
    threadId: CHILD_ONE,
    turnId: `${CHILD_ONE}-turn`,
    turn: { id: `${CHILD_ONE}-turn`, status: 'completed' },
  });
  await childOneWindow.waitFor({ state: 'detached', timeout: 5_000 });
  assert.equal(await childTwoWindow.count(), 1);
  passed('matching-only completion', 'Completing child one closed its popup after the product delay while child two remained visible.');

  await setSuppressAutoWindows(page, true);
  await childTwoWindow.waitFor({ state: 'detached' });
  childDelta(CHILD_TWO, 'answer-suppressed', 'SUPPRESSED_MUST_NOT_OPEN');
  await page.waitForTimeout(100);
  assert.equal(await page.getByText('SUPPRESSED_MUST_NOT_OPEN', { exact: true }).count(), 0);
  passed('suppress guard', 'Suppressing auto windows closed existing automatic popups and blocked a later child delta.');

  await setSuppressAutoWindows(page, false);
  childDelta(CHILD_TWO, 'answer-restored', 'WINDOWS_RESTORED');
  await childTwoWindow.getByText('WINDOWS_RESTORED', { exact: true }).waitFor();

  await page.locator('.tree-dropdown-root .ui-dropdown-button').click();
  await page.getByText('QA Other Parent', { exact: true }).click();
  await page.getByText('Other parent history', { exact: true }).waitFor();
  await childTwoWindow.waitFor({ state: 'detached' });
  childDelta(CHILD_TWO, 'answer-stale-parent', 'OLD_PARENT_MUST_NOT_OPEN');
  await page.waitForTimeout(100);
  assert.equal(await page.getByText('OLD_PARENT_MUST_NOT_OPEN', { exact: true }).count(), 0);
  assert.equal(await page.locator('[data-floating-key^="subagent:qa-child-"]').count(), 0);
  passed('parent guard', 'Selecting another parent reset old child windows and ignored later notifications from that child.');

  assert.deepEqual(pageErrors, []);
  const unexpectedConsoleErrors = consoleEntries.filter((entry) => entry.type === 'error');
  assert.deepEqual(unexpectedConsoleErrors, []);
  passed('runtime errors', 'No page errors or error-level browser console entries were recorded.');

  await page.screenshot({ path: path.join(evidenceDir, '07-parent-guard.png'), fullPage: true });
  await Promise.all([
    writeFile(path.join(evidenceDir, 'rpc-wire.json'), `${JSON.stringify(rpcLog, null, 2)}\n`, 'utf8'),
    writeFile(path.join(evidenceDir, 'http-wire.json'), `${JSON.stringify(httpLog, null, 2)}\n`, 'utf8'),
    writeFile(path.join(evidenceDir, 'observables.json'), `${JSON.stringify(observables, null, 2)}\n`, 'utf8'),
    writeFile(path.join(evidenceDir, 'screenshots.json'), `${JSON.stringify({
      inspectedSurfaces: [
        '01-live-popups.png: full live App with distinct popup identities',
        '02-child-one.png: first and appended child-one message',
        '03-child-two.png: independent child-two message',
        '04-reasoning.png: reasoning content',
        '05-shell.png: command and streamed shell output',
        '06-resume-catchup.png: resumed child catchup',
        '07-parent-guard.png: selected other parent with old child popups absent',
      ],
    }, null, 2)}\n`, 'utf8'),
    writeFile(path.join(evidenceDir, 'final-dom.txt'), await page.locator('body').innerText(), 'utf8'),
  ]);
});

console.log(`PASS: ${observables.length} Codex popup browser observables verified.`);
console.log(`Evidence: ${path.resolve(EVIDENCE_DIR)}`);

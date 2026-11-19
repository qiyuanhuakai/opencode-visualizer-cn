import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
import path from 'node:path';
import { summaryAt, wireAt } from '../../app/dev/runtime-v090/fixtures/inventory.mjs';

const kind = process.argv[2];
const root = process.env.VIS_PERF_ROOT;
const count = Number(process.env.VIS_PERF_COUNT);
const sourceIndex = kind === 'codex' ? 1 : 2;
const turns = new Map();
const rows = Array.from({ length: count / 5 }, (_, index) => {
  const summary = summaryAt(index * 5 + sourceIndex);
  const row = wireAt({ ...summary, workspace: summary.workspace ? path.join(root, summary.workspace) : null });
  if (kind === 'codex') row.status = { type: 'idle' };
  return row;
});
if (kind === 'codex' && process.env.VIS_QA_CODEX_HISTORY_WINDOW === '1') {
  turns.set(rows[0].id, ['older', 'latest'].map((label, turnIndex) => ({
    id: label, status: 'completed', startedAtMs: 1700000000000 + turnIndex * 10000, completedAtMs: 1700000009999 + turnIndex * 10000,
    items: Array.from({ length: label === 'latest' ? 206 : 2 }, (_, index) => index % 2 === 0
      ? { id: `${label}-${index}`, type: 'userMessage', content: [{ type: 'text', text: `CODEX-WINDOW-${label}-${index}` }] }
      : { id: `${label}-${index}`, type: 'agentMessage', text: `CODEX-WINDOW-${label}-${index}` }),
  })));
}
function threadStatus(threadId, type) {
  const thread = rows.find(row => row.id === threadId);
  if (thread) thread.status = { type };
}
appendFileSync(path.join(root, 'native-pids.jsonl'), `${JSON.stringify({ kind, pid: process.pid })}\n`);
const write = (value) => process.stdout.write(`${JSON.stringify(kind === 'acp' ? { jsonrpc: '2.0', ...value } : value)}\n`);
if (kind === 'codex' && process.env.VIS_QA_CODEX_EXTERNAL_THREAD) {
  let active = null;
  process.on('SIGUSR2', () => {
    const threadId = process.env.VIS_QA_CODEX_EXTERNAL_THREAD;
    if (!rows.some(row => row.id === threadId)) throw new Error('Unknown external fixture thread');
    if (!active) {
      threadStatus(threadId, 'active');
      active = { id: crypto.randomUUID(), status: 'inProgress', startedAtMs: Date.now(), completedAtMs: null, items: [{ id: crypto.randomUUID(), type: 'agentMessage', text: 'CONTROLLED-CODEX-EXTERNAL-RUNNING-20261021' }] };
      turns.set(threadId, [...(turns.get(threadId) ?? []), active]);
      write({ method: 'turn/started', params: { threadId, turn: { id: active.id, status: active.status } } });
    } else {
      threadStatus(threadId, 'idle');
      active.status = 'completed'; active.completedAtMs = Date.now();
      active.items[0].text = 'CONTROLLED-CODEX-EXTERNAL-COMPLETED-20261021';
      write({ method: 'item/completed', params: { threadId, turnId: active.id, item: active.items[0] } });
      write({ method: 'turn/completed', params: { threadId, turn: { id: active.id, status: active.status } } });
      active = null;
    }
  });
}
createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined || !message.method) return;
  const { id, method, params = {} } = message;
  appendFileSync(path.join(root, 'native-requests.jsonl'), `${JSON.stringify({ kind, pid: process.pid, method, params })}\n`);
  const reply = (result) => write({ id, result });
  if (method === 'initialize') {
    return reply(kind === 'codex'
      ? { userAgent: 'vis_runtime/0.160.0 (seed090 protocol fixture)' }
      : { protocolVersion: 1, agentInfo: { name: 'seed090-peer', version: '1' }, agentCapabilities: { loadSession: true, sessionCapabilities: { list: {}, resume: {} } }, authMethods: [] });
  }
  if (method === 'thread/list' || method === 'session/list') {
    const candidates = kind === 'codex' ? rows.filter((row) => row.archived === params.archived) : rows;
    const start = Number(params.cursor ?? 0);
    const limit = kind === 'codex' ? params.limit : 200;
    const selected = candidates.slice(start, start + limit);
    const next = start + selected.length < candidates.length ? String(start + selected.length) : null;
    return reply(kind === 'codex'
      ? { data: selected, nextCursor: next }
      : { sessions: selected, ...(next ? { nextCursor: next } : {}) });
  }
  if (['thread/read', 'thread/resume'].includes(method)) return reply({ thread: { ...rows.find((row) => row.id === params.threadId), turns: [] } });
  if (method === 'thread/turns/list') {
    const saved = turns.get(params.threadId) ?? [];
    const candidates = params.sortDirection === 'desc' ? saved.toReversed() : saved;
    const start = Number(params.cursor ?? 0), limit = params.limit ?? 1;
    return reply({ data: candidates.slice(start, start + limit).map(turn => ({ id: turn.id, status: turn.status, startedAtMs: turn.startedAtMs, completedAtMs: turn.completedAtMs, items: [] })), nextCursor: start + limit < candidates.length ? String(start + limit) : null });
  }
  if (method === 'thread/items/list') {
    const turn = (turns.get(params.threadId) ?? []).find(turn => turn.id === params.turnId);
    const start = Number(params.cursor ?? 0), limit = params.limit ?? 1;
    const saved = turn?.items ?? [];
    const items = params.sortDirection === 'desc' ? saved.toReversed() : saved;
    return reply({ data: items.slice(start, start + limit).map(item => ({ turnId: turn.id, startedAtMs: turn.startedAtMs, completedAtMs: turn.completedAtMs, item })), nextCursor: start + limit < items.length ? String(start + limit) : null });
  }
  if (method === 'turn/start') {
    threadStatus(params.threadId, 'active');
    const turn = { id: crypto.randomUUID(), status: 'inProgress', startedAtMs: Date.now(), completedAtMs: null, items: [{ id: crypto.randomUUID(), type: 'userMessage', content: params.input }, { id: crypto.randomUUID(), type: 'agentMessage', text: 'Controlled Codex protocol reply; no model inference.' }] };
    turns.set(params.threadId, [...(turns.get(params.threadId) ?? []), turn]);
    reply({ turn: { id: turn.id, status: turn.status, items: [] } });
    setImmediate(() => write({ method: 'turn/started', params: { threadId: params.threadId, turn: { id: turn.id, status: turn.status } } }));
    setTimeout(() => { turn.status = 'completed'; turn.completedAtMs = Date.now(); threadStatus(params.threadId, 'idle'); write({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: turn.id, status: turn.status } } }); }, 100);
    return;
  }
  if (method === 'thread/goal/get') return reply({ goal: null });
  if (['session/load', 'session/resume'].includes(method)) {
    write({ method: 'session/update', params: { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Seed090 selected native history.' } } } });
    return reply({});
  }
  if (method === 'model/list') return reply({ data: [{ id: 'seed-codex-model', model: 'seed-codex-model', displayName: 'Seed Codex model', isDefault: true, inputModalities: ['text', 'image'], supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Seed fast' }, { reasoningEffort: 'high', description: 'Seed deep' }] }], nextCursor: null });
  if (method === 'config/read') return reply({ config: { model_provider: 'openai', model: 'seed-codex-model' }, origins: {}, layers: [] });
  if (method === 'account/read') return reply({ account: null, requiresOpenaiAuth: false });
  return write({ id, error: { code: -32601, message: `Fixture has no ${method}` } });
});

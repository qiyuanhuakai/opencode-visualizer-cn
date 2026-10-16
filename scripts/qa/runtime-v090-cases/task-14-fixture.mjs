import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const root = process.env.VIS_QA_ROOT;
const threads = Array.from({ length: 65 }, (_, i) => ({
  id: `native-${i}`,
  cwd: root,
  preview: `thread ${i}`,
  createdAt: 100,
  updatedAt: 100,
  modelProvider: i % 3 ? 'openai' : 'custom',
  source: i % 5 ? 'cli' : 'exec',
  archived: i >= 58,
}));
const emit = (message) => {
  appendFileSync(process.env.VIS_QA_WIRE, `${JSON.stringify({ direction: 'native', message })}\n`);
  process.stdout.write(`${JSON.stringify(message)}\n`);
};
const notify = (method, params) => emit({ method, params });
const pending = new Map();
let serial = 0;
const terminal = (threadId, turnId, status = 'completed') =>
  notify('turn/completed', { threadId, turn: { id: turnId, status } });
const input = createInterface({ input: process.stdin });
input.on('line', (raw) => {
  const message = JSON.parse(raw);
  appendFileSync(process.env.VIS_QA_WIRE, `${JSON.stringify({ direction: 'client', message })}\n`);
  if (!message.method) {
    const waiting = pending.get(message.id);
    pending.delete(message.id);
    if (waiting?.stage === 'permission') {
      pending.set(9002, { ...waiting, stage: 'elicitation' });
      emit({
        id: 9002,
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: waiting.threadId,
          turnId: waiting.turnId,
          serverName: 'qa',
          mode: 'form',
          message: 'choose',
          requestedSchema: { type: 'object', properties: { choice: { type: 'string' } } },
        },
      });
    } else if (waiting) terminal(waiting.threadId, waiting.turnId);
    return;
  }
  const { id, method, params: p = {} } = message;
  if (id === undefined) return;
  const reply = (result) => emit({ id, result });
  switch (method) {
    case 'initialize':
      reply({ userAgent: 'vis_runtime/0.160.0 (fixture)' });
      break;
    case 'thread/list': {
      const rows = threads.filter((t) => t.archived === p.archived);
      const start = Number(p.cursor ?? 0);
      reply({
        data: rows.slice(start, start + p.limit),
        nextCursor: start + p.limit < rows.length ? String(start + p.limit) : null,
      });
      break;
    }
    case 'thread/read':
      reply({ thread: threads.find((t) => t.id === p.threadId) });
      break;
    case 'thread/resume':
      if (p.threadId.startsWith('created-') || p.threadId.startsWith('forked-'))
        emit({ id, error: { code: -32600, message: 'fresh thread already loaded' } });
      else reply({ thread: threads.find((t) => t.id === p.threadId) });
      break;
    case 'thread/fork': {
      const thread = {
        ...threads.find((t) => t.id === p.threadId),
        id: `forked-${++serial}`,
        archived: false,
      };
      threads.push(thread);
      reply({ thread });
      break;
    }
    case 'thread/start': {
      const thread = { ...threads[0], id: `created-${++serial}`, ...p, archived: false };
      threads.push(thread);
      reply({ thread });
      break;
    }
    case 'thread/turns/list': {
      const turns = [
        { id: 't1', status: 'completed', items: [] },
        { id: 't2', status: 'completed', items: [] },
      ];
      const n = Number(p.cursor ?? 0);
      reply({ data: turns.slice(n, n + 1), nextCursor: n === 0 ? '1' : null });
      break;
    }
    case 'thread/items/list': {
      const items =
        p.turnId === 't1'
          ? [
              { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'question' }] },
              { id: 'a1', type: 'agentMessage', text: 'answer' },
            ]
          : [
              {
                id: 'tool',
                type: 'commandExecution',
                command: 'ls',
                aggregatedOutput: 'file',
                status: 'completed',
              },
            ];
      const n = Number(p.cursor ?? 0);
      reply({
        data: items
          .slice(n, n + 1)
          .map((item) => ({ turnId: p.turnId, item, startedAtMs: 100, completedAtMs: 101 })),
        nextCursor: n + 1 < items.length ? String(n + 1) : null,
      });
      break;
    }
    case 'turn/start': {
      const turnId = `turn-${++serial}`;
      notify('turn/started', { threadId: p.threadId, turn: { id: turnId, status: 'inProgress' } });
      reply({ turn: { id: turnId, status: 'inProgress', items: [] } });
      const mode = p.input[0].text;
      if (mode === 'interactions') {
        pending.set(9001, { threadId: p.threadId, turnId, stage: 'permission' });
        emit({
          id: 9001,
          method: 'item/commandExecution/requestApproval',
          params: { threadId: p.threadId, turnId, itemId: 'tool', command: 'ls' },
        });
      } else if (mode === 'error') setTimeout(() => terminal(p.threadId, turnId, 'failed'), 20);
      else if (mode !== 'hold') setTimeout(() => terminal(p.threadId, turnId), 20);
      break;
    }
    case 'turn/interrupt':
      reply({});
      terminal(p.threadId, p.turnId, 'interrupted');
      break;
    case 'turn/steer':
      reply({ turnId: p.expectedTurnId });
      break;
    case 'thread/archive':
    case 'thread/unarchive': {
      const thread = threads.find((t) => t.id === p.threadId);
      thread.archived = method === 'thread/archive';
      reply({});
      notify(thread.archived ? 'thread/archived' : 'thread/unarchived', { threadId: p.threadId });
      break;
    }
    case 'thread/delete': {
      const i = threads.findIndex((t) => t.id === p.threadId);
      threads.splice(i, 1);
      reply({});
      notify('thread/deleted', { threadId: p.threadId });
      break;
    }
    case 'qa/late':
      reply({});
      notify('thread/tokenUsage/updated', p);
      break;
    default:
      emit({ id, error: { code: -32601, message: 'unsupported controlled protocol' } });
  }
});

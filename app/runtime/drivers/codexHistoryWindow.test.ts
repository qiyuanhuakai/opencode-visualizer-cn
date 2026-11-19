// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createCodexHistoryStream } from '../../../bridge/runtime/drivers/codexHistory.js';
import { createHistoryDiskBudget, createHistoryStream } from '../../../bridge/runtime/historyStream.js';
import { createAppServerClient } from '../../../shared/runtime/native/codex/appServerClient.js';
import { parseSessionRef } from '../../../shared/runtime/identity.js';
import type { JsonValue } from '../../../shared/runtime/capabilities.js';

it('opens the latest turn with a bounded newest-item window and continues into older turns without full thread reads', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vis-codex-latest-'));
  const store = createHistoryStream({ scope: 'latest-window', globalDisk: createHistoryDiskBudget(), createDirectory: () => mkdtemp(path.join(root, 'spool-')) });
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const turns = ['older', 'latest'];
  const request = vi.fn(async (method: string, input: JsonValue) => {
    const params = input as Record<string, unknown>;
    calls.push({ method, params });
    if (method !== 'thread/turns/list') throw new Error('Unexpected full-thread or native query');
    const ordered = params.sortDirection === 'desc' ? turns.toReversed() : turns;
    const index = params.cursor === null ? 0 : Number(params.cursor);
    return { data: [{ id: ordered[index]!, items: [], status: 'completed' }], nextCursor: index + 1 < ordered.length ? String(index + 1) : null };
  });
  const client = createAppServerClient({ transport: {
    subscribe: () => () => {}, send() {}, close() {},
    requestRaw(raw: string, id: number) {
      const { method, params } = JSON.parse(raw) as { method: string; params: Record<string, unknown> };
      calls.push({ method, params });
      const rows = [
        { turnId: params.turnId, item: { id: `${params.turnId}-user`, type: 'userMessage', content: [{ type: 'text', text: `${params.turnId} question` }] }, startedAtMs: 1000 },
        { turnId: params.turnId, item: { id: `${params.turnId}-answer`, type: 'agentMessage', text: `${params.turnId} answer` }, startedAtMs: 2000 },
      ];
      const data = (params.sortDirection === 'desc' ? rows.toReversed() : rows).slice(0, Number(params.limit));
      return (async function* () { yield Buffer.from(JSON.stringify({ id, result: { data, nextCursor: null } })); })();
    },
  }, onMessage() {} });
  const session = parseSessionRef({ environmentId: randomUUID(), harnessInstanceId: randomUUID(), nativeSessionId: 'selected' });
  const handle = createCodexHistoryStream({ session, epoch: randomUUID(), processGeneration: 1, assertCurrent() {}, randomUUID, request, requestHistory: (method, params) => client.requestHistory(method, params) });
  const signal = new AbortController().signal;
  try {
    await handle.open({ signal, streamStore: store });
    const first = await handle.page({ signal });
    expect(first.items.map(item => item.recordId)).toEqual(['latest-answer', 'latest-user']);
    expect(first.completeness).toBe('partial');
    expect(first.cursor).not.toBeNull();
    const second = await handle.page({ signal, cursor: first.cursor!, releasePageIds: [first.pageId] });
    expect(second.items.map(item => item.recordId)).toEqual(['older-answer', 'older-user']);
    expect(second.cursor).toBeNull();
    expect(second.completeness).toBe('complete');
    expect(calls.map(call => call.method)).toEqual(['thread/turns/list', 'thread/items/list', 'thread/turns/list', 'thread/items/list']);
    expect(calls.filter(call => call.method === 'thread/turns/list').every(call => call.params.sortDirection === 'desc' && call.params.itemsView === 'notLoaded' && call.params.limit === 1)).toBe(true);
    expect(calls.filter(call => call.method === 'thread/items/list').every(call => call.params.threadId === 'selected' && call.params.sortDirection === 'desc' && call.params.limit === 200)).toBe(true);
  } finally {
    await handle.close();
    client.close();
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

it.each([
  { name: 'unmaterialized', code: -32600, message: 'thread private-thread is not materialized yet', empty: true },
  { name: 'ephemeral', code: -32600, message: 'ephemeral threads do not support thread/turns/list', empty: false },
  { name: 'unloaded', code: -32600, message: 'thread not loaded: private-thread', empty: false },
  { name: 'invalid id', code: -32600, message: 'invalid thread id: private-thread', empty: false },
  { name: 'invalid params despite marker', code: -32602, message: 'not materialized yet', empty: false },
])('classifies $name through the RPC boundary before opening a streamed item page', async testCase => {
  const root = await mkdtemp(path.join(tmpdir(), 'vis-codex-empty-'));
  const store = createHistoryStream({ scope: 'empty-window', globalDisk: createHistoryDiskBudget(), createDirectory: () => mkdtemp(path.join(root, 'spool-')) });
  let receive: (raw: string) => void = () => {};
  const raw = vi.fn(() => { throw new Error('No item page exists before the first turn'); });
  const client = createAppServerClient({ transport: {
    subscribe(callback) { receive = callback; return () => {}; },
    send(value) { const { id } = JSON.parse(value); queueMicrotask(() => receive(JSON.stringify({ id, error: { code: testCase.code, message: testCase.message } }))); },
    requestRaw: raw, close() {},
  }, onMessage() {} });
  const session = parseSessionRef({ environmentId: randomUUID(), harnessInstanceId: randomUUID(), nativeSessionId: 'new-thread' });
  const handle = createCodexHistoryStream({ session, epoch: randomUUID(), processGeneration: 1, assertCurrent() {}, randomUUID,
    request: (method, params) => client.request(method, params), requestHistory: (method, params) => client.requestHistory(method, params) });
  const signal = new AbortController().signal;
  try {
    await handle.open({ signal, streamStore: store });
    if (testCase.empty) {
      const page = await handle.page({ signal });
      expect(page).toMatchObject({ items: [], cursor: null, completeness: 'complete' });
    } else {
      const error = await handle.page({ signal }).catch((cause: unknown) => cause);
      expect(error).toMatchObject({ code: 'invalid_request', field: 'codex.rpc.thread/turns/list', nativeCode: testCase.code });
      expect(JSON.stringify(error)).not.toContain('private-thread');
    }
    expect(raw).not.toHaveBeenCalled();
  } finally { await handle.close(); client.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

it('does not turn a streamed continuation failure into an empty completed transcript', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'vis-codex-continuation-'));
  const store = createHistoryStream({ scope: 'continuation', globalDisk: createHistoryDiskBudget(), createDirectory: () => mkdtemp(path.join(root, 'spool-')) });
  let receive: (raw: string) => void = () => {};
  let turns = 0;
  const client = createAppServerClient({ transport: {
    subscribe(callback) { receive = callback; return () => {}; },
    send(value) {
      const { id } = JSON.parse(value);
      const reply = ++turns === 1 ? { result: { data: [{ id: 'latest', items: [] }], nextCursor: 'older-turn' } }
        : { error: { code: -32600, message: 'thread private-thread is not materialized yet' } };
      queueMicrotask(() => receive(JSON.stringify({ id, ...reply })));
    },
    requestRaw(_value, id) { return (async function* () { yield Buffer.from(JSON.stringify({ id, result: { data: [{ turnId: 'latest', item: { id: 'answer', type: 'agentMessage', text: 'Latest answer' } }], nextCursor: null } })); })(); },
    close() {},
  }, onMessage() {} });
  const session = parseSessionRef({ environmentId: randomUUID(), harnessInstanceId: randomUUID(), nativeSessionId: 'existing' });
  const handle = createCodexHistoryStream({ session, epoch: randomUUID(), processGeneration: 1, assertCurrent() {}, randomUUID,
    request: (method, params) => client.request(method, params), requestHistory: (method, params) => client.requestHistory(method, params) });
  const signal = new AbortController().signal;
  try {
    await handle.open({ signal, streamStore: store });
    const first = await handle.page({ signal });
    expect(first.cursor).not.toBeNull();
    await expect(handle.page({ signal, cursor: first.cursor!, releasePageIds: [first.pageId] })).rejects.toMatchObject({ code: 'invalid_request', nativeCode: -32600 });
  } finally { await handle.close(); client.close(); await store.close(); await rm(root, { recursive: true, force: true }); }
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProtocolError } from '../../shared/runtime/capabilities.js';
import { parseConnectionProfileId, parseEnvironmentId, parseHarnessInstanceId } from '../../shared/runtime/identity.js';
import { createRuntimeConnection } from '../runtime/connection';
import { createRuntimeClient } from '../runtime/client';
import type { SelectionCapture } from '../runtime/selectionScope';
import { useRuntimeConversation } from './useRuntimeConversation';
import type { HistoryStatus } from '../runtime/historyCache';

const controlled = vi.hoisted(() => {
  const status: HistoryStatus = { status: 'partial' };
  return { page: vi.fn(), export: vi.fn(), select: vi.fn(async () => {}), dispose: vi.fn(async () => {}), canPoll: true, status };
});
vi.mock('../runtime/historyCache', () => ({ createHistoryCache: () => controlled }));

describe('selected conversation cancellation', () => {
  it('shares one in-flight page across repeated load requests and clears a recovered page failure', async () => {
    controlled.canPoll = false;
    const connection = createRuntimeConnection({ reference: { url: 'ws://127.0.0.1:23004/runtime' }, resolveAuthentication: async () => ({}) });
    const client = createRuntimeClient({ connection });
    const target = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
    const capture: SelectionCapture = {
      selection: { profileId: parseConnectionProfileId('22222222-2222-4222-8222-222222222222'), session: { environmentId: target, harnessInstanceId: parseHarnessInstanceId('33333333-3333-4333-8333-333333333333'), nativeSessionId: 'native' } },
      selectionGeneration: 1, clientScope: { binding: { target, epoch: 'epoch', generation: 1 }, generation: 1, isCurrent: () => true }, signal: new AbortController().signal, isCurrent: () => true,
    };
    const ready = { value: { items: [{ kind: 'inline', value: { info: { id: 'message', sessionID: 'native', role: 'user', time: { created: 1 } }, parts: [] } }], cursor: null }, release: vi.fn() };
    const held = Promise.withResolvers<typeof ready>();
    controlled.page.mockReturnValue(held.promise);
    const publish = vi.fn(), conversation = useRuntimeConversation({ publish });
    const work: Promise<unknown>[] = [];
    try {
      work.push(conversation.select(client, capture, 'opencode'));
      await vi.waitFor(() => expect(controlled.page).toHaveBeenCalledTimes(1));
      work.push(conversation.loadMore(), conversation.loadMore());
      expect(controlled.page).toHaveBeenCalledTimes(1);
      held.resolve(ready);
      await Promise.all(work);
      expect(ready.release).toHaveBeenCalledTimes(1);
      expect(publish).toHaveBeenCalledTimes(2);
      controlled.page.mockRejectedValueOnce(new ProtocolError('source_unavailable', 'temporary-page'));
      await expect(conversation.loadMore()).rejects.toMatchObject({ code: 'source_unavailable' });
      expect(conversation.error.value).toContain('temporary-page');
      controlled.page.mockResolvedValue(ready);
      await conversation.loadMore();
      expect(conversation.error.value).toBe('');
    } finally {
      held.resolve(ready);
      await Promise.allSettled(work);
      await conversation.dispose(); client.dispose(); connection.dispose();
    }
  });
  it('loads an earlier Codex card larger than one transport frame and keeps its reply visible', async () => {
    controlled.canPoll = false;
    const connection = createRuntimeConnection({ reference: { url: 'ws://127.0.0.1:23004/runtime' }, resolveAuthentication: async () => ({}) });
    const client = createRuntimeClient({ connection });
    const target = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
    const capture: SelectionCapture = {
      selection: { profileId: parseConnectionProfileId('22222222-2222-4222-8222-222222222222'), session: { environmentId: target, harnessInstanceId: parseHarnessInstanceId('33333333-3333-4333-8333-333333333333'), nativeSessionId: 'native' } },
      selectionGeneration: 1, clientScope: { binding: { target, epoch: 'epoch', generation: 1 }, generation: 1, isCurrent: () => true }, signal: new AbortController().signal, isCurrent: () => true,
    };
    const text = '界'.repeat(1_500_000);
    const bytes = new TextEncoder().encode(JSON.stringify({
      turnId: 'turn', item: { type: 'userMessage', id: 'question', content: [{ type: 'text', text }] },
    }));
    const descriptor = { totalBytes: bytes.length };
    controlled.export.mockImplementation(async function* () {
      for (let offset = 0; offset < bytes.length; offset += 65536) yield { bytes: bytes.subarray(offset, offset + 65536) };
    });
    controlled.page.mockResolvedValueOnce({
      value: { items: [{ kind: 'inline', value: { turnId: 'turn', item: { id: 'answer', type: 'agentMessage', text: 'Reply' } } }], cursor: 'earlier' }, release() {},
    }).mockResolvedValueOnce({
      value: { pageId: 'older-page', items: [{ kind: 'stream', descriptor }], cursor: null }, release() {},
    });
    const publish = vi.fn(), conversation = useRuntimeConversation({ publish });
    try {
      await conversation.select(client, capture, 'codex');
      expect(conversation.hasMore.value).toBe(true);
      await conversation.loadMore();
      const [question, reply] = publish.mock.lastCall![0];
      expect(question.parts[0].text).toBe(text);
      expect(reply.parts[0].text).toBe('Reply');
      expect(reply.info.parentID).toBe(question.info.id);
      expect(conversation.hasMore.value).toBe(false);
      expect(conversation.error.value).toBe('');
    } finally {
      await conversation.dispose(); client.dispose(); connection.dispose();
    }
  });
  beforeEach(() => { controlled.canPoll = true; controlled.status = { status: 'partial' }; controlled.page.mockReset(); controlled.select.mockClear(); controlled.dispose.mockClear(); });
  afterEach(() => { vi.useRealTimers(); });
  it.each([false, true])('schedules native history polling only when negotiated live invalidation is %s', async canPoll => {
    vi.useFakeTimers();
    controlled.canPoll = canPoll;
    controlled.page.mockResolvedValue({ value: { items: [], cursor: null }, release() {} });
    const connection = createRuntimeConnection({ reference: { url: 'ws://127.0.0.1:23004/runtime' }, resolveAuthentication: async () => ({}) });
    const client = createRuntimeClient({ connection });
    const target = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
    const capture: SelectionCapture = {
      selection: { profileId: parseConnectionProfileId('22222222-2222-4222-8222-222222222222'), session: { environmentId: target, harnessInstanceId: parseHarnessInstanceId('33333333-3333-4333-8333-333333333333'), nativeSessionId: 'native' } },
      selectionGeneration: 1, clientScope: { binding: { target, epoch: 'epoch', generation: 1 }, generation: 1, isCurrent: () => true }, signal: new AbortController().signal, isCurrent: () => true,
    };
    const conversation = useRuntimeConversation({ publish() {} });
    try {
      await conversation.select(client, capture, 'codex');
      expect(conversation.error.value).toBe('');
      expect(vi.getTimerCount()).toBe(canPoll ? 1 : 0);
    } finally { await conversation.dispose(); client.dispose(); connection.dispose(); }
  });
  it('does not publish or propagate a late page failure after its selection is obsolete', async () => {
    const connection = createRuntimeConnection({ reference: { url: 'ws://127.0.0.1:23004/runtime' }, resolveAuthentication: async () => ({}) });
    const client = createRuntimeClient({ connection });
    let current = true;
    const target = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
    const capture: SelectionCapture = {
      selection: { profileId: parseConnectionProfileId('22222222-2222-4222-8222-222222222222'), session: { environmentId: target, harnessInstanceId: parseHarnessInstanceId('33333333-3333-4333-8333-333333333333'), nativeSessionId: 'native' } },
      selectionGeneration: 1, clientScope: { binding: { target, epoch: 'epoch', generation: 1 }, generation: 1, isCurrent: () => current }, signal: new AbortController().signal, isCurrent: () => current,
    };
    const page = Promise.withResolvers<never>();
    controlled.page.mockReturnValue(page.promise);
    const publish = vi.fn(), conversation = useRuntimeConversation({ publish });
    try {
      const opening = conversation.select(client, capture, 'opencode');
      await vi.waitFor(() => expect(controlled.page).toHaveBeenCalled());
      current = false;
      page.reject(new ProtocolError('cancelled', 'history.selection'));
      await expect(opening).resolves.toBeUndefined();
      expect(conversation.error.value).toBe('');
      expect(publish).toHaveBeenCalledExactlyOnceWith([]);
    } finally { await conversation.dispose(); client.dispose(); connection.dispose(); }
  });
  it('preserves a producer-open authorization failure instead of reporting selection cancellation', async () => {
    const connection = createRuntimeConnection({ reference: { url: 'ws://127.0.0.1:23004/runtime' }, resolveAuthentication: async () => ({}) });
    const client = createRuntimeClient({ connection });
    const target = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
    const capture: SelectionCapture = {
      selection: { profileId: parseConnectionProfileId('22222222-2222-4222-8222-222222222222'), session: { environmentId: target, harnessInstanceId: parseHarnessInstanceId('33333333-3333-4333-8333-333333333333'), nativeSessionId: 'native' } },
      selectionGeneration: 1, clientScope: { binding: { target, epoch: 'epoch', generation: 1 }, generation: 1, isCurrent: () => true }, signal: new AbortController().signal, isCurrent: () => true,
    };
    controlled.status = { status: 'error', error: 'unauthorized' };
    const conversation = useRuntimeConversation({ publish() {} });
    try {
      await expect(conversation.select(client, capture, 'opencode')).rejects.toMatchObject({ code: 'unauthorized' });
      expect(conversation.error.value).toBe('unauthorized: history.open');
      expect(conversation.loading.value).toBe(false);
      expect(controlled.page).not.toHaveBeenCalled();
    } finally { await conversation.dispose(); client.dispose(); connection.dispose(); }
  });
  it('clears obsolete rendered history when a selected session is unavailable', async () => {
    const publish = vi.fn(), conversation = useRuntimeConversation({ publish });
    await conversation.unavailable('No authorized workspace');
    expect(publish).toHaveBeenCalledExactlyOnceWith([]);
    expect(conversation.error.value).toBe('No authorized workspace');
    expect(conversation.loading.value).toBe(false);
    await conversation.dispose();
  });
  it('retains failed cleanup ownership and retries it before admitting another selected history', async () => {
    controlled.page.mockResolvedValue({ value: { items: [], cursor: null }, release() {} });
    const connection = createRuntimeConnection({ reference: { url: 'ws://127.0.0.1:23004/runtime' }, resolveAuthentication: async () => ({}) });
    const client = createRuntimeClient({ connection });
    const target = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
    const capture: SelectionCapture = {
      selection: { profileId: parseConnectionProfileId('22222222-2222-4222-8222-222222222222'), session: { environmentId: target, harnessInstanceId: parseHarnessInstanceId('33333333-3333-4333-8333-333333333333'), nativeSessionId: 'native' } },
      selectionGeneration: 1, clientScope: { binding: { target, epoch: 'epoch', generation: 1 }, generation: 1, isCurrent: () => true }, signal: new AbortController().signal, isCurrent: () => true,
    };
    const conversation = useRuntimeConversation({ publish() {} });
    try {
      await conversation.select(client, capture, 'codex');
      controlled.dispose.mockRejectedValueOnce(new ProtocolError('source_unavailable', 'history.close_pending'));
      await expect(conversation.select(client, capture, 'codex')).rejects.toMatchObject({ code: 'source_unavailable' });
      expect(controlled.select).toHaveBeenCalledTimes(1);
      await conversation.select(client, capture, 'codex');
      expect(controlled.dispose).toHaveBeenCalledTimes(2);
      expect(controlled.select).toHaveBeenCalledTimes(2);
    } finally { await conversation.dispose(); client.dispose(); connection.dispose(); }
  });
  it('shares one pending cleanup barrier across overlapping selections', async () => {
    controlled.page.mockResolvedValue({ value: { items: [], cursor: null }, release() {} });
    const connection = createRuntimeConnection({ reference: { url: 'ws://127.0.0.1:23004/runtime' }, resolveAuthentication: async () => ({}) });
    const client = createRuntimeClient({ connection });
    const target = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
    const capture: SelectionCapture = {
      selection: { profileId: parseConnectionProfileId('22222222-2222-4222-8222-222222222222'), session: { environmentId: target, harnessInstanceId: parseHarnessInstanceId('33333333-3333-4333-8333-333333333333'), nativeSessionId: 'native' } },
      selectionGeneration: 1, clientScope: { binding: { target, epoch: 'epoch', generation: 1 }, generation: 1, isCurrent: () => true }, signal: new AbortController().signal, isCurrent: () => true,
    };
    const conversation = useRuntimeConversation({ publish() {} });
    const held = Promise.withResolvers<void>();
    try {
      await conversation.select(client, capture, 'codex');
      controlled.dispose.mockReturnValueOnce(held.promise);
      const first = conversation.select(client, capture, 'codex');
      const second = conversation.select(client, capture, 'codex');
      for (let index = 0; index < 12; index++) await Promise.resolve();
      expect(controlled.dispose).toHaveBeenCalledTimes(1);
      expect(controlled.select).toHaveBeenCalledTimes(1);
      held.resolve(); await Promise.all([first, second]);
      expect(controlled.select).toHaveBeenCalledTimes(2);
    } finally { held.resolve(); await conversation.dispose(); client.dispose(); connection.dispose(); }
  });
});

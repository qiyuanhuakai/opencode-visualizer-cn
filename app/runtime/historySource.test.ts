import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRuntimeClient } from './client';
import { createRuntimeConnection } from './connection';
import { createSelectionScope } from './selectionScope';
import { createHistorySource } from './historySource';
import { decodeFrame, encodeFrame } from '../../shared/runtime/protocol.js';
import type { Request } from '../../shared/runtime/protocol.js';
import { parseConnectionProfileId, parseEnvironmentId, parseHarnessInstanceId, parseInstanceId } from '../../shared/runtime/identity.js';
import { parseCapabilities } from '../../shared/runtime/capabilities.js';
import { parseRuntimeParams, RUNTIME_WIRE_METHODS } from '../../shared/runtime/runtimeWire.js';

const target = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const harness = parseHarnessInstanceId('22222222-2222-4222-8222-222222222222');
const profile = parseConnectionProfileId('33333333-3333-4333-8333-333333333333');
const session = { environmentId: target, harnessInstanceId: harness, nativeSessionId: 'same' };
const fence = { id: '44444444-4444-4444-8444-444444444444', sourceGeneration: 1 };
const pageId = '55555555-5555-4555-8555-555555555555';
class Wire extends EventTarget {
  binaryType: BinaryType = 'arraybuffer'; readyState: 0 | 1 | 2 | 3 = 1; bufferedAmount = 0;
  readonly sent: Request[] = [];
  readonly queued: Request[] = [];
  waiter: ((request: Request) => void) | undefined;
  close() { this.readyState = 3; }
  send(data: string | Uint8Array) {
    if (typeof data !== 'string') throw new TypeError('JSON required');
    const request = decodeFrame(data); if (request.kind !== 'request') throw new TypeError('Request required');
    this.sent.push(request);
    if (this.waiter) { const waiter = this.waiter; this.waiter = undefined; waiter(request); } else this.queued.push(request);
  }
  next(): Promise<Request> { const request = this.queued.shift(); return request ? Promise.resolve(request) : new Promise(resolve => { this.waiter = resolve; }); }
  frame(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: encodeFrame(value) })); }
  reply(request: Request, result: unknown) { this.frame({ version: 1, kind: 'result', target, epoch: 'epoch', generation: 1, id: request.id, ok: true, phase: 'read', result }); }
}
const cleanup: (() => void)[] = [];
afterEach(() => { for (const dispose of cleanup.splice(0)) dispose(); vi.useRealTimers(); });
async function setup() {
  const wire = new Wire(); const created = Promise.withResolvers<void>();
  const connection = createRuntimeConnection({ reference: { url: 'ws://127.0.0.1:43210/runtime' }, resolveAuthentication: async () => ({}), createWebSocket: () => { created.resolve(); return wire; } });
  const client = createRuntimeClient({ connection });
  const scope = createSelectionScope({ client, profileId: profile });
  cleanup.push(() => { scope.dispose(); client.dispose(); connection.dispose(); });
  const connecting = connection.connect(); await created.promise;
  wire.frame({ kind: 'hello', version: 1, target, epoch: 'epoch', generation: 1, instanceId: parseInstanceId('66666666-6666-4666-8666-666666666666'), capabilities: parseCapabilities({ methods: Object.keys(RUNTIME_WIRE_METHODS), extensions: [] }) });
  await connecting;
  const capture = scope.select(session); if (!capture) throw new TypeError('Capture required');
  const owner = createHistorySource(client).open(capture);
  const opening = await wire.next();
  if (opening.method !== 'runtime.history.open') throw new TypeError('Open required');
  const opened = { historyId: parseRuntimeParams('runtime.history.open', opening.params).historyId, session, fence, capabilities: { archive: 'paged', recordStream: true, live: 'invalidate' } };
  return { wire, connection, scope, owner, opening, opened };
}
function page(historyId: string) { return { historyId, session, fence, pageId, items: [{ recordId: 'message', kind: 'inline', value: { text: 'preserved' } }], cursor: null, completeness: 'complete' }; }

describe('selected history source with production client and codecs', () => {
  it('rejects same native ID from a different harness after open', async () => {
    // Given an authenticated client opening a qualified session.
    const { wire, owner, opening, opened, connection } = await setup();
    // When the peer substitutes the harness while retaining the native ID.
    wire.reply(opening, { ...opened, session: { ...session, harnessInstanceId: '77777777-7777-4777-8777-777777777777' } });
    // Then the qualified identity fence rejects the result.
    await expect(owner.ready.result).rejects.toMatchObject({ code: 'reconcile_required' });
    connection.disconnect(); await owner.close();
  });
  it('holds late page drainage after selection invalidation and an early close ACK', async () => {
    // Given an open history with a pending real wire page.
    const { wire, owner, opening, opened, scope } = await setup(); wire.reply(opening, opened); await owner.ready.result;
    const reading = owner.page({}); const request = await wire.next();
    const rejected = expect(reading.result).rejects.toMatchObject({ code: 'cancelled' });
    // When selection changes and the close reply overtakes the old page.
    scope.select({ ...session, nativeSessionId: 'new' }); const closing = owner.close();
    const close = await wire.next(); wire.reply(close, { closed: true });
    let drained = false; void closing.then(() => { drained = true; }); await Promise.resolve(); await Promise.resolve();
    // Then close remains pending until the obsolete page is physically consumed.
    expect(drained).toBe(false); wire.reply(request, page(opened.historyId)); await rejected; await closing;
    expect(drained).toBe(true); expect(wire.sent.map(request => request.method)).toEqual(['runtime.history.open', 'runtime.history.page', 'runtime.history.close']);
  });
  it('keeps physical drainage pending after the client deadline rejects the result', async () => {
    // Given a pending history page with production timeout semantics.
    vi.useFakeTimers(); const { wire, owner, opening, opened } = await setup(); wire.reply(opening, opened); await owner.ready.result;
    const reading = owner.page({}); const request = await wire.next();
    const rejected = expect(reading.result).rejects.toMatchObject({ code: 'timeout' });
    let drained = false; void reading.drained.then(() => { drained = true; });
    // When the 15-second local deadline elapses.
    await vi.advanceTimersByTimeAsync(15000); await rejected;
    // Then the late packet remains owned until actually received.
    expect(drained).toBe(false); wire.reply(request, page(opened.historyId)); await reading.drained; expect(drained).toBe(true);
    const closing = owner.close(); wire.reply(await wire.next(), { closed: true }); await closing;
  });
  it('drains pending open on actual connection detach without sending another binding', async () => {
    // Given an unfinished open.
    const { owner, connection, wire } = await setup();
    const rejected = expect(owner.ready.result).rejects.toMatchObject({ code: 'reconcile_required' });
    // When its connection detaches.
    connection.disconnect();
    // Then both correlation and owner cleanup terminate without a foreign close.
    await rejected; await owner.ready.drained; await owner.close(); expect(wire.sent).toHaveLength(1);
  });
  it('rejects a changed source fence on an otherwise valid page', async () => {
    // Given a selected history.
    const { wire, owner, opening, opened } = await setup(); wire.reply(opening, opened); await owner.ready.result;
    // When the page comes from another source generation.
    const reading = owner.page({}); wire.reply(await wire.next(), { ...page(opened.historyId), fence: { ...fence, sourceGeneration: 2 } });
    // Then stale content cannot enter the selected cache.
    await expect(reading.result).rejects.toMatchObject({ code: 'replay_required' });
    const closing = owner.close(); wire.reply(await wire.next(), { closed: true }); await closing;
  });
  it('rejects chunk offset substitution and closes a pending invalidation poll', async () => {
    // Given an opened source and a chunk request for offset zero.
    const { wire, owner, opening, opened } = await setup(); wire.reply(opening, opened); await owner.ready.result;
    const chunk = owner.chunk({ pageId, descriptorId: pageId, offset: 0 });
    // When a valid chunk is returned for another offset.
    wire.reply(await wire.next(), { historyId: opened.historyId, fence, pageId, descriptorId: pageId, offset: 1, totalBytes: 2, sha256: 'a'.repeat(64), data: 'eA==', nextOffset: null });
    // Then correlation rejects the substituted byte range.
    await expect(chunk.result).rejects.toMatchObject({ code: 'reconcile_required' });
    const poll = owner.poll(0); const request = await wire.next(); const rejected = expect(poll.result).rejects.toMatchObject({ code: 'cancelled' });
    const closing = owner.close(); wire.reply(await wire.next(), { closed: true });
    wire.reply(request, { historyId: opened.historyId, fence, through: 0, changed: false, status: 'current' });
    await rejected; await closing;
  });
});

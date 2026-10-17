// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createKimiWebDriver } from '../../../bridge/runtime/drivers/kimiWebDriver.js';
import type { KimiWebDriver } from '../../../bridge/runtime/drivers/kimiWebDriver.js';
import { createRuntimeStore } from '../../../bridge/runtime/storage/runtimeStore.js';
import type { Json, RuntimeStore } from '../../../bridge/runtime/storage/runtimeStore.js';
import { parseEnvironmentId, parseHarnessInstanceId, parseSessionRef } from '../../../shared/runtime/identity.js';
import { StoreError } from '../../../bridge/runtime/storage/storeProtocol.js';

type ObserverStream = AsyncIterable<Json> & { return(): Promise<IteratorResult<Json>> };
type FixtureFrame = { readonly direction: string; readonly frame: { readonly type: string; readonly session_id?: string } };
type KimiFixture = {
  readonly endpoint: string;
  readonly wire: readonly FixtureFrame[];
  readonly calls: readonly { readonly method: string; readonly path: string; readonly authorized: boolean }[];
  readonly mode: { holdHistory: boolean; loseSendAck: boolean };
  readonly held: number;
  authorization(): string;
  stream(nativeSessionId: string): { readonly turnId: number; readonly active: string | null };
  frame(nativeSessionId: string, type: string, payload: Record<string, unknown>, volatile?: boolean): unknown;
  terminal(nativeSessionId: string, reason?: string): void;
  releaseHistory(): void;
  close(): Promise<unknown>;
};
type FixtureModule = { startKimiFixture(options?: { readonly count?: number }): Promise<KimiFixture> };
// The HTTP/WS fixture ships as a plain .mjs QA script; load it by URL so the test stays a normal TS module.
const loadFixtureModule = (): Promise<FixtureModule> => import(new URL('../../../scripts/qa/runtime-v090-cases/task-16-fixture.mjs', import.meta.url).href);

const environmentId = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const harnessInstanceId = parseHarnessInstanceId('22222222-2222-4222-8222-222222222222');
const epoch = '33333333-3333-4333-8333-333333333333';
const scope = { environmentId, harnessInstanceId };
const sessionRef = (nativeSessionId: string) => parseSessionRef({ environmentId, harnessInstanceId, nativeSessionId });
const sessionId = (index: number) => `native-${String(index).padStart(4, '0')}`;

async function until(condition: () => Promise<boolean>, label: string, attempts = 240) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timeout waiting for ${label}`);
}

describe('Kimi Web driver session reclamation', () => {
  let fixture: KimiFixture;
  let store: RuntimeStore;
  let driver: KimiWebDriver;
  let stateDirectory: string;
  let authFailures = 0;
  const authorization = () => {
    if (authFailures > 0) { authFailures -= 1; throw new Error('credential provider unavailable'); }
    return fixture.authorization();
  };

  beforeEach(async () => {
    const { startKimiFixture } = await loadFixtureModule();
    fixture = await startKimiFixture({ count: 40 });
    stateDirectory = await mkdtemp(path.join(tmpdir(), 'kimi-web-release-'));
    store = createRuntimeStore({ stateDirectory, environmentId, ownerId: randomUUID(), epoch });
    await store.ready;
    authFailures = 0;
    driver = await createKimiWebDriver({
      ...scope, store, endpoint: fixture.endpoint, getAuthorization: authorization,
      getAuthority: () => ({ epoch, processGeneration: 1 }), ownership: 'borrowed', deadlineMs: 3000,
    });
  });

  afterEach(async () => {
    await driver.close();
    await store.close();
    await fixture.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });

  const call = async <T>(operation: 'subscribe' | 'send' | 'readHistoryPage' | 'cancel' | 'respondInteraction', nativeSessionId: string, params: Record<string, Json> = {}): Promise<T> => {
    const method = driver.registration.driver.core[operation];
    if (!method) throw new Error(`kimi web driver does not support ${operation}`);
    return (await method({ ...scope, session: sessionRef(nativeSessionId), params })) as T;
  };
  const nativeFrames = (type: string) => fixture.wire.filter((entry) => entry.direction === 'driver-to-native' && entry.frame.type === type);
  const nativePrompts = () => fixture.calls.filter((entry) => entry.method === 'POST' && entry.path.endsWith('/prompts')).length;
  const isRecord = (value: Json | undefined): value is { readonly [key: string]: Json } => typeof value === 'object' && value !== null && !Array.isArray(value);
  const pendingInteractions = async () => (await store.page({ collection: 'interactions', limit: 100 })).items.filter((item) => isRecord(item.value) && item.value.phase === 'pending');
  const sendOperations = async (): Promise<{ readonly [key: string]: Json }[]> => (await store.page({ collection: 'operations', limit: 200 })).items.map((item) => item.value).filter((value): value is { readonly [key: string]: Json } => isRecord(value) && value.method === 'send');

  it('reclaims every session slot once the last subscription of a session is released', async () => {
    // Given 33 distinct idle sessions opened and closed one after another.
    const peak = { selected: 0, historySessions: 0 };
    for (let index = 0; index < 33; index += 1) {
      const stream = await call<ObserverStream>('subscribe', sessionId(index));
      const during = driver.diagnostics();
      peak.selected = Math.max(peak.selected, during.selected);
      peak.historySessions = Math.max(peak.historySessions, during.historySessions);
      await stream.return();
    }
    await until(async () => nativeFrames('unsubscribe_v2').length === 33 && nativeFrames('unsubscribe').length === 33, '33 native unsubscribe pairs');

    // Then no released session keeps a slot: selection, history cache and native subscriptions are all empty.
    expect({ observers: driver.diagnostics().observers, selected: driver.diagnostics().selected, historySessions: driver.diagnostics().historySessions, lifecycleSubscriptions: driver.diagnostics().lifecycleSubscriptions }).toEqual({ observers: 0, selected: 0, historySessions: 0, lifecycleSubscriptions: 0 });
    expect(peak).toEqual({ selected: 1, historySessions: 1 });
    expect(driver.diagnostics().reclaimed).toBe(33);

    // And the 32-session cap still admits new sessions, because released ones no longer occupy it.
    await expect(call<ObserverStream>('subscribe', sessionId(39))).resolves.toBeDefined();
    await expect(call('readHistoryPage', sessionId(38))).resolves.toMatchObject({ agentId: 'main' });

    // And both native subscription lanes were released per reclaimed session.
    await until(async () => nativeFrames('unsubscribe_v2').length === 34 && nativeFrames('unsubscribe').length === 34, 'reclaimed read session native unsubscribe pair');
    expect(nativeFrames('unsubscribe_v2').length).toBe(34);
    expect(nativeFrames('unsubscribe').length).toBe(34);
  }, 60000);

  it('keeps monitoring a running task after its observation window is closed', async () => {
    // Given an observed session with a submitted turn that requests an approval.
    const stream = await call<ObserverStream>('subscribe', sessionId(0));
    const sent = await call<{ operationId: string; promptId: string }>('send', sessionId(0), { content: [{ type: 'text', text: 'keep monitoring' }], idempotencyKey: 'running-task-1' });
    await until(async () => (await pendingInteractions()).length > 0, 'pending native approval');
    expect(fixture.stream(sessionId(0)).active).toBe(sent.promptId);

    // When the observation window closes while the turn is still running.
    await stream.return();

    // Then the session stays selected, cached and subscribed until the turn is observed to completion.
    const retained = driver.diagnostics();
    expect({ selected: retained.selected, historySessions: retained.historySessions, lifecycleSubscriptions: retained.lifecycleSubscriptions }).toEqual({ selected: 1, historySessions: 1, lifecycleSubscriptions: 1 });

    // And the turn still terminates durably without any observer watching.
    fixture.terminal(sessionId(0));
    await driver.flush();
    const operations = driver.operations;
    if (!operations) throw new Error('kimi web driver exposes no operations');
    await until(async () => (await operations.journal.get(sent.operationId)).phase === 'terminal', 'terminal native turn');
    expect(await operations.journal.get(sent.operationId)).toMatchObject({ phase: 'terminal', outcome: 'completed' });

    // And only then is the session reclaimed.
    const reclaimed = driver.diagnostics();
    expect({ selected: reclaimed.selected, historySessions: reclaimed.historySessions, lifecycleSubscriptions: reclaimed.lifecycleSubscriptions, reclaimed: reclaimed.reclaimed }).toEqual({ selected: 0, historySessions: 0, lifecycleSubscriptions: 0, reclaimed: 1 });
    await until(async () => nativeFrames('unsubscribe_v2').length === 1 && nativeFrames('unsubscribe').length === 1, 'native unsubscribe pair');
  }, 60000);

  it('keeps a session selected while a second observer still watches it', async () => {
    // Given two observation windows on the same session.
    const first = await call<ObserverStream>('subscribe', sessionId(2));
    const second = await call<ObserverStream>('subscribe', sessionId(2));
    expect(driver.diagnostics().observers).toBe(2);
    expect(driver.diagnostics().selected).toBe(1);

    // When only one window closes.
    await first.return();

    // Then the session stays selected, cached and subscribed for the remaining observer.
    const retained = driver.diagnostics();
    expect({ observers: retained.observers, selected: retained.selected, historySessions: retained.historySessions }).toEqual({ observers: 1, selected: 1, historySessions: 1 });
    expect(nativeFrames('unsubscribe_v2').length).toBe(0);
    expect(nativeFrames('unsubscribe').length).toBe(0);

    // And it is reclaimed exactly once the last window closes.
    await second.return();
    await until(async () => nativeFrames('unsubscribe_v2').length === 1 && nativeFrames('unsubscribe').length === 1, 'native unsubscribe pair');
    expect({ observers: driver.diagnostics().observers, selected: driver.diagnostics().selected, historySessions: driver.diagnostics().historySessions, reclaimed: driver.diagnostics().reclaimed }).toEqual({ observers: 0, selected: 0, historySessions: 0, reclaimed: 1 });
  }, 60000);

  it('holds the session slot while a history read is in flight', async () => {
    // Given a session that was opened, closed and reclaimed.
    const first = await call<ObserverStream>('subscribe', sessionId(1));
    await first.return();
    expect(driver.diagnostics().selected).toBe(0);

    // When a history read starts while the native transcript response is withheld.
    fixture.mode.holdHistory = true;
    const reading = call('readHistoryPage', sessionId(1));
    await until(async () => fixture.held > 0, 'withheld native transcript');

    // Then the in-flight read keeps its session slot.
    expect(driver.diagnostics().selected).toBe(1);
    expect(driver.diagnostics().historySessions).toBe(1);

    // And once the read settles the slot is released again.
    fixture.mode.holdHistory = false;
    fixture.releaseHistory();
    await expect(reading).resolves.toMatchObject({ agentId: 'main' });
    const after = driver.diagnostics();
    expect({ selected: after.selected, historySessions: after.historySessions }).toEqual({ selected: 0, historySessions: 0 });
  }, 60000);

  it('keeps monitoring the running main task when a sub-agent turn ends first', async () => {
    // Given an observed session whose main turn is submitted and still running.
    const stream = await call<ObserverStream>('subscribe', sessionId(0));
    const sent = await call<{ operationId: string; promptId: string }>('send', sessionId(0), { content: [{ type: 'text', text: 'main task' }], idempotencyKey: 'subagent-end-1' });
    await until(async () => (await pendingInteractions()).length > 0, 'pending native approval');
    const operations = driver.operations;
    if (!operations) throw new Error('kimi web driver exposes no operations');
    await until(async () => (await operations.journal.get(sent.operationId)).phase === 'observed', 'observed native turn');

    // When the last observation window closes while the main task is still running.
    await stream.return();

    // Then a legally-shaped sub-agent terminal event does not end the main task: the session stays selected, cached and subscribed.
    const lifecycleBefore = driver.diagnostics().lifecycleFrames;
    fixture.frame(sessionId(0), 'turn.ended', { agentId: 'explore-subagent', turnId: 'subagent-turn-1', reason: 'completed' });
    await until(async () => driver.diagnostics().lifecycleFrames > lifecycleBefore, 'sub-agent terminal lifecycle frame');
    await driver.flush();
    const afterSubagent = driver.diagnostics();
    expect({ observers: afterSubagent.observers, selected: afterSubagent.selected, historySessions: afterSubagent.historySessions, lifecycleSubscriptions: afterSubagent.lifecycleSubscriptions }).toEqual({ observers: 0, selected: 1, historySessions: 1, lifecycleSubscriptions: 1 });
    expect(await operations.journal.get(sent.operationId)).toMatchObject({ phase: 'observed' });
    expect(fixture.stream(sessionId(0)).active).toBe(sent.promptId);

    // And the genuine main-task terminal still ends the turn durably and only then reclaims the session.
    fixture.terminal(sessionId(0));
    await driver.flush();
    await until(async () => (await operations.journal.get(sent.operationId)).phase === 'terminal', 'terminal native turn');
    expect(await operations.journal.get(sent.operationId)).toMatchObject({ phase: 'terminal', outcome: 'completed' });
    await until(async () => nativeFrames('unsubscribe_v2').length === 1 && nativeFrames('unsubscribe').length === 1, 'native unsubscribe pair');
    const reclaimed = driver.diagnostics();
    expect({ selected: reclaimed.selected, historySessions: reclaimed.historySessions, lifecycleSubscriptions: reclaimed.lifecycleSubscriptions, reclaimed: reclaimed.reclaimed }).toEqual({ selected: 0, historySessions: 0, lifecycleSubscriptions: 0, reclaimed: 1 });

    // And the released lease lets the same session be sent to again.
    await expect(call<{ phase: string }>('send', sessionId(0), { content: [{ type: 'text', text: 'after sub-agent end' }], idempotencyKey: 'subagent-end-2' })).resolves.toMatchObject({ phase: 'native-executed' });
  }, 60000);

  it('keeps monitoring the running main task when a stale main turn ends first', async () => {
    // Given an observed session whose main turn is submitted and still running.
    const stream = await call<ObserverStream>('subscribe', sessionId(0));
    const sent = await call<{ operationId: string; promptId: string }>('send', sessionId(0), { content: [{ type: 'text', text: 'main task' }], idempotencyKey: 'stale-turn-1' });
    await until(async () => (await pendingInteractions()).length > 0, 'pending native approval');
    const operations = driver.operations;
    if (!operations) throw new Error('kimi web driver exposes no operations');
    await until(async () => (await operations.journal.get(sent.operationId)).phase === 'observed', 'observed native turn');

    // When the last observation window closes and a main-agent terminal arrives for a turn the running task never claimed.
    await stream.return();
    const lifecycleBefore = driver.diagnostics().lifecycleFrames;
    fixture.frame(sessionId(0), 'turn.ended', { agentId: 'main', turnId: 'stale-turn-0', reason: 'completed' });
    await until(async () => driver.diagnostics().lifecycleFrames > lifecycleBefore, 'stale-turn terminal lifecycle frame');
    await driver.flush();

    // Then the running task is not released: the session stays selected, cached and subscribed.
    const afterStale = driver.diagnostics();
    expect({ observers: afterStale.observers, selected: afterStale.selected, historySessions: afterStale.historySessions, lifecycleSubscriptions: afterStale.lifecycleSubscriptions }).toEqual({ observers: 0, selected: 1, historySessions: 1, lifecycleSubscriptions: 1 });
    expect(await operations.journal.get(sent.operationId)).toMatchObject({ phase: 'observed' });
    expect(fixture.stream(sessionId(0)).active).toBe(sent.promptId);

    // And the genuine main-task terminal still ends the turn durably and reclaims the session.
    fixture.terminal(sessionId(0));
    await driver.flush();
    await until(async () => (await operations.journal.get(sent.operationId)).phase === 'terminal', 'terminal native turn');
    const reclaimed = driver.diagnostics();
    expect({ selected: reclaimed.selected, historySessions: reclaimed.historySessions, reclaimed: reclaimed.reclaimed }).toEqual({ selected: 0, historySessions: 0, reclaimed: 1 });
  }, 60000);

  it('reclaims every session whose send never entered the native boundary', async () => {
    // Given 32 distinct idle sessions, each subscribed and then sent to while the credential provider fails.
    for (let index = 0; index < 32; index += 1) {
      const id = sessionId(index);
      const stream = await call<ObserverStream>('subscribe', id);
      authFailures = 1;
      await expect(call('send', id, { content: [{ type: 'text', text: 'never reaches native' }], idempotencyKey: `unsent-${index}` }))
        .rejects.toMatchObject({ code: 'unauthorized', field: 'native_authorization' });
      authFailures = 0;
      await stream.return();
    }

    // Then no unreferenced session keeps a slot: the send provably never reached the journal acceptance, so nothing has to be reconciled.
    const after = driver.diagnostics();
    expect({ observers: after.observers, selected: after.selected, historySessions: after.historySessions, lifecycleSubscriptions: after.lifecycleSubscriptions, reclaimed: after.reclaimed }).toEqual({ observers: 0, selected: 0, historySessions: 0, lifecycleSubscriptions: 0, reclaimed: 32 });
    await until(async () => nativeFrames('unsubscribe_v2').length === 32 && nativeFrames('unsubscribe').length === 32, '32 native unsubscribe pairs');
    expect(nativePrompts()).toBe(0);

    // And the 32-session cap still admits a new session.
    await expect(call<ObserverStream>('subscribe', sessionId(32))).resolves.toBeDefined();
  }, 60000);

  it('reclaims an idle session whose cancel is refused before any parent operation', async () => {
    // Given a subscribed idle session with no submitted turn.
    const stream = await call<ObserverStream>('subscribe', sessionId(0));
    expect(driver.diagnostics().selected).toBe(1);

    // When a cancel is refused because its parent operation does not exist.
    await expect(call('cancel', sessionId(0), { operationId: 'op:missing-parent', idempotencyKey: 'cancel-missing-1' }))
      .rejects.toMatchObject({ code: 'conflict', field: 'parent_scope' });

    // Then closing the last observation window reclaims the session: the refused control never created a running task.
    await stream.return();
    await until(async () => nativeFrames('unsubscribe_v2').length === 1 && nativeFrames('unsubscribe').length === 1, 'native unsubscribe pair');
    expect({ observers: driver.diagnostics().observers, selected: driver.diagnostics().selected, historySessions: driver.diagnostics().historySessions }).toEqual({ observers: 0, selected: 0, historySessions: 0 });
  }, 60000);

  it('reclaims an idle session whose interaction reply is refused before any interaction', async () => {
    // Given a subscribed idle session with no pending interaction.
    const stream = await call<ObserverStream>('subscribe', sessionId(0));
    expect(driver.diagnostics().selected).toBe(1);

    // When an interaction reply is refused because the interaction does not exist.
    await expect(call('respondInteraction', sessionId(0), { interactionId: 'interaction-missing', answer: { decision: 'approved' }, idempotencyKey: 'reply-missing-1' }))
      .rejects.toMatchObject({ code: 'conflict', field: 'interaction_scope' });

    // Then closing the last observation window reclaims the session.
    await stream.return();
    await until(async () => nativeFrames('unsubscribe_v2').length === 1 && nativeFrames('unsubscribe').length === 1, 'native unsubscribe pair');
    expect({ observers: driver.diagnostics().observers, selected: driver.diagnostics().selected, historySessions: driver.diagnostics().historySessions }).toEqual({ observers: 0, selected: 0, historySessions: 0 });
  }, 60000);

  it('does not re-register a task whose native turn ended before its acknowledgement', async () => {
    // Given a subscribed session whose send acknowledgement is withheld by the fixture.
    fixture.mode.holdSend = true;
    const stream = await call<ObserverStream>('subscribe', sessionId(0));
    const sending = call<{ operationId: string; promptId: string }>('send', sessionId(0), { content: [{ type: 'text', text: 'ends before ack' }], idempotencyKey: 'early-terminal-1' });
    // The turn binds and requests its approval while the HTTP receipt is still held.
    await until(async () => (await pendingInteractions()).length > 0, 'native turn binding');
    expect(fixture.stream(sessionId(0)).active).not.toBeNull();

    // When the native turn ends before the acknowledgement is delivered.
    fixture.terminal(sessionId(0));
    await until(async () => (await sendOperations())[0]?.phase === 'terminal', 'terminal native turn');
    fixture.releaseHistory();
    await sending;

    // Then closing the observation window reclaims the session: the acknowledgement must not
    // register a task whose terminal was already observed, because nothing would release it.
    await stream.return();
    await until(async () => driver.diagnostics().selected === 0, 'reclaimed after early terminal');
    expect({ observers: driver.diagnostics().observers, selected: driver.diagnostics().selected, historySessions: driver.diagnostics().historySessions }).toEqual({ observers: 0, selected: 0, historySessions: 0 });

    // And the 32-session cap admits new sessions, because the ended task holds no slot.
    await expect(call<ObserverStream>('subscribe', sessionId(39))).resolves.toBeDefined();
  }, 60000);

  it('keeps monitoring a session whose live-task read fails while its acknowledgement is lost', async () => {
    // Given a subscribed session whose native prompt acknowledgement is lost after the durable SENT marker.
    fixture.mode.loseSendAck = true;
    const stream = await call<ObserverStream>('subscribe', sessionId(0));
    const operations = driver.operations;
    if (!operations) throw new Error('kimi web driver exposes no operations');

    // When the durable read that decides whether a task is still running fails once.
    const originalGet = operations.journal.get.bind(operations.journal);
    let injected = true;
    operations.journal.get = async (id: string) => {
      if (injected) { injected = false; throw new StoreError('source_unavailable', 'queue_full'); }
      return originalGet(id);
    };
    await expect(call('send', sessionId(0), { content: [{ type: 'text', text: 'unknown read' }], idempotencyKey: 'unknown-read-1' }))
      .rejects.toMatchObject({ code: 'source_unavailable' });
    expect(injected).toBe(false);
    operations.journal.get = originalGet;

    // Then closing the observation window keeps the session monitored: a failed read is not
    // evidence that no task is running, so the session must not be reclaimed on it.
    await stream.return();
    await until(async () => driver.diagnostics().reclaimed === 0, 'session kept for reconciliation');
    expect({ observers: driver.diagnostics().observers, selected: driver.diagnostics().selected, historySessions: driver.diagnostics().historySessions, lifecycleSubscriptions: driver.diagnostics().lifecycleSubscriptions }).toEqual({ observers: 0, selected: 1, historySessions: 1, lifecycleSubscriptions: 1 });
    expect(nativeFrames('unsubscribe_v2').length).toBe(0);

    // And the native turn's genuine terminal ends the task durably and reclaims the session.
    const operationId = String((await sendOperations())[0]?.operationId ?? '');
    await until(async () => {
      const binding = await store.getControl({ collection: 'operations', key: `kimi-native:${operationId}` });
      return isRecord(binding?.value) && binding.value.turnId !== undefined;
    }, 'native turn binding');
    fixture.terminal(sessionId(0));
    await until(async () => (await sendOperations())[0]?.phase === 'terminal', 'terminal native turn');
    const reclaimed = driver.diagnostics();
    expect({ selected: reclaimed.selected, historySessions: reclaimed.historySessions, reclaimed: reclaimed.reclaimed }).toEqual({ selected: 0, historySessions: 0, reclaimed: 1 });
  }, 60000);

  it('retains a session whose send reached the native boundary but lost its acknowledgement', async () => {
    // Given a subscribed session whose native prompt acknowledgement is lost after the durable SENT marker.
    fixture.mode.loseSendAck = true;
    const stream = await call<ObserverStream>('subscribe', sessionId(0));
    await expect(call('send', sessionId(0), { content: [{ type: 'text', text: 'ambiguous acknowledgement' }], idempotencyKey: 'ambiguous-1' }))
      .rejects.toMatchObject({ code: 'source_unavailable' });
    const operations = driver.operations;
    if (!operations) throw new Error('kimi web driver exposes no operations');
    expect(await sendOperations()).toMatchObject([{ phase: 'reconciling' }]);

    // When the last observation window closes while the native turn may still be running.
    await stream.return();

    // Then the session stays selected, cached and subscribed for reconciliation instead of being reclaimed.
    const retained = driver.diagnostics();
    expect({ observers: retained.observers, selected: retained.selected, historySessions: retained.historySessions, lifecycleSubscriptions: retained.lifecycleSubscriptions }).toEqual({ observers: 0, selected: 1, historySessions: 1, lifecycleSubscriptions: 1 });
    expect(nativeFrames('unsubscribe_v2').length).toBe(0);

    // And the native turn's genuine terminal ends the task durably and reclaims the session.
    // The fixture emits turn.started on its own timer, so the turn must be bound before its
    // terminal frame: an ended frame that precedes the binding is correctly ignored, and the
    // test would otherwise wait for a terminal that can never be observed.
    await until(async () => (await pendingInteractions()).length > 0, 'native turn binding');
    fixture.mode.loseSendAck = false;
    fixture.terminal(sessionId(0));
    await driver.flush();
    await until(async () => (await sendOperations())[0]?.phase === 'terminal', 'terminal native turn');
    expect(await sendOperations()).toMatchObject([{ phase: 'terminal', outcome: 'completed' }]);
    const reclaimed = driver.diagnostics();
    expect({ selected: reclaimed.selected, historySessions: reclaimed.historySessions, reclaimed: reclaimed.reclaimed }).toEqual({ selected: 0, historySessions: 0, reclaimed: 1 });
  }, 60000);
});

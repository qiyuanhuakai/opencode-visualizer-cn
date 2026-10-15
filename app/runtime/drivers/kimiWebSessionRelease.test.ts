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

type ObserverStream = AsyncIterable<Json> & { return(): Promise<IteratorResult<Json>> };
type FixtureFrame = { readonly direction: string; readonly frame: { readonly type: string; readonly session_id?: string } };
type KimiFixture = {
  readonly endpoint: string;
  readonly wire: readonly FixtureFrame[];
  readonly mode: { holdHistory: boolean };
  readonly held: number;
  authorization(): string;
  stream(nativeSessionId: string): { readonly turnId: number; readonly active: string | null };
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

  beforeEach(async () => {
    const { startKimiFixture } = await loadFixtureModule();
    fixture = await startKimiFixture({ count: 40 });
    stateDirectory = await mkdtemp(path.join(tmpdir(), 'kimi-web-release-'));
    store = createRuntimeStore({ stateDirectory, environmentId, ownerId: randomUUID(), epoch });
    await store.ready;
    driver = await createKimiWebDriver({
      ...scope, store, endpoint: fixture.endpoint, getAuthorization: fixture.authorization,
      getAuthority: () => ({ epoch, processGeneration: 1 }), ownership: 'borrowed', deadlineMs: 3000,
    });
  });

  afterEach(async () => {
    await driver.close();
    await store.close();
    await fixture.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });

  const call = async <T>(operation: 'subscribe' | 'send' | 'readHistoryPage', nativeSessionId: string, params: Record<string, Json> = {}): Promise<T> => {
    const method = driver.registration.driver.core[operation];
    if (!method) throw new Error(`kimi web driver does not support ${operation}`);
    return (await method({ ...scope, session: sessionRef(nativeSessionId), params })) as T;
  };
  const nativeFrames = (type: string) => fixture.wire.filter((entry) => entry.direction === 'driver-to-native' && entry.frame.type === type);
  const isRecord = (value: Json | undefined): value is { readonly [key: string]: Json } => typeof value === 'object' && value !== null && !Array.isArray(value);
  const pendingInteractions = async () => (await store.page({ collection: 'interactions', limit: 100 })).items.filter((item) => isRecord(item.value) && item.value.phase === 'pending');

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
});

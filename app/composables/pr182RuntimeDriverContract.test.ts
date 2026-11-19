// @vitest-environment node
//
// PR #182 round 09470c6d4 — findings B/C/D reproduced against the REAL
// `createCodexDriver`. These tests drive the REAL composables (useRuntimeMessageSend
// / useRuntimeInteractions) to build the operation args, then hand those exact args
// to the REAL driver core operation. That is the contract the reviewer measured:
// the composables' payload must be accepted by the driver, not merely appear on a
// fake wire.
//
// The composable's args are captured through the recorded fake client (the same
// double the routing tests use); the driver is exercised directly, so there is no
// fake between the captured payload and the real native contract.
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseConnectionProfileId, parseSessionRef } from '../../shared/runtime/identity.js';
import type { ConnectionProfileId, EnvironmentId, HarnessInstanceId, SessionRef } from '../../shared/runtime/identity.js';
import { useRuntimeMessageSend } from './useRuntimeMessageSend';
import { useRuntimeInteractions } from './useRuntimeInteractions';
import { createFakeCapture, createFakeRuntimeActionClient } from './runtimeActions.test-helpers';

const PROFILE: ConnectionProfileId = parseConnectionProfileId('33333333-3333-4333-8333-333333333333');

type DriverHarness = Awaited<ReturnType<typeof startCodexDriver>>;

async function startCodexDriver() {
  const { createRuntimeStore } = await import('../../bridge/runtime/storage/runtimeStore.js');
  const { createRuntimeHost } = await import('../../bridge/runtime/runtimeHost.js');
  const { createWorkspaceService } = await import('../../bridge/runtime/workspaceService.js');
  const { createCodexDriver } = await import('../../bridge/runtime/drivers/codexDriver.js');

  const directory = await mkdtemp(path.join(tmpdir(), 'vis-pr182-codex-'));
  const environmentId = randomUUID() as EnvironmentId;
  const harnessInstanceId = randomUUID() as HarnessInstanceId;
  const epoch = randomUUID();
  const store = createRuntimeStore({
    stateDirectory: path.join(directory, 'runtime'),
    environmentId,
    ownerId: randomUUID(),
    epoch,
  });
  await store.ready;
  const runtime = createRuntimeHost({ environmentId, role: 'local' });
  runtime.start();

  let receive: (raw: string) => void = () => {};
  const nativeMethods: string[] = [];
  const transport = {
    subscribe(callback: (raw: string) => void): () => void {
      receive = callback;
      return () => {};
    },
    send(raw: string) {
      const message = JSON.parse(raw);
      if (typeof message.method !== 'string') return; // client response frame
      nativeMethods.push(message.method);
      let result: unknown = {};
      if (message.method === 'initialize') result = { userAgent: 'codex-cli/0.160.0 test' };
      else if (message.method === 'thread/read')
        result = { thread: { id: message.params.threadId, cwd: directory } };
      else if (message.method === 'turn/start') result = { turn: { id: 'active-turn' } };
      receive(JSON.stringify({ id: message.id, result }));
    },
    close() {},
  };

  const workspace = await createWorkspaceService({
    target: environmentId,
    epoch,
    roots: [{ root: directory, permissions: ['read', 'write'] }],
  });
  const driver = await createCodexDriver({
    environmentId,
    harnessInstanceId,
    epoch,
    processGeneration: 1,
    store,
    runtime,
    workspace,
    allowedWorkspaces: workspace.workspaces.map((root) => root.key),
    transport,
    isProcessCurrent: () => true,
  });
  const session = parseSessionRef({ environmentId, harnessInstanceId, nativeSessionId: 'native-1' });
  const scope = { environmentId, harnessInstanceId, epoch, processGeneration: 1, session };
  const operationScope = { target: environmentId, epoch, processGeneration: 1, session };

  return {
    directory,
    environmentId,
    harnessInstanceId,
    epoch,
    session,
    scope,
    operationScope,
    driver,
    nativeMethods,
    close: async () => {
      await driver.close();
      await workspace.close();
      await runtime.stop();
      await store.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

/** Capture the exact args the real composable builds for one operation. */
function capture(session: SessionRef, environmentId: EnvironmentId, harnessKind?: 'codex') {
  const client = createFakeRuntimeActionClient([environmentId]);
  const { capture: selection } = createFakeCapture(client.client.scope(environmentId), PROFILE, session);
  const ctx = {
    client: client.asClient(),
    profileId: PROFILE,
    capture: () => selection,
    ...(harnessKind ? { harnessKind } : {}),
  };
  return { client, ctx, selection };
}

const harnesses: DriverHarness[] = [];
afterEach(async () => {
  while (harnesses.length) await harnesses.pop()!.close();
});

async function driverHarness(): Promise<DriverHarness> {
  const harness = await startCodexDriver();
  harnesses.push(harness);
  return harness;
}

function requireMethod<T>(method: T | undefined, name: string): T {
  if (method === undefined) throw new Error(`driver method ${name} is unavailable`);
  return method;
}
type SentReceipt = { readonly accepted: { readonly operationId: string } };

describe('PR182 finding B — send/lifecycle args must satisfy the real Codex driver', () => {
  it('an ordinary codex send reaches turn/start instead of failing codex.params.field', async () => {
    const harness = await driverHarness();
    const { client, ctx } = capture(harness.session, harness.environmentId, 'codex');
    useRuntimeMessageSend(ctx).send(harness.session, { text: 'hello codex' });
    const args = client.calls.at(-1)!.params.args;

    const result = await requireMethod(harness.driver.registration.driver.core.send, 'send')({
      ...harness.scope,
      params: { ...args, idempotencyKey: 'send-1' },
    });
    expect(result).toBeTruthy();
    expect(harness.nativeMethods).toContain('turn/start');
  });

  it('an unsupported codex lifecycle command is rejected explicitly, never padded into session.send', () => {
    const environmentId = randomUUID() as EnvironmentId;
    const session = parseSessionRef({
      environmentId,
      harnessInstanceId: randomUUID() as HarnessInstanceId,
      nativeSessionId: 'n',
    });
    const { client, ctx } = capture(session, environmentId, 'codex');
    const send = useRuntimeMessageSend(ctx);
    expect(() => send.slash(session, 'rename', { title: 'x' })).toThrowError(/unsupported|codex/);
    expect(client.calls).toHaveLength(0);
  });
});

describe('PR182 finding C — cancelTurn must carry the native parent operationId', () => {
  it('the composable records the parent id from an accepted send and cancels with it', async () => {
    const environmentId = randomUUID() as EnvironmentId;
    const session = parseSessionRef({
      environmentId,
      harnessInstanceId: randomUUID() as HarnessInstanceId,
      nativeSessionId: 'n',
    });
    const { client, ctx } = capture(session, environmentId);
    const send = useRuntimeMessageSend(ctx);
    const turn = send.send(session, { text: 'turn' });
    await turn.accepted;
    send.cancelTurn(session);
    const cancelArgs = client.calls.filter((call) => call.method === 'session.cancel').at(-1)!.params.args;
    expect(cancelArgs).toMatchObject({ operationId: expect.any(String) });
  });

  it('cancelling the matching native owner interrupts the real active turn', async () => {
    const harness = await driverHarness();
    const core = harness.driver.registration.driver.core;
    const sent = (await requireMethod(core.send, 'send')({
      ...harness.scope,
      params: { native: { input: [{ type: 'text', text: 'turn' }] }, idempotencyKey: 'send-c' },
    })) as SentReceipt;
    const parentOperationId = sent.accepted.operationId;
    expect(typeof parentOperationId).toBe('string');

    await expect(
      requireMethod(core.cancel, 'cancel')({
        ...harness.scope,
        params: { operationId: parentOperationId },
      }),
    ).resolves.toBeTruthy();
    expect(harness.nativeMethods).toContain('turn/interrupt');
  });
});

describe('PR182 finding D — interaction replies must use the native answer field', () => {
  it('a permission reply is accepted by the real driver and reaches the native reply', async () => {
    const harness = await driverHarness();
    const core = harness.driver.registration.driver.core;
    // Bind the session process, then register a pending native approval request.
    await requireMethod(core.send, 'send')({
      ...harness.scope,
      params: { native: { input: [{ type: 'text', text: 'bind' }] }, idempotencyKey: 'bind-d' },
    });
    const interactionId = await harness.driver.interactions.pending({
      scope: harness.operationScope,
      nativeRequestId: 'req-1',
      payload: { method: 'item/commandExecution/requestApproval', params: {} },
    });
    const { client, ctx } = capture(harness.session, harness.environmentId);
    useRuntimeInteractions(ctx).permission(harness.session, interactionId, { decision: 'accept' });
    const args = client.calls.at(-1)!.params.args;

    const result = await requireMethod(core.respondInteraction, 'respondInteraction')({
      ...harness.scope,
      params: args,
    });
    expect(result).toBeTruthy();
  });
});

// @vitest-environment node
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createRuntimeStore } from '../../../bridge/runtime/storage/runtimeStore.js';
import { createOperationJournal, fingerprint } from '../../../bridge/runtime/operationJournal.js';
import { createInteractionStore } from '../../../bridge/runtime/interactionStore.js';
import { createKimiWebRecovery } from '../../../bridge/runtime/drivers/kimiWebRecovery.js';
import { encodeSessionKey, parseEnvironmentId, parseSessionRef } from '../../../shared/runtime/identity.js';
import { transcriptSnapshot } from '../../../shared/runtime/native/kimiWeb/transcript.js';

const environmentId = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const session = parseSessionRef({ environmentId, harnessInstanceId: '22222222-2222-4222-8222-222222222222', nativeSessionId: 'restart-owned' });

it.each(['owned', 'legacy-row', 'interrupted-adoption', 'legacy-process-mismatch', 'legacy-current-process', 'current-generation-conflict', 'foreign-prompt', 'wrong-turn', 'replying', 'lease-race', 'process-race', 'stale-callback', 'foreign-session', 'same-epoch'])('fences durable task adoption: %s', async mode => {
  const directory = await mkdtemp(path.join(tmpdir(), 'kimi-adoption-'));
  const previous = { target: environmentId, session, epoch: randomUUID(), processGeneration: 1 };
  let store = createRuntimeStore({ stateDirectory: directory, environmentId, ownerId: randomUUID(), epoch: previous.epoch });
  await store.ready;
  try {
    const journal = createOperationJournal({ store, isProcessCurrent: scope => scope.epoch === previous.epoch });
    const accepted = await journal.accept({ scope: previous, method: 'send', payload: { prompt_id: 'vis-owned' }, idempotencyKey: 'owned-send' });
    await journal.execute(accepted.operationId, previous, async () => ({ prompt_id: 'vis-owned' }));
    const bindingKey = `kimi-native:${accepted.operationId}`;
    const leaseKey = `lease:${fingerprint(encodeSessionKey(session))}`;
    const processKey = `process:${fingerprint(encodeSessionKey(session))}`;
    const interactionKey = `interaction:${fingerprint([encodeSessionKey(session), previous.epoch, 1, 'question-owned'])}`;
    await store.mutateControl({ intentId: randomUUID(), changes: [
      { collection: 'operations', key: processKey, value: { epoch: mode === 'legacy-process-mismatch' ? randomUUID() : previous.epoch, generation: 1, alive: mode === 'legacy-process-mismatch' } },
      { collection: 'operations', key: bindingKey, value: { scope: previous, operationId: accepted.operationId, promptId: 'vis-owned', turnId: 'turn-owned' } },
      { collection: 'operations', key: `kimi-interaction:${interactionKey}`, value: { scope: previous, parentOperationId: accepted.operationId } },
      { collection: 'interactions', key: interactionKey, value: { kind: 'interaction', scope: previous, nativeRequestId: 'question-owned', ...(mode === 'legacy-row' ? {} : { parentOperationId: accepted.operationId }), phase: mode === 'replying' ? 'replying' : 'pending' } },
    ] });
    await store.close();
    const epoch = mode === 'same-epoch' ? previous.epoch : randomUUID();
    store = createRuntimeStore({ stateDirectory: directory, environmentId, ownerId: randomUUID(), epoch });
    await store.ready;
    const scope = { ...previous, epoch, processGeneration: mode === 'same-epoch' ? 2 : 1 };
    if (mode === 'foreign-session') {
      const row = await store.getControl({ collection: 'operations', key: accepted.operationId });
      await store.mutateControl({ intentId: randomUUID(), changes: [{ collection: 'operations', key: accepted.operationId, expectedRevision: row!.revision, value: { ...row!.value as object, scope: { ...previous, session: { ...session, nativeSessionId: 'foreign' } } } }] });
    }
    if (mode === 'legacy-current-process' || mode === 'current-generation-conflict') {
      const prior = await store.getControl({ collection: 'operations', key: processKey });
      await store.mutateControl({ intentId: randomUUID(), changes: [{ collection: 'operations', key: processKey, expectedRevision: prior!.revision, value: { epoch, generation: mode === 'current-generation-conflict' ? 2 : 1, alive: true } }] });
    }
    const mutate = store.mutateControl.bind(store);
    let raced = false;
    if (mode === 'lease-race' || mode === 'process-race') store.mutateControl = async input => {
      if (!raced && input.changes.some(change => change.key === accepted.operationId)) {
        raced = true;
        const key = mode === 'lease-race' ? leaseKey : processKey;
        const row = await store.getControl({ collection: 'operations', key });
        await mutate({ intentId: randomUUID(), changes: [{ collection: 'operations', key, expectedRevision: row!.revision, value: mode === 'lease-race' ? { operationId: 'new-owner', runtimeOwner: true } : { epoch, generation: 2, alive: true } }] });
      }
      return mutate(input);
    };
    const recovery = createKimiWebRecovery({ store, isCurrent: () => mode !== 'stale-callback' });
    const page = transcriptSnapshot({ items: [{ kind: 'turn', turnId: mode === 'wrong-turn' ? 'other' : 'turn-owned', triggerPromptId: mode === 'foreign-prompt' ? 'external' : 'vis-owned', state: 'running', steps: [{ frames: [{ kind: 'tool', toolCallId: 'tool-owned', name: 'AskUserQuestion' }] }] }], interactions: [{ interactionId: 'question-owned', toolCallId: 'tool-owned', state: 'pending' }] });
    if (['wrong-turn', 'replying', 'lease-race', 'process-race', 'stale-callback', 'current-generation-conflict'].includes(mode)) {
      await expect(recovery.adopt(scope, page)).rejects.toBeDefined();
    } else if (!['owned', 'legacy-row', 'interrupted-adoption', 'legacy-process-mismatch', 'legacy-current-process'].includes(mode)) {
      expect(await recovery.adopt(scope, page)).toBeNull();
    } else {
      expect(await recovery.adopt(scope, page)).toEqual(previous);
      expect(await recovery.adopt(scope, page)).toEqual(previous);
      await recovery.retire(scope, previous, 'question-owned', accepted.operationId);
      expect((await store.getControl({ collection: 'interactions', key: interactionKey }))?.value).toMatchObject({ phase: 'invalidated' });
      expect((await store.getControl({ collection: 'operations', key: accepted.operationId }))?.value).toMatchObject({ scope, initialScope: previous, phase: 'observed' });
      expect((await store.getControl({ collection: 'operations', key: processKey }))?.value).toMatchObject({ epoch, generation: scope.processGeneration, alive: true });
      if (mode === 'interrupted-adoption') {
        // Crash boundary: the atomic adoption completed but no in-memory token was resumed.
        await store.close();
        const next = { ...scope, epoch: randomUUID() };
        store = createRuntimeStore({ stateDirectory: directory, environmentId, ownerId: randomUUID(), epoch: next.epoch });
        await store.ready;
        await createKimiWebRecovery({ store, isCurrent: candidate => candidate.epoch === next.epoch }).adopt(next, page);
        await createInteractionStore({ store }).resumeProcess(next);
        expect((await store.getControl({ collection: 'operations', key: accepted.operationId }))?.value).toMatchObject({ scope: next, initialScope: previous, phase: 'observed' });
        expect((await store.getControl({ collection: 'operations', key: processKey }))?.value).toMatchObject({ epoch: next.epoch, generation: 1, alive: true });
      }
    }
    if (!['owned', 'legacy-row', 'interrupted-adoption', 'legacy-process-mismatch', 'legacy-current-process'].includes(mode)) expect((await store.getControl({ collection: 'operations', key: accepted.operationId }))?.value).toMatchObject({ scope: { epoch: previous.epoch }, phase: 'observed' });
  } finally { await store.close(); await rm(directory, { recursive: true, force: true }); }
}, 30000);

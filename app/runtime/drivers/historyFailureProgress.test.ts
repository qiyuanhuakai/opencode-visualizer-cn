// @vitest-environment node
import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createOpenCodeHistory } from '../../../bridge/runtime/drivers/openCodeHistory.js';
import { createKimiWebHistoryProducer } from '../../../bridge/runtime/drivers/kimiWebHistory.js';
import { createDshHistory } from '../../../bridge/runtime/drivers/dshHistory.js';
import { createHistoryDiskBudget, createHistoryStream } from '../../../bridge/runtime/historyStream.js';
import { ProtocolError } from '../../../shared/runtime/capabilities.js';
import { parseSessionRef } from '../../../shared/runtime/identity.js';

it.each(['opencode', 'kimi', 'dsh'] as const)('%s retains unseen history progress when its observer fails', async (kind) => {
  const session = parseSessionRef({ environmentId: randomUUID(), harnessInstanceId: randomUUID(), nativeSessionId: 'selected' });
  let reads = 0;
  const observer = {
    async next(): Promise<IteratorResult<unknown>> {
      if (reads++ === 0) return { done: false, value: { type: 'message.updated', session } };
      throw new ProtocolError('replay_required', 'controlled.observer_overflow');
    },
    async return(): Promise<IteratorResult<unknown>> { return { done: true, value: undefined }; },
  };
  const options = {
    session, authority: { epoch: randomUUID(), processGeneration: 1, generation: 1 },
    current: () => true, assertCurrent: async () => {}, subscribe: () => observer, randomUUID,
    pull: async () => { throw new Error('Invalidation must not pull transcript'); },
    pullPage: async () => { throw new Error('Invalidation must not pull transcript'); },
    pullSnapshot: async () => { throw new Error('Invalidation must not pull transcript'); },
    releaseOwner() {}, sessionEpoch: () => undefined,
    fence: () => ({ generation: 1, revision: 1, cursor: 1 }),
  };
  const handle = kind === 'opencode' ? createOpenCodeHistory(options) : kind === 'kimi' ? createKimiWebHistoryProducer(options) : createDshHistory(options);
  const store = createHistoryStream({ scope: `failure-progress-${kind}`, globalDisk: createHistoryDiskBudget(), createDirectory: async () => { throw new Error('Invalidation must not allocate spool'); } });
  const signal = new AbortController().signal;
  try {
    await handle.open({ signal, streamStore: store });
    for (let index = 0; index < 12; index++) await Promise.resolve();
    expect(await handle.read({ after: 0, signal })).toEqual({ through: 1, changed: true, status: 'replay_required' });
    expect(await handle.read({ after: 1, signal })).toEqual({ through: 1, changed: false, status: 'replay_required' });
  } finally { await handle.close(); await store.close(); }
});

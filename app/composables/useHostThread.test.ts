import { expect, it, vi } from 'vitest';
import { createHostThreadState } from './useHostThread';
import type { HostClient } from '../runtime/hostClient';
import { parseEnvironmentId, parseHarnessInstanceId, parseSessionRef, parseRepoRef } from '../../shared/runtime/identity.js';

it('retains its captured Host when the conversation Host changes and refuses writes after that owner expires', async () => {
  const target = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
  const harness = parseHarnessInstanceId('22222222-2222-4222-8222-222222222222');
  const threadId = '33333333-3333-4333-8333-333333333333';
  const session = parseSessionRef({ environmentId: target, harnessInstanceId: harness, nativeSessionId: 'owner' });
  const repo = parseRepoRef({ environmentId: target, canonicalCommonDir: '/repo/.git', pathPolicy: { platform: 'posix', volumeId: '/', caseSensitive: true } });
  let current = true, writes = 0, subscriptions = 0;
  let notifyChanged = () => {};
  const firstRead = Promise.withResolvers<void>();
  const replacementRead = Promise.withResolvers<void>();
  const latestRead = Promise.withResolvers<void>();
  const backgroundRead = Promise.withResolvers<void>();
  const notificationReads = Array.from({ length: 5 }, () => Promise.withResolvers<void>());
  let snapshotReads = 0;
  const page = (collection: string) => ({ offset: 0, limit: 50, counts: { [collection]: 0 } });
  const owner: HostClient = {
    target, isCurrent: () => current,
    onChanged: callback => { notifyChanged = callback; subscriptions++; return () => { subscriptions--; }; },
    read: async (call, decode) => {
      if (call.operation === 'snapshot') {
        const revision = ++snapshotReads;
        if (revision === 1) await firstRead.promise;
        if (revision === 2) await replacementRead.promise;
        if (revision === 3) await latestRead.promise;
        if (revision === 4) await backgroundRead.promise;
        await notificationReads[revision - 5]?.promise;
        return decode({ thread: { threadId, environmentId: target, repoKey: 'repo', revision, activeParticipantId: null, harnessInstanceIds: [harness], participants: [] } });
      }
      if (call.operation === 'participants') return decode({ participants: [], pagination: page('participants') });
      if (call.operation === 'handoffs') return decode({ handoffs: [], pagination: page('handoffs') });
      if (call.operation === 'timeline') return decode({ entries: [], total: 0, nextCursor: null });
      return decode(null);
    },
    mutate: (_call, decode) => {
      writes++;
      return { accepted: Promise.resolve({ operationId: 'operation' }), executed: Promise.resolve(decode({ threadId })) };
    },
  };
  let selected: HostClient | null = owner;
  const state = createHostThreadState(() => selected);
  let opened = false;
  const opening = state.openThread({ session, repo }).then(() => { opened = true; });
  await vi.waitFor(() => expect(snapshotReads).toBe(1));
  notifyChanged();
  await vi.waitFor(() => expect(snapshotReads).toBe(2));
  firstRead.resolve();
  await new Promise<void>(resolve => setTimeout(resolve, 0));
  expect(opened).toBe(false);
  expect(state.busy.value).toBe(true);
  notifyChanged();
  await vi.waitFor(() => expect(snapshotReads).toBe(3));
  latestRead.resolve();
  try {
    await vi.waitFor(() => expect(opened).toBe(true));
    expect(state.summary.value?.revision).toBe(3);
    expect(state.busy.value).toBe(false);
  } finally {
    replacementRead.resolve();
  }
  await opening;
  notifyChanged();
  await vi.waitFor(() => expect(snapshotReads).toBe(4));
  expect(state.busy.value).toBe(false);
  backgroundRead.resolve();
  await vi.waitFor(() => expect(state.summary.value?.revision).toBe(4));
  const race = vi.spyOn(Promise, 'race');
  try {
    for (const read of notificationReads) {
      notifyChanged();
      await Promise.resolve();
      await Promise.resolve();
      read.resolve();
    }
    expect(race).toHaveBeenCalledTimes(notificationReads.length);
  } finally {
    race.mockRestore();
    for (const read of notificationReads) read.resolve();
  }
  await vi.waitFor(() => expect(state.summary.value?.revision).toBe(9));
  expect(state.error.value).toBe('');
  const captured = state.owner.value;
  expect(captured?.host).toBe(owner);
  expect(subscriptions).toBe(1);
  selected = { ...owner, target: parseEnvironmentId('44444444-4444-4444-8444-444444444444') };
  expect(state.owner.value).toBe(captured);
  expect(state.owner.value?.target).toBe(target);
  current = false;
  await state.joinThread({ ...session, nativeSessionId: 'other' });
  expect(writes).toBe(1);
  expect(state.error.value).toContain('Bridge');
  expect(state.threadId.value).toBe(threadId);
  await expect(state.reconnectHost({ ...owner, target: parseEnvironmentId('44444444-4444-4444-8444-444444444444'), isCurrent: () => true })).rejects.toThrow('original Thread Bridge');
  expect(state.owner.value).toBe(captured);
  const recovered = { ...owner, isCurrent: () => true };
  await state.reconnectHost(recovered);
  expect(state.owner.value?.host).toBe(recovered);
  expect(state.owner.value?.generation).toBeGreaterThan(captured?.generation ?? 0);
  expect(state.threadId.value).toBe(threadId);
  expect(state.error.value).toBe('');
  expect(writes).toBe(1);
  expect(subscriptions).toBe(1);
  state.closeThread();
  expect(state.owner.value).toBeNull();
  expect(subscriptions).toBe(0);
});

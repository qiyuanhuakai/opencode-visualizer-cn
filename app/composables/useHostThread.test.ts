import { expect, it } from 'vitest';
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
  const page = (collection: string) => ({ offset: 0, limit: 50, counts: { [collection]: 0 } });
  const owner: HostClient = {
    target, isCurrent: () => current,
    onChanged: () => { subscriptions++; return () => { subscriptions--; }; },
    read: async (call, decode) => {
      if (call.operation === 'snapshot') return decode({ thread: { threadId, environmentId: target, repoKey: 'repo', revision: 1, activeParticipantId: null, harnessInstanceIds: [harness], participants: [] } });
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
  await state.openThread({ session, repo });
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

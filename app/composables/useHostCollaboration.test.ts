import { expect, it } from 'vitest';
import { createHostCollaborationState } from './useHostCollaboration';
import type { HostClient } from '../runtime/hostClient';
import { parseEnvironmentId, parseHarnessInstanceId, parseSessionRef } from '../../shared/runtime/identity.js';

it('recovers the same team through a new same-target Host without replaying mutations or assigning another conversation Host', async () => {
  const target = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
  const threadId = '33333333-3333-4333-8333-333333333333', teamId = 'team-fixture';
  const session = parseSessionRef({ environmentId: target, harnessInstanceId: parseHarnessInstanceId('22222222-2222-4222-8222-222222222222'), nativeSessionId: 'owner' });
  let current = true, subscriptions = 0, mutations = 0, name = 'Original team';
  const page = (collection: string) => ({ offset: 0, limit: 50, counts: { [collection]: 0 } });
  const original: HostClient = {
    target, isCurrent: () => current,
    onChanged: () => { subscriptions++; return () => { subscriptions--; }; },
    mutate: () => { mutations++; throw new Error('Recovery must never replay a mutation'); },
    read: async (call, decode) => {
      if (call.operation === 'teamForThread') return decode({ teamId, name });
      if (call.operation === 'snapshot') return decode({ threadId, team: { teamId, name }, tasks: [], attempts: [], pagination: page('tasks') });
      if (call.operation === 'budgets') return decode({ limits: {}, used: {} });
      if (call.operation === 'membersPage') return decode({ members: [], pagination: page('members') });
      if (call.operation === 'fanoutsPage') return decode({ threadId, teamId, fanouts: [], pagination: page('fanouts') });
      throw new Error(`Unexpected read ${call.operation}`);
    },
  };
  let selected: HostClient = original;
  const state = createHostCollaborationState(() => selected);
  await state.openTeam({ threadId, teamName: 'Ignored existing name', environmentId: target, owner: { participantId: 'participant', session }, lease: { ownerId: 'owner', expiresAt: Date.now() + 10000 } });
  expect(state.error.value).toBe('');
  expect(state.team.value?.name).toBe('Original team');
  expect(subscriptions).toBe(1);
  selected = { ...original, target: parseEnvironmentId('44444444-4444-4444-8444-444444444444'), isCurrent: () => true };
  current = false;
  await expect(state.reconnectHost(selected)).rejects.toThrow('original team Bridge');
  expect(state.team.value?.teamId).toBe(teamId);
  name = 'Recovered team';
  await state.reconnectHost({ ...original, isCurrent: () => true });
  expect(state.error.value).toBe('');
  expect(state.team.value).toMatchObject({ teamId, name: 'Recovered team' });
  expect(state.threadId.value).toBe(threadId);
  expect(mutations).toBe(0);
  expect(subscriptions).toBe(1);
  state.closeTeam();
  expect(subscriptions).toBe(0);
});

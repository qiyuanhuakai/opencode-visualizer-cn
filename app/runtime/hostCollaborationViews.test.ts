import { describe, expect, it } from 'vitest';
import { createCollaborationCoordinator } from '../../bridge/runtime/collaboration/coordinator.js';
import { parseSessionRef } from '../../shared/runtime/identity.js';
import { hostTask, hostTeam } from './hostCollaborationViews';

describe('Bridge collaboration read projections', () => {
  it('preserves real coordinator review state across the JSON boundary', async () => {
    const coordinator = createCollaborationCoordinator({ deliver: async () => ({ ackId: 'native-ack' }) });
    try {
      const team = coordinator.createTeam({ name: 'Bridge team' });
      const session = parseSessionRef({
        environmentId: '11111111-1111-4111-8111-111111111111',
        harnessInstanceId: '22222222-2222-4222-8222-222222222222',
        nativeSessionId: 'native-session',
      });
      const task = coordinator.createTask({
        teamId: team.teamId, title: 'Persist the real task',
        criteria: [{ id: 'criterion', text: 'Survives restart', required: true }],
        owner: { participantId: '33333333-3333-4333-8333-333333333333', session },
        lease: { ownerId: '44444444-4444-4444-8444-444444444444', expiresAt: Date.now() + 60_000 },
      });
      const projected = hostTask(JSON.parse(JSON.stringify(task)));
      expect(projected.phase).toBe('pending');
      expect(projected.owner.session).toEqual(session);
      expect(projected.criteria).toEqual([{ id: 'criterion', text: 'Survives restart', required: true }]);
      expect(hostTeam({ ...team, members: [] }).teamId).toBe(team.teamId);
      const dispatched = await coordinator.dispatch({ taskId: task.taskId });
      expect(hostTask(JSON.parse(JSON.stringify(dispatched.task))).phase).toBe('dispatched');
      expect(projected.acceptance.state).toBe('none');
    } finally {
      coordinator.close();
    }
  });

  it('refuses malformed server state instead of inventing missing review or identity data', () => {
    expect(() => hostTask({ taskId: 'partial', state: 'accepted' })).toThrow();
    expect(() => hostTeam({ teamId: 'team', name: 'Bad member', members: [{ role: 'owner' }] })).toThrow();
  });
});

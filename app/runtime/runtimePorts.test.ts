/**
 * The app-side port composition (tasks 52 and 53).
 *
 * The ports are the seam `useRuntimeThread.ts` and `useRuntimeCollaboration.ts`
 * declare; this test proves the container composes the REAL landed services over
 * them, and that the two structural guarantees the wiring must not weaken
 * survive the composition:
 *
 *   * a handoff becomes `active` ONLY through a real native observation — an ack
 *     (a delivery outcome) and a native end of any kind cannot reach it;
 *   * a native end NEVER renders a task `accepted` — `accepted` is reachable only
 *     through the acceptance sink.
 *
 * Both are the services' own derivations; nothing here re-implements them.
 */
import { describe, expect, it } from 'vitest';

import type { RepoRef, SessionRef } from '../../shared/runtime/identity.js';
import { parseSessionRef } from '../../shared/runtime/identity.js';
import { createRuntimeCollaborationState } from '../composables/useRuntimeCollaboration';
import { createRuntimeThreadState } from '../composables/useRuntimeThread';
import { createAppCollaborationPorts } from './collaborationPorts';
import { createAppThreadPorts } from './threadPorts';

const ENV = '11111111-1111-4111-8111-111111111111';
const H_A = '22222222-2222-4222-8222-222222222222';
const H_B = '33333333-3333-4333-8333-333333333333';
const P_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const P_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const THREAD = 'cccccccc-1111-4111-8111-111111111111';
const ARTIFACT_HASH = 'a'.repeat(64);

const REPO = {
  environmentId: ENV,
  canonicalCommonDir: '/repo',
  pathPolicy: { platform: 'posix', volumeId: 'vol', caseSensitive: true },
} as unknown as RepoRef;
const A = parseSessionRef({ environmentId: ENV, harnessInstanceId: H_A, nativeSessionId: 'session-a' });
const B = parseSessionRef({ environmentId: ENV, harnessInstanceId: H_B, nativeSessionId: 'session-b' });

const ENTRIES = Object.freeze([
  { class: 'goal', origin: { kind: 'host', commandId: 'cmd-1' }, text: 'Ship the thread UI' },
]);

function threadPorts(sendOutcome: 'ack' | 'ambiguous') {
  return createAppThreadPorts({
    resolveSession: async (ref: SessionRef) => ({ session: ref, archived: false, parentSession: null }),
    openTarget: async ({ target }) => ({ nativeSessionId: target.session.nativeSessionId }),
    sendPrompt: async () => (sendOutcome === 'ambiguous' ? { ackId: '' } : { ackId: 'ack-1' }),
  });
}

async function openThread(state: ReturnType<typeof createRuntimeThreadState>): Promise<void> {
  await state.openThread({ session: A, repo: REPO });
  await state.joinThread(B);
}

describe('the app-side Thread ports over the real task-31/34 services', () => {
  it('renders active only after a real native observation, never after an ack', async () => {
    // Given: a thread with two participants and a readable delivery.
    const state = createRuntimeThreadState(threadPorts('ack'));
    await openThread(state);
    const source = state.summary.value!.participants[0]!.participantId;
    const target = state.summary.value!.participants[1]!.participantId;

    // When: the whole ladder runs up to delivery.
    await state.beginHandoff({ sourceParticipantId: source, targetParticipantId: target, prompt: 'carry this', entries: ENTRIES });
    await state.prepareHandoff('carry this');
    await state.deliverHandoff();

    // Then: the handoff is delivered and NOT active — an ack is a delivery
    // outcome, and `projectHandoffState` reaches `active` only through
    // `observation.observed`.
    expect(state.handoff.value?.state).toBe('delivered');
    expect(state.handoff.value?.active).toBe(false);

    // When: a real native event id is observed.
    await state.observeHandoff('native-event-1');

    // Then: and only then is the handoff active.
    expect(state.handoff.value?.state).toBe('active');
    expect(state.handoff.value?.active).toBe(true);
  });

  it('stops at reconcile on an unreadable send, and never marks it successful', async () => {
    // Given: a delivery whose outcome cannot be read.
    const state = createRuntimeThreadState(threadPorts('ambiguous'));
    await openThread(state);
    const source = state.summary.value!.participants[0]!.participantId;
    const target = state.summary.value!.participants[1]!.participantId;

    // When: the ladder runs.
    await state.beginHandoff({ sourceParticipantId: source, targetParticipantId: target, prompt: 'carry this', entries: ENTRIES });
    await state.prepareHandoff('carry this');
    await state.deliverHandoff();

    // Then: the ambiguous send is a stop, not progress, and never active.
    expect(state.handoff.value?.state).toBe('reconcile');
    expect(state.handoff.value?.active).toBe(false);
  });

  it('refuses an observation that carries no real native event id', async () => {
    const state = createRuntimeThreadState(threadPorts('ack'));
    await openThread(state);
    const source = state.summary.value!.participants[0]!.participantId;
    const target = state.summary.value!.participants[1]!.participantId;
    await state.beginHandoff({ sourceParticipantId: source, targetParticipantId: target, prompt: 'carry this', entries: ENTRIES });
    await state.prepareHandoff('carry this');
    await state.deliverHandoff();
    await state.observeHandoff('');

    expect(state.handoff.value?.state).toBe('delivered');
    expect(state.handoff.value?.active).toBe(false);
    expect(state.error.value).toMatch(/native observation/u);
  });
});

function collaborationPorts() {
  return createAppCollaborationPorts({
    deliverAttempt: async () => ({ ackId: 'ack-1' }),
    deliverDelegation: async () => ({ ackId: 'ack-2' }),
    deliverFanout: async (target) => ({ ackId: `ack-${target.participantId}` }),
  });
}

describe('the app-side collaboration ports over the real task-37/38/39 services', () => {
  it('keeps native ended distinct from accepted, and accepted reachable only through acceptance', async () => {
    // Given: a team under a captured Thread target with a lead and a worker.
    const state = createRuntimeCollaborationState(collaborationPorts());
    await state.openTeam({
      threadId: THREAD,
      teamName: 'Vis Team',
      environmentId: ENV,
      owner: { participantId: P_A, session: A },
      lease: { ownerId: P_A, expiresAt: 9_999_999_999_999 },
    });
    state.addMember({ role: 'worker', harnessKind: 'codex', session: B, participantId: P_B });
    state.createTask({ title: 'Render three distinct phases', criteria: [{ id: 'c1', text: 'phases', required: true }] });
    const taskId = state.tasks.value[0]!.taskId;

    // When: the attempt is dispatched, sent and its native end is recorded.
    await state.dispatchTask(taskId);
    await state.sendTask(taskId);
    state.finishTask(taskId, 'native-event-1');

    // Then: the native end reaches agent-finished and NEVER accepted — the
    // attempt's native sink writes only the observation slice.
    expect(state.tasks.value[0]!.phase).toBe('agent-finished');

    // When: the deliverable is registered and submitted for review.
    state.registerDeliverable(taskId, { deliverableId: 'del-1', artifactHash: ARTIFACT_HASH, bytes: 12, paths: ['a.ts'] });
    state.submitForReview(taskId, 'reviewer-1');

    // Then: review pending is its own phase.
    expect(state.tasks.value[0]!.phase).toBe('review-pending');

    // When: the review is approved and the deliverable is accepted.
    state.approveReview(taskId, 'reviewer-1');
    state.acceptTask(taskId, { deliverableId: 'del-1', acceptedBy: 'reviewer-1', criteria: [{ id: 'c1', met: true }] });

    // Then: accepted comes solely from the acceptance sink.
    expect(state.tasks.value[0]!.phase).toBe('accepted');
  });

  it('reports a fan-out whose recipient could not be read as failed, not as sent', async () => {
    const state = createRuntimeCollaborationState(
      createAppCollaborationPorts({
        deliverAttempt: async () => ({ ackId: 'ack-1' }),
        deliverDelegation: async () => ({ ackId: 'ack-2' }),
        deliverFanout: async (target) => {
          if (target.participantId === P_B) {
            throw Object.assign(new Error('source unavailable'), { code: 'source_unavailable' });
          }
          return { ackId: `ack-${target.participantId}` };
        },
      }),
    );
    await state.openTeam({
      threadId: THREAD,
      teamName: 'Vis Team',
      environmentId: ENV,
      owner: { participantId: P_A, session: A },
      lease: { ownerId: P_A, expiresAt: 9_999_999_999_999 },
    });
    await state.fanOut('one prompt', [
      { participantId: P_A, session: A },
      { participantId: P_B, session: B },
    ]);

    const fanout = state.fanout.value;
    expect(fanout).not.toBeNull();
    const byParticipant = new Map(fanout!.targets.map((target) => [target.participantId, target.outcome]));
    expect(byParticipant.get(P_A)).toBe('sent');
    expect(byParticipant.get(P_B)).toBe('failed');
    // The failed recipient's reason crosses the port under the name the receiver declares.
    const failed = fanout!.targets.find((target) => target.participantId === P_B);
    expect(failed?.resolutionCode).toBe('source_unavailable');
  });

  it('refuses an operation on a task captured under a different Thread target', async () => {
    const state = createRuntimeCollaborationState(collaborationPorts());
    await state.openTeam({
      threadId: THREAD,
      teamName: 'Vis Team',
      environmentId: ENV,
      owner: { participantId: P_A, session: A },
      lease: { ownerId: P_A, expiresAt: 9_999_999_999_999 },
    });
    state.createTask({ title: 'scoped', criteria: [{ id: 'c1', text: 'scope', required: true }] });
    const taskId = state.tasks.value[0]!.taskId;
    state.closeTeam();

    state.dispatchTask(taskId);
    expect(state.error.value).toMatch(/Thread target/u);
  });
});

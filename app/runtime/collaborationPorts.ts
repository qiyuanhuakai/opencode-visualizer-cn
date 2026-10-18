/**
 * The app-side seat of the collaboration ports (task 53).
 *
 * `useRuntimeCollaboration.ts` is the UI's seat; it consumes the landed task-37
 * coordinator, the task-38 fan-out service and the task-39 delegation service
 * through narrow ports, and this module is where the container composes them.
 * Nothing here re-implements a phase, a DAG rule or an acceptance rule: the
 * three-state distinction the UI renders (`deriveTaskPhase`) reads frozen
 * product slices, and `accepted` is reachable only through the acceptance sink
 * — the attempt's native sink writes the observation slice and nothing else, so
 * a native end structurally cannot render `accepted`.
 *
 * The three native seams are injected, never assumed: each service declares its
 * own delivery seam and the container injects the app's real send path, so a
 * fan-out recipient's outcome is whatever that path observed.
 *
 * The task-40 writer-lease service is deliberately NOT composed here: it
 * allocates a real git worktree on the target through `node:fs` /
 * `node:child_process`, which only the Bridge realm can do, and no wire method
 * exposes it yet. The composable's own honest message ("the writer-lease
 * service is not wired to this surface yet") is therefore what the UI shows for
 * that one action; the review and the explicit apply-approve need no lease and
 * keep working.
 */
import { createCollaborationCoordinator } from '../../bridge/runtime/collaboration/coordinator.js';
import { createDelegationService } from '../../bridge/runtime/collaboration/delegationService.js';
import { createFanoutService } from '../../bridge/runtime/collaboration/fanoutService.js';
import { createMailbox } from '../../bridge/runtime/collaboration/mailbox.js';
import type { SessionRef } from '../../shared/runtime/identity.js';
import type { RuntimeCollaborationPorts } from '../composables/useRuntimeCollaboration';

export interface CollaborationNativeSeams {
  /** Deliver a dispatched attempt's prompt to its owner's native session. */
  readonly deliverAttempt: (payload: unknown) => Promise<{ ackId: string }>;
  /** Deliver a delegation message to the member's native session. */
  readonly deliverDelegation: (payload: unknown) => Promise<{ ackId: string }>;
  /** Deliver one fan-out recipient's prompt to that recipient's own session. */
  readonly deliverFanout: (target: {
    readonly participantId: string;
    readonly session: SessionRef;
    readonly attachmentPath: string | null;
    readonly prompt: string;
  }) => Promise<{ ackId: string }>;
}

export function createAppCollaborationPorts(seams: CollaborationNativeSeams): RuntimeCollaborationPorts {
  const fanout = createFanoutService({ deliver: seams.deliverFanout });
  return {
    coordinator: createCollaborationCoordinator({ deliver: seams.deliverAttempt }),
    delegation: createDelegationService({ mailbox: createMailbox(), deliver: seams.deliverDelegation }),
    fanout: {
      createFanout: (input) => fanout.createFanout(input),
      dispatch: async (input) => bridgeFanoutView(await fanout.dispatch(input)),
      close: () => fanout.close(),
    },
    writer: null,
  };
}

/**
 * The RECEIVER's contract: the composable's `CollaborationRecipientView` declares
 * `resolutionCode: string | null`, while task 38's own recipient view carries the
 * resolution as an OBJECT under `resolution` ({ code, field }). Forwarding the
 * service's view unchanged would hand the receiver a field it never declares, so
 * a failed recipient's code would render as nothing. The port therefore bridges
 * the service's name onto the name the receiver declares and drops nothing: the
 * service's own `resolution` object still crosses verbatim.
 */
function bridgeFanoutView(
  view: Awaited<ReturnType<ReturnType<typeof createFanoutService>['dispatch']>>,
): Awaited<ReturnType<NonNullable<RuntimeCollaborationPorts['fanout']>['dispatch']>> {
  const targets = (view.targets as readonly unknown[]).map((target) => {
    const record = target as Record<string, unknown> & { resolution?: { code?: string } | null };
    return { ...record, resolutionCode: record.resolution?.code ?? null };
  });
  return { ...view, targets } as unknown as Awaited<ReturnType<NonNullable<RuntimeCollaborationPorts['fanout']>['dispatch']>>;
}

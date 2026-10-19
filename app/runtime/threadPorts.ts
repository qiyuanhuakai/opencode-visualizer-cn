/**
 * The app-side seat of the Host Thread ports (task 52).
 *
 * `useRuntimeThread.ts` is the UI's seat; it consumes the landed task-31 Thread
 * service and the landed task-34 Handoff service through narrow ports, and this
 * module is where the container composes them. Nothing here re-implements a
 * ladder, a journal or a derivation: every rule the UI renders — including
 * `projectHandoffState`, which is the ONLY writer of `active` and reaches it
 * solely through `observation.observed` — is the product's own code.
 *
 * The three native seams are injected, never assumed:
 *   * `resolveSession` answers whether a native SessionRef exists, is archived,
 *     and which native parent it carries. The container resolves it against the
 *     live unified session index; an unknown session is refused by the service,
 *     never invented here.
 *   * `openTarget` opens the target participant's OWN native session in the
 *     running app, because a handoff binds the target's own session and nothing
 *     else.
 *   * `sendPrompt` delivers the carried prompt over the app's real send path and
 *     answers with the ack that path observed. An outcome it cannot read is
 *     reported by returning no ack, which the service records as ambiguous —
 *     never retried, never marked successful.
 */
import { createCheckpointService } from '../../bridge/runtime/threads/checkpointService.js';
import { createHandoffService } from '../../bridge/runtime/threads/handoffService.js';
import { createThreadService } from '../../bridge/runtime/threads/threadService.js';
import type { ThreadService } from '../../bridge/runtime/threads/threadService.js';
import type { ThreadSessionSource } from '../../shared/runtime/thread.js';
import type { SessionRef } from '../../shared/runtime/identity.js';
import type { RuntimeThreadPorts } from '../composables/useRuntimeThread';
import { createTurnTimeline } from './timeline';

/** One native session as the live session index knows it. */
export interface RuntimeSessionRecord {
  readonly session: SessionRef;
  readonly archived: boolean;
  readonly parentSession: SessionRef | null;
}

export interface ThreadNativeSeams {
  /** Resolve a native SessionRef against the live session index. */
  readonly resolveSession: ThreadSessionSource;
  /** Open the target participant's OWN native session in the running app. */
  readonly openTarget: (input: {
    readonly threadId: string;
    readonly handoffId: string;
    readonly target: Readonly<{ participantId: string; session: SessionRef }>;
  }) => Promise<{ nativeSessionId: string }>;
  /** Deliver the carried prompt over the app's real send path. */
  readonly sendPrompt: (input: {
    readonly threadId: string;
    readonly handoffId: string;
    readonly target: Readonly<{ participantId: string; session: SessionRef }>;
    readonly prompt: string;
    readonly promptFingerprint: string;
  }) => Promise<{ ackId?: string }>;
}

export function createAppThreadPorts(seams: ThreadNativeSeams): RuntimeThreadPorts {
  const threads: ThreadService = createThreadService({ resolveSession: seams.resolveSession });
  const checkpoints = createCheckpointService();
  const handoff = createHandoffService({
    threads,
    checkpoints,
    openTarget: seams.openTarget,
    sendPrompt: seams.sendPrompt,
  });
  return { thread: threads, handoff, timeline: createTurnTimeline() };
}

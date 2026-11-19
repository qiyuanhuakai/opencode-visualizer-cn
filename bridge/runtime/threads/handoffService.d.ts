import type { SessionRef } from '../../../shared/runtime/identity.js';
import type { RuntimeHandoffPort } from '../../../app/composables/useRuntimeThread.js';
import type { CheckpointService } from './checkpointService.js';
import type { ThreadService } from './threadService.js';

/**
 * The Host Thread handoff service (task 34). Declared here because the module
 * ships no sibling declaration and a static import of a `.d.ts`-less module is
 * TS7016 under the repo's strict gate.
 *
 * `openTarget` and `sendPrompt` are the service's OWN declared native seams:
 * the container injects the real paths that open the target's native session
 * and deliver the prompt, so the ladder, the operation journal and
 * `projectHandoffState` all stay the product's real code.
 */
export interface HandoffServiceOptions {
  readonly threads: ThreadService;
  readonly checkpoints: CheckpointService;
  readonly openTarget: (input: {
    readonly threadId: string;
    readonly handoffId: string;
    readonly target: Readonly<{ participantId: string; session: SessionRef }>;
  }) => Promise<{ nativeSessionId: string }>;
  readonly sendPrompt: (input: {
    readonly threadId: string;
    readonly handoffId: string;
    readonly target: Readonly<{ participantId: string; session: SessionRef }>;
    readonly prompt: string;
    readonly promptFingerprint: string;
  }) => Promise<{ ackId?: string }>;
}

export function createHandoffService(options: HandoffServiceOptions): RuntimeHandoffPort;

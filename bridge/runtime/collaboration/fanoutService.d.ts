import type { SessionRef } from '../../../shared/runtime/identity.js';
import type { CollaborationFanoutPort } from '../../../app/composables/useRuntimeCollaboration.js';

/**
 * The partial fan-out service (task 38). Declared here because the module
 * ships no sibling declaration and a static import of a `.d.ts`-less module is
 * TS7016 under the repo's strict gate.
 *
 * `deliver` is the service's OWN declared native seam; an unreadable outcome
 * (a rejection without an ack) is what the service records as `ambiguous`, and
 * the UI renders each recipient's OBSERVED outcome.
 */
export interface FanoutServiceOptions {
  readonly deliver: (target: {
    readonly participantId: string;
    readonly session: SessionRef;
    readonly attachmentPath: string | null;
    readonly prompt: string;
  }) => Promise<{ ackId: string }>;
}

export function createFanoutService(options: FanoutServiceOptions): CollaborationFanoutPort;

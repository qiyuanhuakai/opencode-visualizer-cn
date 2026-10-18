import type { CollaborationDelegationPort } from '../../../app/composables/useRuntimeCollaboration.js';

/**
 * The Lead/Worker delegation service (task 39). Declared here because the
 * module ships no sibling declaration and a static import of a `.d.ts`-less
 * module is TS7016 under the repo's strict gate.
 */
export interface DelegationServiceOptions {
  readonly mailbox?: unknown;
  readonly deliver: (payload: unknown) => Promise<{ ackId: string }>;
}

export function createDelegationService(options: DelegationServiceOptions): CollaborationDelegationPort;

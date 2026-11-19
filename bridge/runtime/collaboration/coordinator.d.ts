import type { CollaborationCoordinatorPort } from '../../../app/composables/useRuntimeCollaboration.js';

/**
 * The Team task coordinator (task 37). Declared here because the module ships
 * no sibling declaration and a static import of a `.d.ts`-less module is
 * TS7016 under the repo's strict gate.
 *
 * `deliver` is the coordinator's OWN declared native seam: the container
 * injects the real path that delivers a dispatched attempt's prompt to its
 * owner's native session.
 */
export interface CollaborationCoordinatorOptions {
  readonly deliver?: (payload: unknown) => Promise<{ ackId: string }>;
}

export function createCollaborationCoordinator(options?: CollaborationCoordinatorOptions): CollaborationCoordinatorPort;

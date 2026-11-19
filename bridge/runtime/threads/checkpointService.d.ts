import type { ContextCheckpointView } from '../../../shared/runtime/context.js';

/**
 * The bounded context checkpoint store (task 33). Declared here because the
 * module ships no sibling declaration and a static import of a `.d.ts`-less
 * module is TS7016 under the repo's strict gate — the same reason
 * `useRuntimeThread.ts` declares its handoff read model locally.
 */
export interface CheckpointService {
  create(input: {
    readonly scope: Readonly<{ threadId: string; environmentId: string }>;
    readonly entries: readonly unknown[];
  }): ContextCheckpointView;
  get(checkpointId: string): ContextCheckpointView;
}

export function createCheckpointService(): CheckpointService;

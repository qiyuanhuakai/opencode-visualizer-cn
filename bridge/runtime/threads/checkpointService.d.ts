import type { ContextCheckpointView } from '../../../shared/runtime/context.js';

/** One canonical Checkpoint service: the id, the store, the frozen read models and the lifecycle. */
export interface CheckpointService {
  create(input: {
    readonly checkpointId?: string;
    readonly scope: unknown;
    readonly entries: unknown;
    readonly at?: number;
  }): ContextCheckpointView;
  /** Re-admit a checkpoint received over the wire; its digest and entry hashes are re-verified. */
  admit(value: string | Record<string, unknown>): ContextCheckpointView;
  get(checkpointId: string): ContextCheckpointView;
  checkpoints(): readonly ContextCheckpointView[];
  close(): void;
  readonly state: {
    readonly created: number;
    readonly bytes: number;
    readonly entries: number;
    readonly dropped: number;
    readonly closed: boolean;
  };
}

export function createCheckpointService(): CheckpointService;

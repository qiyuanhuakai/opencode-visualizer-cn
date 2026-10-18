import type { ContextCheckpointView, EvidenceTool, EvidenceToolResult } from '../../../shared/runtime/context.js';

/** The two injected ports an Evidence query reads through; both are re-verified per read. */
export interface EvidenceQueryPorts {
  readonly resolveTarget: (...args: readonly unknown[]) => unknown;
  readonly readEvidence: (input: {
    readonly target: unknown;
    readonly hash: string;
    readonly bytes: number;
  }) => string | Uint8Array;
}

/** One canonical Evidence query service: a read-only tool server over published checkpoints. */
export interface EvidenceQuery {
  /** Publish one checkpoint for querying; its digest and entry hashes are re-verified on arrival. */
  publish(value: string | Record<string, unknown>): ContextCheckpointView;
  listTools(): readonly EvidenceTool[];
  callTool(input: { readonly name: string; readonly arguments?: Record<string, unknown> }): EvidenceToolResult;
  close(): void;
  readonly state: {
    readonly published: number;
    readonly calls: number;
    readonly unauthorized: number;
    readonly stale: number;
    readonly unavailable: number;
    readonly closed: boolean;
  };
}

export function createEvidenceQuery(ports: EvidenceQueryPorts): EvidenceQuery;

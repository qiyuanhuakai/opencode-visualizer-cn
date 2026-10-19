import type { ContextCheckpointView, EvidenceReader, EvidenceTool, EvidenceToolResult, TargetResolver } from '../../../shared/runtime/context.js';

/** The two injected ports an Evidence query reads through; both are re-verified per read. The
 * service hands them to the shared dispatcher unchanged, so the ports ARE the shared reader and
 * target contracts: an object reader (`{ bytes, totalBytes }`) or null for a missing artifact,
 * never a raw string or byte array the runtime would reject. */
export interface EvidenceQueryPorts {
  readonly resolveTarget: TargetResolver;
  readonly readEvidence: EvidenceReader;
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

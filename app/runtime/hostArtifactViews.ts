import { ProtocolError } from '../../shared/runtime/capabilities.js';
import { hostArray, hostObject, hostString } from './hostCollaborationViews';

export interface ArtifactReviewView {
  readonly reviewId: string;
  readonly artifactHash: string;
  readonly repository: string;
  readonly target: string;
  readonly base: string;
  readonly state: string;
  readonly taskId: string;
}
export interface ArtifactTestSpec { readonly criterionId: string; readonly command: string; readonly args: readonly string[] }
export type ArtifactAction =
  | { readonly type: 'inspect'; readonly taskId: string; readonly artifactHash: string }
  | { readonly type: 'entries-page'; readonly offset: number }
  | { readonly type: 'read'; readonly taskId: string; readonly artifactHash: string; readonly path: string; readonly offset?: number }
  | { readonly type: 'prepare'; readonly taskId: string; readonly artifactHash: string; readonly repository: string; readonly target: string }
  | { readonly type: 'approve'; readonly reviewId: string }
  | { readonly type: 'integrate'; readonly approvalId: string; readonly tests: readonly ArtifactTestSpec[]; readonly commitMessage?: string };
export interface ArtifactEntryView { readonly path: string; readonly kind: string }
export interface ArtifactContentView {
  readonly path: string;
  readonly text: string | null;
  readonly binary: boolean;
  readonly offset: number;
  readonly nextOffset: number | null;
  readonly totalBytes: number;
}
export interface ArtifactIntegrationView {
  readonly operationId: string;
  readonly ok: boolean;
  readonly outcome: string;
  readonly rejection: string | null;
  readonly commit: string | null;
  readonly tests: readonly { readonly criterionId: string; readonly exitCode: number; readonly durationMs: number; readonly stdoutBytes: number; readonly stderrBytes: number }[];
}

export interface ArtifactWorkflowView {
  readonly artifactHash: string | null;
  readonly review: ArtifactReviewView | null;
  readonly approvalId: string | null;
  readonly integration: ArtifactIntegrationView | null;
  readonly entries: readonly ArtifactEntryView[];
  readonly content: ArtifactContentView | null;
  readonly entryPage: { readonly offset: number; readonly nextCursor: number | null; readonly total: number };
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new ProtocolError('invalid_request', 'artifact.result.number');
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new ProtocolError('invalid_request', 'artifact.result.boolean');
  return value;
}
function nullableString(value: unknown): string | null { return value === null ? null : hostString(value); }

export function artifactReview(value: unknown): ArtifactReviewView {
  const raw = hostObject(value);
  return {
    reviewId: hostString(raw.reviewId), artifactHash: hostString(raw.artifactHash), repository: hostString(raw.repository),
    target: hostString(raw.target), base: hostString(raw.base), state: hostString(raw.state), taskId: hostString(raw.taskId),
  };
}
export function artifactContent(value: unknown): ArtifactContentView {
  const raw = hostObject(value);
  return {
    path: hostString(raw.path), text: nullableString(raw.text), binary: boolean(raw.binary),
    offset: number(raw.offset), nextOffset: raw.nextOffset === null ? null : number(raw.nextOffset), totalBytes: number(raw.totalBytes),
  };
}
export function artifactIntegration(value: unknown): ArtifactIntegrationView {
  const raw = hostObject(value);
  return {
    operationId: hostString(raw.operationId), ok: boolean(raw.ok), outcome: hostString(raw.outcome),
    rejection: raw.rejection === null ? null : hostString(hostObject(raw.rejection).field),
    commit: nullableString(hostObject(raw.commit).sha),
    tests: hostArray(raw.tests).map((value) => {
      const test = hostObject(value);
      return {
        criterionId: hostString(test.criterionId), exitCode: number(test.exitCode), durationMs: number(test.durationMs),
        stdoutBytes: number(test.stdoutBytes), stderrBytes: number(test.stderrBytes),
      };
    }),
  };
}

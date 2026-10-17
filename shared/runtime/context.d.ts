import { ProtocolError } from './capabilities.js';
import type { ErrorCode } from './capabilities.js';

/** One schema version for the whole context fabric contract. */
export const CONTEXT_SCHEMA_VERSION: 1;
/** The fixed content classes a checkpoint may carry. */
export const CONTEXT_CLASSES: readonly ['goal', 'plan', 'decision', 'diff', 'test', 'artifact', 'unresolved'];
/** Admission priority: the goal survives the budget before an artifact caption does. */
export const CONTEXT_CLASS_PRIORITY: Readonly<Record<ContextClass, number>>;
/** Where a piece of evidence came from; the traceable half of origin+hash addressing. */
export const EVIDENCE_ORIGIN_KINDS: readonly ['host', 'native', 'file', 'diff'];

/** Serialized checkpoint ceiling: 32 KiB. */
export const CHECKPOINT_MAX_BYTES: 32768;
/** Estimated-token ceiling for one checkpoint: 8k tokens. */
export const CHECKPOINT_MAX_ESTIMATED_TOKENS: 8000;
/** Per-entry text ceiling; a single entry may still be refused by the checkpoint budget. */
export const MAX_ENTRY_CHARS: 65536;
/** Retained entry ceiling: the byte budget stops admitting long before this on text-heavy histories. */
export const MAX_CHECKPOINT_ENTRIES: 96;
/** Default and maximum byte page served per evidence read. */
export const EVIDENCE_PAGE_BYTES: 4096;
export const MAX_EVIDENCE_PAGE_BYTES: 65536;
/** Evidence ceiling: a diff or file above this is refused at the boundary, never read into a page. */
export const MAX_EVIDENCE_BYTES: 1048576;
/** The placeholder that replaces a secret; it can never contain the secret itself. */
export const REDACTED_PLACEHOLDER: '[redacted]';

export type ContextClass = (typeof CONTEXT_CLASSES)[number];
export type EvidenceOriginKind = (typeof EVIDENCE_ORIGIN_KINDS)[number];

/** The complete origin of one piece of evidence: a Host command, one native event, a file or a diff. */
export type EvidenceOrigin =
  | { readonly kind: 'host'; readonly commandId: string }
  | { readonly kind: 'native'; readonly harness: string; readonly nativeEventId: string }
  | { readonly kind: 'file'; readonly path: string }
  | { readonly kind: 'diff'; readonly repoKey: string; readonly path: string };

/** The target an evidence capture was taken against; a read is re-verified against the live one. */
export interface EvidenceTarget {
  readonly repoKey: string;
  readonly revision: string;
}

/** Scope a checkpoint is bound to; a cross-thread or cross-environment query is unauthorized. */
export interface ContextScope {
  readonly threadId: string;
  readonly environmentId: string;
}

/** Hash-addressed evidence reference: the checkpoint carries this, never the payload bytes. */
export interface EvidenceRef {
  readonly hash: string;
  readonly bytes: number;
  readonly target: EvidenceTarget;
}

/** One raw entry offered to a checkpoint build. */
export interface ContextEntryInput {
  readonly class: ContextClass;
  readonly origin: EvidenceOrigin;
  readonly text?: string | null;
  readonly evidence?: EvidenceRef | null;
}

/** Frozen per-entry envelope: redacted text, untrusted label, estimated tokens, origin and hash. */
export interface ContextEnvelopeView {
  readonly class: ContextClass;
  readonly origin: EvidenceOrigin;
  readonly text: string | null;
  readonly untrusted: boolean;
  readonly untrustedReason: string | null;
  readonly redactions: number;
  readonly estimatedTokens: number;
  readonly hash: string;
  readonly evidence: EvidenceRef | null;
}

/** One admitted checkpoint entry: an envelope plus its stable entryId. */
export interface ContextEntryView extends ContextEnvelopeView {
  readonly entryId: string;
}

/** Hash-addressed evidence record. The payload is never stored, only its hash and size. */
export interface EvidenceRecordView {
  readonly hash: string;
  readonly bytes: number;
  readonly origin: EvidenceOrigin;
  readonly target: EvidenceTarget;
  readonly at: number;
}

/** Frozen read model of one bounded checkpoint, with every observed number as a real value. */
export interface ContextCheckpointView {
  readonly checkpointId: string;
  readonly schemaVersion: 1;
  readonly scope: ContextScope;
  readonly createdAt: number;
  readonly entries: readonly ContextEntryView[];
  readonly evidence: readonly EvidenceRef[];
  readonly digest: string;
  readonly estimatedTokens: number;
  readonly entryCount: number;
  readonly droppedEntries: number;
  readonly droppedBytes: number;
  readonly demoted: number;
  readonly untrustedEntries: number;
  readonly redactions: number;
  readonly transcriptBytes: number;
  readonly bytes: number;
}

/** One byte page of evidence, or an explicit unavailable marker that never fabricates bytes. */
export type EvidencePageView =
  | { readonly available: false; readonly unavailableReason: string }
  | {
      readonly available: true;
      readonly hash: string;
      readonly offset: number;
      readonly length: number;
      readonly totalBytes: number;
      readonly bytes: Uint8Array;
      readonly nextOffset: number | null;
      readonly target: EvidenceTarget;
    };

/** Live evidence re-read from the current target by an injected reader. */
export interface LiveEvidence {
  readonly bytes: Uint8Array;
  readonly totalBytes: number;
}
/** The available variant of a byte page, for consumers that have already handled `available`. */
export type EvidencePage = Extract<EvidencePageView, { readonly available: true }>;
export type EvidenceReader = (request: {
  readonly target: EvidenceTarget;
  readonly hash: string;
  readonly bytes: number;
}) => LiveEvidence | null;
export type TargetResolver = () => EvidenceTarget;
export type CheckpointFinder = (checkpointId: string) => ContextCheckpointView | null;

export interface ReadEvidencePageInput {
  readonly ref: EvidenceRef;
  readonly currentTarget: EvidenceTarget;
  readonly readEvidence: EvidenceReader;
  readonly offset?: number;
  readonly length?: number;
}

export interface RegisterEvidenceInput {
  readonly bytes: string | Uint8Array;
  readonly origin: EvidenceOrigin;
  readonly target: EvidenceTarget;
  readonly at?: number;
}

export interface BuildCheckpointInput {
  readonly checkpointId: string;
  readonly scope: ContextScope;
  readonly entries: readonly ContextEntryInput[];
  readonly at?: number;
}

/** One prompt-injection shape; the table drives the labeling instead of a judgement call. */
export interface UntrustedPattern {
  readonly reason: string;
  readonly pattern: RegExp;
}

/** MCP-compatible read-only tool descriptor. Every tool is a read; there is no write tool. */
export interface EvidenceTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly readOnly: true;
}
export const EVIDENCE_TOOLS: readonly EvidenceTool[];
export const UNTRUSTED_PATTERNS: readonly UntrustedPattern[];

export interface EvidenceListResult {
  readonly checkpointId: string;
  readonly evidence: readonly EvidenceRef[];
}
export type EvidenceToolResult = ContextCheckpointView | EvidenceListResult | EvidencePageView;

export interface CallEvidenceToolInput {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly findCheckpoint: CheckpointFinder;
  readonly resolveTarget?: TargetResolver;
  readonly readEvidence?: EvidenceReader;
}

/** Every rejection carries an explicit protocol code plus the plain rejection field. */
export class ContextError extends ProtocolError {
  readonly reason: string;
  constructor(code: ErrorCode, reason: string);
}

export function parseContextClass(value: unknown): ContextClass;
export function parseEvidenceOrigin(value: unknown): EvidenceOrigin;
export function parseEvidenceHash(value: unknown): string;
export function parseTarget(value: unknown): EvidenceTarget;
export function parseScope(value: unknown): ContextScope;
export function parseEvidenceRef(value: unknown): EvidenceRef;

export function estimateTokens(text: string): number;
export function evidenceHash(input: string | Uint8Array): string;

export function redactSecrets(text: string): { readonly text: string; readonly redactions: number };
export function carryAsData(text: string): {
  readonly text: string;
  readonly untrusted: boolean;
  readonly untrustedReason: string | null;
};

export function wrapContextEntry(input: ContextEntryInput): ContextEnvelopeView;
export function registerEvidence(input: RegisterEvidenceInput): EvidenceRecordView;
export function orderContextEntries(entries: readonly ContextEntryInput[]): readonly ContextEntryInput[];

export function buildContextCheckpoint(input: BuildCheckpointInput): ContextCheckpointView;
export function serializeCheckpoint(view: ContextCheckpointView): string;
export function parseCheckpoint(value: unknown): ContextCheckpointView;
export function deserializeCheckpoint(text: string): ContextCheckpointView;

export function authorizeScope(queryScope: unknown, checkpointScope: unknown): void;
export function verifyCurrentTarget(recordedTarget: unknown, currentTarget: unknown): void;
export function readEvidencePage(input: ReadEvidencePageInput): EvidencePageView;

export function describeEvidenceTool(name: string): EvidenceTool;
export function callEvidenceTool(input: CallEvidenceToolInput): EvidenceToolResult;

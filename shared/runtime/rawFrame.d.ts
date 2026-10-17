import type { ErrorCode } from './capabilities.js';

/** Readonly representation metrics for one span (the `result` or `typedError` value). */
export type RawFrameSpan = Readonly<{
  /** UTF-8 byte length of the raw span text (includes structural chars, quotes, escapes and whitespace). */
  readonly utf8Bytes: number;
  /** Count of JSON value nodes in the span (arrays/objects/strings/numbers/booleans/null). */
  readonly nodes: number;
  /** Maximum nesting depth relative to the span value itself (span value is depth 0). */
  readonly depth: number;
  /** Sum of decoded string-value lengths (UTF-16 code units). */
  readonly stringUnits: number;
  /** Sum of decoded object-key lengths (UTF-16 code units). */
  readonly keyUnits: number;
}>;

/**
 * Readonly envelope primitives plus span metrics produced by `scanRawFrame`.
 * Never contains arbitrary keys or token lists: only schema-known bounded fields.
 */
export type RawFrameSummary = Readonly<{
  readonly kind: string | undefined;
  readonly version: number | undefined;
  readonly id: string | undefined;
  readonly target: string | undefined;
  readonly epoch: string | undefined;
  readonly generation: number | undefined;
  readonly ok: boolean | undefined;
  readonly phase: string | undefined;
  /** A decoded top-level envelope key (including an escaped equivalent) appeared more than once. */
  readonly duplicateKeys: boolean;
  /** A top-level key outside the known envelope schema was present. */
  readonly unknownFields: boolean;
  readonly result: RawFrameSpan;
  readonly typedError: RawFrameSpan;
}>;

/**
 * Pre-decode classifier decision.
 * - `'accept'`: proceed to `JSON.parse`/validation with the existing semantics.
 * - `'drop'`: silently discard this well-formed but unmatched/stale result frame.
 * Throwing a `ProtocolError` rejects the frame with a typed connection failure.
 */
export type FramePreflightDecision = 'accept' | 'drop';
export type RawFramePreflight = (summary: RawFrameSummary) => FramePreflightDecision;

/** Bounded lexical scan of a raw wire frame; throws `ProtocolError` on invalid syntax/envelope. */
export function scanRawFrame(text: string): RawFrameSummary;

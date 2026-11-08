import type { SessionRef } from '../../../shared/runtime/identity.js';
import type { AppServerClient } from '../../../shared/runtime/native/codex/appServerClient.js';
import type { CanonicalEntry } from '../../../shared/runtime/native/codex/normalize.js';
import type { JsonValue } from '../../../shared/runtime/capabilities.js';
export interface CodexHistoryPage {
  readonly items: readonly {
    readonly turnId: string;
    readonly native: JsonValue;
    readonly canonical: readonly CanonicalEntry[];
    readonly startedAtMs: number | null;
    readonly completedAtMs: number | null;
  }[];
  readonly cursor: string | null;
  readonly completeness: 'partial' | 'complete' | 'unsupported';
  readonly reason?: string;
  readonly chunk?: {
    readonly format: 'json-utf8-base64';
    readonly data: string;
    readonly offset: number;
    readonly totalBytes: number;
    readonly digest: string;
  };
}
export function createCodexHistory(options: {
  readonly request: AppServerClient['request'];
  readonly processGeneration: number;
  readonly epoch: string;
  readonly assertCurrent: () => void;
}): (input: {
  readonly session: SessionRef;
  readonly cursor?: string | null;
  readonly limit?: number;
}) => Promise<CodexHistoryPage>;

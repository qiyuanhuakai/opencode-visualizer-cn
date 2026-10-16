import type { AppServerClient } from './appServerClient.js';
import type { JsonValue } from '../../capabilities.js';
import type { CodexSummary } from './catalog.js';
export const SOURCE_KINDS: readonly string[];
export function createCodexDiscovery(options: {
  readonly request: AppServerClient['request'];
  readonly summary: (thread: JsonValue, archived: boolean) => Promise<CodexSummary | null>;
  readonly generation: number;
  readonly revision?: () => number;
}): (params?: { readonly cursor?: string | null; readonly limit?: number }) => Promise<{
  readonly items: readonly CodexSummary[];
  readonly cursor: string | null;
  readonly completeness: 'complete' | 'partial' | 'unsupported';
  readonly reason?: string;
}>;
